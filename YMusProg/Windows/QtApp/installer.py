from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
import zipfile
import ctypes
from ctypes import wintypes
from pathlib import Path

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtGui import QIcon
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QProgressBar,
    QPushButton,
    QVBoxLayout,
    QWidget,
)


APP_NAME = "YMus"


class InstallerWindow(QWidget):
    progressChanged = Signal(int, str)
    finishedChanged = Signal(bool, str)

    def __init__(self) -> None:
        super().__init__()
        self.setObjectName("installerRoot")
        self.setWindowTitle("Установка YMus")
        self.setFixedSize(720, 500)
        self.setWindowIcon(QIcon(str(resource_path("assets/app/ymus.ico"))))
        self._pulse = 0
        check_icon = resource_path("assets/icons/check.svg").as_posix()

        self.setStyleSheet(
            """
            QWidget#installerRoot {
                background: #050505;
                color: #f5f2e9;
                font-family: Kanit, Segoe UI, Arial;
                font-size: 14px;
            }
            QLabel, QCheckBox {
                background: transparent;
            }
            QLabel#eyebrow {
                color: #ffd400;
                font-size: 12px;
                font-weight: 800;
                letter-spacing: 0px;
            }
            QLabel#title {
                color: #fffbea;
                font-size: 42px;
                font-weight: 900;
            }
            QLabel#subtitle, QLabel#path {
                color: #b6b0a0;
                font-size: 13px;
            }
            QFrame#panel {
                background: rgba(18, 18, 18, 185);
                border: 1px solid rgba(255, 212, 0, 90);
                border-radius: 18px;
            }
            QPushButton {
                background: #ffd400;
                color: #050505;
                border: 1px solid #ffe76b;
                border-radius: 12px;
                min-height: 42px;
                padding: 0 24px;
                font-weight: 900;
            }
            QPushButton:hover {
                background: #ffe45c;
            }
            QPushButton:disabled {
                background: #4b4320;
                color: #99927a;
                border-color: #5a5125;
            }
            QCheckBox {
                color: #dfd8c6;
                spacing: 10px;
                background: transparent;
            }
            QCheckBox::indicator {
                width: 18px;
                height: 18px;
                border-radius: 5px;
                border: 1px solid #706400;
                background: #111111;
            }
            QCheckBox::indicator:checked {
                background: #ffd400;
                border-color: #ffd400;
                image: url(__CHECK_ICON__);
            }
            QProgressBar {
                min-height: 12px;
                max-height: 12px;
                border-radius: 6px;
                background: #171717;
                border: 1px solid #3a351c;
                text-align: center;
                color: transparent;
            }
            QProgressBar::chunk {
                border-radius: 5px;
                background: #ffd400;
            }
            """.replace("__CHECK_ICON__", check_icon)
        )

        self.root = QVBoxLayout(self)
        self.root.setContentsMargins(34, 28, 34, 28)
        self.root.setSpacing(16)

        top = QHBoxLayout()
        logo = QLabel()
        logo.setPixmap(QIcon(str(resource_path("assets/app/Icon128x128.png"))).pixmap(54, 54))
        top.addWidget(logo)

        title_box = QVBoxLayout()
        title_box.setSpacing(0)
        brand = QLabel("YMus")
        brand.setObjectName("title")
        brand.setMinimumHeight(54)
        desc = QLabel("Установщик менеджера расширения")
        desc.setObjectName("subtitle")
        title_box.addWidget(brand)
        title_box.addWidget(desc)
        top.addLayout(title_box)
        top.addStretch()
        self.root.addLayout(top)

        panel = QFrame()
        panel.setObjectName("panel")
        panel_layout = QVBoxLayout(panel)
        panel_layout.setContentsMargins(24, 20, 24, 20)
        panel_layout.setSpacing(12)

        eyebrow = QLabel("БЫСТРАЯ УСТАНОВКА")
        eyebrow.setObjectName("eyebrow")
        panel_layout.addWidget(eyebrow)

        headline = QLabel("Один файл. Готовая программа.")
        headline.setStyleSheet("font-size: 25px; font-weight: 900; color: #fffbea;")
        headline.setMinimumHeight(34)
        panel_layout.addWidget(headline)

        text = QLabel("YMus будет установлен в локальную папку пользователя. Расширение и все нужные файлы уже внутри установщика.")
        text.setObjectName("subtitle")
        text.setWordWrap(True)
        panel_layout.addWidget(text)

        self.path_label = QLabel(str(install_dir()))
        self.path_label.setObjectName("path")
        self.path_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        panel_layout.addWidget(self.path_label)

        self.desktop_shortcut = QCheckBox("Создать ярлык на рабочем столе")
        self.desktop_shortcut.setChecked(True)
        self.start_menu_shortcut = QCheckBox("Добавить ярлык в меню Пуск")
        self.start_menu_shortcut.setChecked(True)
        panel_layout.addWidget(self.desktop_shortcut)
        panel_layout.addWidget(self.start_menu_shortcut)

        self.progress = QProgressBar()
        self.progress.setValue(0)
        panel_layout.addWidget(self.progress)

        self.status = QLabel("Готово к установке")
        self.status.setObjectName("subtitle")
        panel_layout.addWidget(self.status)

        buttons = QHBoxLayout()
        buttons.addStretch()
        self.install_button = QPushButton("Установить YMus")
        self.install_button.setMinimumWidth(170)
        self.install_button.clicked.connect(self.start_install)
        self.launch_button = QPushButton("Запустить")
        self.launch_button.setMinimumWidth(120)
        self.launch_button.setEnabled(False)
        self.launch_button.clicked.connect(self.launch_app)
        buttons.addWidget(self.install_button)
        buttons.addWidget(self.launch_button)
        panel_layout.addLayout(buttons)

        self.root.addWidget(panel)

        self.progressChanged.connect(self.on_progress)
        self.finishedChanged.connect(self.on_finished)

        self.pulse_timer = QTimer(self)
        self.pulse_timer.timeout.connect(self.repaint)
        self.pulse_timer.start(35)

    def paintEvent(self, event):  # noqa: N802
        self._pulse += 0.028
        super().paintEvent(event)

    def start_install(self) -> None:
        self.install_button.setEnabled(False)
        self.launch_button.setEnabled(False)
        threading.Thread(target=self.install, daemon=True).start()

    def install(self) -> None:
        target = install_dir()
        payload = resource_path("payload.zip")
        try:
            self.progressChanged.emit(8, "Подготавливаем папку установки")
            if target.exists():
                shutil.rmtree(target)
            target.mkdir(parents=True, exist_ok=True)

            self.progressChanged.emit(20, "Распаковываем файлы YMus")
            with zipfile.ZipFile(payload, "r") as archive:
                members = archive.infolist()
                for index, member in enumerate(members):
                    archive.extract(member, target)
                    if index % 35 == 0:
                        percent = 20 + int((index / max(1, len(members))) * 55)
                        self.progressChanged.emit(percent, "Распаковываем файлы YMus")

            exe = target / "YMus.exe"
            self.progressChanged.emit(82, "Создаем ярлыки")
            if self.desktop_shortcut.isChecked():
                create_shortcut(desktop_dir() / "YMus.lnk", exe, target)
            if self.start_menu_shortcut.isChecked():
                start_dir = start_menu_dir()
                start_dir.mkdir(parents=True, exist_ok=True)
                create_shortcut(start_dir / "YMus.lnk", exe, target)

            self.progressChanged.emit(100, "YMus установлен")
            self.finishedChanged.emit(True, str(exe))
        except Exception as error:
            self.finishedChanged.emit(False, str(error))

    def on_progress(self, value: int, message: str) -> None:
        self.progress.setValue(value)
        self.status.setText(message)

    def on_finished(self, ok: bool, message: str) -> None:
        if ok:
            self.status.setText("Установка завершена")
            self.launch_button.setEnabled(True)
        else:
            self.status.setText(f"Ошибка установки: {message}")
            self.install_button.setEnabled(True)

    def launch_app(self) -> None:
        exe = install_dir() / "YMus.exe"
        if exe.exists():
            subprocess.Popen([str(exe)], cwd=str(install_dir()), close_fds=True)
            QApplication.quit()


def resource_path(relative: str) -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return base / relative


def install_dir() -> Path:
    return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / APP_NAME / "App"


def desktop_dir() -> Path:
    known = get_known_folder("{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}")
    if known is not None:
        return known
    return Path(os.environ.get("USERPROFILE", str(Path.home()))) / "Desktop"


def start_menu_dir() -> Path:
    return Path(os.environ.get("APPDATA", str(Path.home()))) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / APP_NAME


def get_known_folder(folder_id: str) -> Path | None:
    if sys.platform != "win32":
        return None
    try:
        class GUID(ctypes.Structure):
            _fields_ = [
                ("Data1", wintypes.DWORD),
                ("Data2", wintypes.WORD),
                ("Data3", wintypes.WORD),
                ("Data4", ctypes.c_ubyte * 8),
            ]

            def __init__(self, value: str) -> None:
                import uuid

                guid = uuid.UUID(value.strip("{}"))
                data = guid.bytes_le
                super().__init__(
                    int.from_bytes(data[0:4], "little"),
                    int.from_bytes(data[4:6], "little"),
                    int.from_bytes(data[6:8], "little"),
                    (ctypes.c_ubyte * 8).from_buffer_copy(data[8:16]),
                )

        path_ptr = wintypes.LPWSTR()
        result = ctypes.windll.shell32.SHGetKnownFolderPath(
            ctypes.byref(GUID(folder_id)),
            0,
            None,
            ctypes.byref(path_ptr),
        )
        if result != 0 or not path_ptr.value:
            return None
        value = path_ptr.value
        ctypes.windll.ole32.CoTaskMemFree(path_ptr)
        return Path(value)
    except Exception:
        return None


def ps_quote(value: Path | str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def create_shortcut(shortcut: Path, target: Path, working_dir: Path) -> None:
    shortcut.parent.mkdir(parents=True, exist_ok=True)
    powershell = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    shell = str(powershell if powershell.exists() else "powershell")
    command = (
        "$ws = New-Object -ComObject WScript.Shell; "
        f"$s = $ws.CreateShortcut({ps_quote(shortcut)}); "
        f"$s.TargetPath = {ps_quote(target)}; "
        f"$s.WorkingDirectory = {ps_quote(working_dir)}; "
        f"$s.IconLocation = {ps_quote(str(target) + ',0')}; "
        "$s.Save()"
    )
    subprocess.run(
        [shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
        check=False,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("YMus Setup")
    window = InstallerWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())

