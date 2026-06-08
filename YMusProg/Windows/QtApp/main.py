from __future__ import annotations

import sys
from pathlib import Path
import ctypes

from PySide6.QtCore import QUrl, QTimer
from PySide6.QtGui import QIcon, QPixmap
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtWidgets import QApplication, QMenu, QSplashScreen, QSystemTrayIcon

from backend import Backend
import guard


# Уникальный ключ single-instance. Если копия YMus уже запущена, новый запуск
# не создаёт второе окно/иконку в трее — он лишь просит уже работающую копию
# показать своё окно и тут же завершается.
SINGLE_INSTANCE_KEY = "YMus-single-instance-v1"


def enable_windows_frame_behaviour(window) -> None:
    if sys.platform != "win32":
        return

    hwnd = int(window.winId())
    user32 = ctypes.windll.user32
    GWL_STYLE = -16
    WS_SYSMENU = 0x00080000
    WS_THICKFRAME = 0x00040000
    WS_MINIMIZEBOX = 0x00020000
    WS_MAXIMIZEBOX = 0x00010000
    SWP_NOMOVE = 0x0002
    SWP_NOSIZE = 0x0001
    SWP_NOZORDER = 0x0004
    SWP_FRAMECHANGED = 0x0020

    style = user32.GetWindowLongW(hwnd, GWL_STYLE)
    style |= WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX
    user32.SetWindowLongW(hwnd, GWL_STYLE, style)
    user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED)


def is_another_instance_running() -> bool:
    """True, если уже есть работающая копия (ей послан сигнал «показать окно»)."""
    socket = QLocalSocket()
    socket.connectToServer(SINGLE_INSTANCE_KEY)
    if socket.waitForConnected(200):
        socket.write(b"show")
        socket.flush()
        socket.waitForBytesWritten(300)
        socket.disconnectFromServer()
        return True
    return False


def main() -> int:
    # Анти-дебаг: если присоединён отладчик — не запускаемся.
    if guard.debugger_detected():
        return 0
    QQuickStyle.setStyle("Basic")
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    # Во frozen-сборке (PyInstaller) ресурсы лежат в _MEIPASS; в dev — рядом
    # с этим файлом. Используем тот же приём, что и установщик, иначе QML и
    # ассеты (иконки) могут не находиться.
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    app.setApplicationName("YMus")
    app.setOrganizationName("YMus")
    app.setWindowIcon(QIcon(str(root / "assets" / "app" / "ymus.ico")))

    # ─── Single instance ────────────────────────────────────────────────────
    if is_another_instance_running():
        return 0
    # Чистим возможный «протухший» сокет от прошлого аварийного завершения и
    # начинаем слушать как основная копия.
    QLocalServer.removeServer(SINGLE_INSTANCE_KEY)
    single_server = QLocalServer()
    single_server.listen(SINGLE_INSTANCE_KEY)

    # ─── Мгновенный сплэш, пока компилируется QML ───────────────────────────
    splash_pix = QPixmap(str(root / "assets" / "app" / "Icon128x128.png"))
    splash = QSplashScreen(splash_pix)
    splash.show()
    app.processEvents()

    backend = Backend()
    engine = QQmlApplicationEngine()
    engine.rootContext().setContextProperty("backend", backend)
    # Абсолютный путь к ассетам (file:///…). Относительные "../assets/…" в
    # QML ненадёжны во frozen-сборке, поэтому иконки берём по абсолютному URL.
    engine.rootContext().setContextProperty(
        "assetsDir", QUrl.fromLocalFile(str(root / "assets")).toString()
    )
    engine.load(QUrl.fromLocalFile(str(root / "qml" / "Main.qml")))

    if not engine.rootObjects():
        return 1
    window = engine.rootObjects()[0]
    enable_windows_frame_behaviour(window)
    splash.close()

    # Активация из второй копии → показать окно текущей.
    def on_second_instance() -> None:
        conn = single_server.nextPendingConnection()
        if conn is not None:
            conn.readAll()
        show_window(window)

    single_server.newConnection.connect(on_second_instance)

    # Закрытие окна (в т.ч. Alt+F4) уважает настройку «сворачивать в трей».
    def on_closing(close_event) -> None:
        if backend._settings.get("minimizeToTray", True):
            try:
                close_event.accepted = False
            except Exception:
                pass
            window.hide()
        else:
            app.quit()

    try:
        window.closing.connect(on_closing)
    except Exception:
        pass

    app.tray_icon = create_tray_icon(app, window, root)
    app._single_server = single_server  # удержать ссылку от GC
    # Фоновый анти-дебаг (выход при присоединении отладчика на лету).
    guard.start_protection(guard.terminate)
    return app.exec()


def create_tray_icon(app: QApplication, window, root: Path) -> QSystemTrayIcon:
    icon = QIcon(str(root / "assets" / "app" / "ymus.ico"))
    tray = QSystemTrayIcon(icon, app)
    tray.setToolTip("YMus")

    menu = QMenu()
    show_action = menu.addAction("Открыть YMus")
    quit_action = menu.addAction("Выйти")
    show_action.triggered.connect(lambda: show_window(window))
    quit_action.triggered.connect(app.quit)
    tray.setContextMenu(menu)
    tray.activated.connect(
        lambda reason: show_window(window)
        if reason in (QSystemTrayIcon.Trigger, QSystemTrayIcon.DoubleClick)
        else None
    )
    tray.show()
    return tray


def show_window(window) -> None:
    window.showNormal()
    window.raise_()
    window.requestActivate()


if __name__ == "__main__":
    raise SystemExit(main())
