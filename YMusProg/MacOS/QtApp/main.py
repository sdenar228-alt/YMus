"""Точка входа YMus для macOS.

Портирована с Windows main.py. Отличия:
  - убран Windows-only код рамки окна (frameless QML работает на macOS как есть);
  - ресурсы (qml/assets) ищутся либо в бандле (.app), либо — в dev-режиме —
    в общей папке Windows/QtApp (чтобы не дублировать QML и иконки в репозитории);
  - single-instance, трей, сплэш — на кроссплатформенном Qt, без изменений.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtCore import QUrl
from PySide6.QtGui import QIcon, QPixmap
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtWidgets import QApplication, QMenu, QSplashScreen, QSystemTrayIcon

from backend import Backend
import guard


SINGLE_INSTANCE_KEY = "YMus-single-instance-mac-v1"


def resource_root() -> tuple[Path, Path]:
    """Возвращает (qml_dir, assets_dir).

    Во frozen .app ресурсы лежат рядом с исполняемым (_MEIPASS / папка модуля).
    В dev-режиме на Mac QML и ассеты берутся из общей Windows/QtApp."""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    qml = base / "qml"
    assets = base / "assets"
    if qml.exists() and assets.exists():
        return qml, assets
    # dev-фолбэк: общие ресурсы в Windows/QtApp
    shared = Path(__file__).resolve().parents[2] / "Windows" / "QtApp"
    return shared / "qml", shared / "assets"


def is_another_instance_running() -> bool:
    socket = QLocalSocket()
    socket.connectToServer(SINGLE_INSTANCE_KEY)
    if socket.waitForConnected(200):
        socket.write(b"show")
        socket.flush()
        socket.waitForBytesWritten(300)
        socket.disconnectFromServer()
        return True
    return False


def app_icon(assets_dir: Path) -> QIcon:
    # На macOS используем PNG (ico не нужен).
    for name in ("app/Icon128x128.png", "app/Icon48x48.png"):
        candidate = assets_dir / name
        if candidate.exists():
            return QIcon(str(candidate))
    return QIcon()


def main() -> int:
    if guard.debugger_detected():
        return 0

    QQuickStyle.setStyle("Basic")
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    app.setApplicationName("YMus")
    app.setOrganizationName("YMus")

    qml_dir, assets_dir = resource_root()
    app.setWindowIcon(app_icon(assets_dir))

    if is_another_instance_running():
        return 0
    QLocalServer.removeServer(SINGLE_INSTANCE_KEY)
    single_server = QLocalServer()
    single_server.listen(SINGLE_INSTANCE_KEY)

    splash_path = assets_dir / "app" / "Icon128x128.png"
    splash = QSplashScreen(QPixmap(str(splash_path)))
    splash.show()
    app.processEvents()

    backend = Backend()
    engine = QQmlApplicationEngine()
    engine.rootContext().setContextProperty("backend", backend)
    engine.rootContext().setContextProperty(
        "assetsDir", QUrl.fromLocalFile(str(assets_dir)).toString()
    )
    engine.load(QUrl.fromLocalFile(str(qml_dir / "Main.qml")))

    if not engine.rootObjects():
        return 1
    window = engine.rootObjects()[0]
    splash.close()

    def on_second_instance() -> None:
        conn = single_server.nextPendingConnection()
        if conn is not None:
            conn.readAll()
        show_window(window)

    single_server.newConnection.connect(on_second_instance)

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

    app.tray_icon = create_tray_icon(app, window, assets_dir)
    app._single_server = single_server
    guard.start_protection(guard.terminate)
    return app.exec()


def create_tray_icon(app: QApplication, window, assets_dir: Path) -> QSystemTrayIcon:
    tray = QSystemTrayIcon(app_icon(assets_dir), app)
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
