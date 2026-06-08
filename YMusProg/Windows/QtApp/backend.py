from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import ctypes
import base64
import hashlib
import zipfile
import urllib.request
import uuid
from ctypes import wintypes
from dataclasses import dataclass, field
from pathlib import Path

from PySide6.QtCore import QObject, Property, Signal, Slot, QTimer


EXTENSION_VERSION = "1.1.2"
APP_NAME = "YMus"

# Базовый адрес сервера хранится в обфусцированном виде (XOR + base64), чтобы
# его нельзя было вытащить из бинарника простым `strings`. Важно понимать: это
# НЕ криптозащита. Домен всё равно публичен через DNS (nslookup ymus.tech), а
# код клиента можно разобрать. Обфускация лишь поднимает порог для ленивого
# реверс-инжиниринга. Настоящая защита от DDoS — Cloudflare/реверс-прокси с
# rate-limit на стороне сервера (см. рекомендацию в ответе).
_SRV_K = "ym-aurora-shield-key"
_SRV_B = "ERlZEQZIQF0YQAYbRxEJB0U="


def _server_base() -> str:
    raw = base64.b64decode(_SRV_B)
    key = _SRV_K.encode("utf-8")
    return bytes(b ^ key[i % len(key)] for i, b in enumerate(raw)).decode("utf-8")


def _api_url(path: str) -> str:
    return _server_base().rstrip("/") + path


def _base_dir() -> Path:
    """Каталог с ресурсами: _MEIPASS во frozen-сборке, иначе папка скрипта."""
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


DEFAULT_SETTINGS = {
    "autoUpdate": True,
    "checkOnStart": True,
    "runAtStartup": False,
    "minimizeToTray": True,
    "notifications": True,
    "theme": "Темная",
    "language": "Русский",
    "clientId": "",
}


@dataclass
class BrowserDefinition:
    id: str
    name: str
    engine: str
    extensions_url: str
    candidates: list[Path]
    profile_roots: list[Path] = field(default_factory=list)


class Backend(QObject):
    browsersChanged = Signal()
    logsChanged = Signal()
    statusChanged = Signal()
    preparedPathChanged = Signal()
    busyChanged = Signal()
    settingsChanged = Signal()
    ready = Signal()
    updateInfoChanged = Signal()

    def __init__(self) -> None:
        super().__init__()
        self._busy = False
        self._status = "Все работает стабильно"
        self._prepared_path = ""
        self._settings = load_settings()
        self._browsers: list[dict] = []
        self._logs: list[dict] = []
        self._ext_update_available = False
        self._ext_latest = ""
        self._ext_update_type = "simple"
        self.add_log("ИНФО", "YMus Qt запущен")
        _device_id = machine_hwid()
        if _device_id:
            self.add_log("ИНФО", f"ID устройства: {_device_id}")
        threading.Thread(target=send_telemetry_ping, daemon=True).start()
        # Сканирование браузеров отложено на старт event loop — окно появляется
        # мгновенно (через сплэш), а тяжёлая работа выполняется после показа.
        QTimer.singleShot(0, self._initial_load)

    def _initial_load(self) -> None:
        try:
            self._refresh_browsers()
        finally:
            # Сигнал готовности гасит сплэш в QML (см. Main.qml).
            self.ready.emit()
        # Фоновая проверка обновления расширения (детект, без применения).
        threading.Thread(target=self._check_extension_update, daemon=True).start()

    def _check_extension_update(self) -> None:
        """Проверяет наличие новой версии расширения на сервере и, если оно
        где-то установлено, выставляет флаг «доступно обновление» (без
        применения — применяет пользователь кнопкой)."""
        installed = installed_extension_version()
        release = fetch_extension_release()
        if release is None:
            return
        latest = release.get("version")
        if not isinstance(latest, str) or not latest:
            return
        update_type = str(release.get("updateType") or "simple").lower()
        self._ext_latest = latest
        self._ext_update_type = update_type
        # Предлагаем обновление, если локально установленная версия старее.
        # Детект «в каком браузере стоит» используется только для нацеливания
        # обновления (он ненадёжен для части браузеров вроде Opera), поэтому в
        # условие доступности его НЕ закладываем.
        newer = installed is not None and is_newer_version(latest, installed)
        self._ext_update_available = bool(newer)
        self.updateInfoChanged.emit()
        if self._ext_update_available:
            kind = "полное" if update_type == "full" else "простое"
            self._set_status(
                f"Доступно обновление расширения {latest}",
                "ИНФО",
                f"Доступно {kind} обновление расширения до {latest}. Нажмите «Обновить расширение».",
            )

    def _update_extension(self) -> None:
        """Применяет обновление расширения в браузерах, где оно установлено,
        в зависимости от типа (простой/полный)."""
        targets = [b for b in self._browsers if b.get("extInstalled") and b.get("canSelect")]
        if not targets:
            targets = [b for b in self._browsers if b.get("selected") and b.get("canSelect")]
        if not targets:
            raise RuntimeError("Нет браузеров с установленным расширением.")

        release = fetch_extension_release()
        update_type = str((release or {}).get("updateType") or self._ext_update_type or "simple").lower()

        # 1. Скачиваем новую версию и заменяем содержимое папки current.
        try:
            prepared = download_extension_to_current()
        except Exception as error:
            raise RuntimeError(f"Не удалось скачать обновление: {error}")
        self._prepared_path = str(prepared)
        self.preparedPathChanged.emit()
        set_clipboard_text(str(prepared))

        # 2. Применяем по каждому браузеру.
        for index, browser in enumerate(targets):
            if update_type == "full":
                # Полное: заново загрузить распакованное расширение из новой папки.
                self.open_browser_extensions(browser, prepared)
                self.add_log("ГОТОВО", f"Полное обновление: {browser['name']}")
            else:
                # Простое: открыть страницу расширений и нажать «Обновить».
                self.reload_browser_extension(browser)
                self.add_log("ГОТОВО", f"Простое обновление: {browser['name']}")
            if index < len(targets) - 1:
                time.sleep(0.6)

        self._ext_update_available = False
        self.updateInfoChanged.emit()
        self._refresh_browsers()
        self._set_status(
            "Расширение обновлено",
            "ГОТОВО",
            f"Расширение обновлено до {self._ext_latest}".strip(),
        )

    def reload_browser_extension(self, browser: dict) -> None:
        """Простое обновление: открыть страницу расширений и нажать «Обновить»
        (содержимое папки current уже заменено новой версией)."""
        path = browser["path"]
        url = browser["extensionsUrl"]
        exe_name = Path(path).name
        already_running = find_browser_window(exe_name) is not None
        if browser.get("engine") == "Chromium":
            enable_developer_mode_preferences(browser.get("profileRoots", []))
        if already_running:
            focus_browser_window(exe_name)
            time.sleep(0.35)
        else:
            subprocess.Popen([path, "--force-renderer-accessibility", "--enable-renderer-accessibility"], close_fds=True)
            time.sleep(1.1)
        focus_browser_window(exe_name)
        force_address_bar_url(url, open_new_tab=already_running)
        time.sleep(1.0)
        enable_developer_mode_via_uia(exe_name)
        time.sleep(0.4)
        if not click_reload_extensions_button_via_uia(exe_name):
            self.add_log(
                "ИНФО",
                f"Кнопка «Обновить» не найдена — расширение применится после перезапуска: {browser['name']}",
            )

    @Property(bool, notify=busyChanged)
    def busy(self) -> bool:
        return self._busy

    @Property(str, notify=statusChanged)
    def status(self) -> str:
        return self._status

    @Property(str, constant=True)
    def versionLabel(self) -> str:
        return f"v{EXTENSION_VERSION}"

    @Property(bool, notify=updateInfoChanged)
    def extUpdateAvailable(self) -> bool:
        return self._ext_update_available

    @Property(str, notify=updateInfoChanged)
    def extLatestVersion(self) -> str:
        return self._ext_latest

    @Property(bool, constant=True)
    def accessibilityNeeded(self) -> bool:
        # На Windows системное разрешение не нужно — плашка не показывается.
        return False

    @Slot()
    def open_accessibility_settings(self) -> None:
        # На Windows не используется (плашка скрыта). Оставлено для совместимости
        # с общим QML, где кнопка есть только на macOS.
        pass

    @Property(str, notify=preparedPathChanged)
    def preparedPath(self) -> str:
        return self._prepared_path or r"C:\Users\...\AppData\Local\YMus\extensions\chromium\current"

    @Property("QVariantList", notify=browsersChanged)
    def browsers(self) -> list[dict]:
        return self._browsers

    @Property("QVariantList", notify=logsChanged)
    def logs(self) -> list[dict]:
        return self._logs

    @Property("QVariantMap", notify=settingsChanged)
    def settings(self) -> dict:
        return dict(self._settings)

    @Property(int, notify=browsersChanged)
    def connectedCount(self) -> int:
        return sum(1 for browser in self._browsers if browser.get("selected") and browser.get("canSelect"))

    @Slot()
    def refresh_browsers(self) -> None:
        self.run("Обновляем список браузеров", self._refresh_browsers)

    @Slot()
    def install_extension(self) -> None:
        self.run_async("Открываем управление браузерами", self._install_extension)

    @Slot()
    def update_extension(self) -> None:
        self.run_async("Обновляем расширение", self._update_extension)

    @Slot()
    def check_updates(self) -> None:
        self.run_async("Проверяем обновления", self._check_updates)

    def _check_updates(self) -> None:
        # Кнопка «Проверить обновления» работает ТОЛЬКО с расширением — это
        # единственное, что реально обновляется. Версию самой программы здесь
        # не трогаем (для неё нет механизма обновления из этой кнопки).
        self._check_extension_update()
        if self._ext_update_available:
            return  # статус и баннер уже выставлены в _check_extension_update

        installed = installed_extension_version()
        if installed is None:
            self._set_status(
                "Расширение не установлено",
                "ИНФО",
                "Установите расширение кнопкой «Подготовить и открыть браузеры».",
            )
        else:
            self._set_status(
                "Обновлений нет",
                "ГОТОВО",
                f"Установлена актуальная версия расширения: {installed}.",
            )

    @Slot()
    def save_settings(self) -> None:
        self.run("Сохраняем настройки", self._save_settings)

    @Slot()
    def reset_settings(self) -> None:
        self.run("Сбрасываем настройки", self._reset_settings)

    @Slot()
    def create_backup(self) -> None:
        self.run("Создаем резервную копию", self._create_backup)

    @Slot()
    def open_prepared_folder(self) -> None:
        self.run("Открываем папку расширения", self._open_prepared_folder)

    @Slot(str, bool)
    def set_browser_selected(self, browser_id: str, selected: bool) -> None:
        for browser in self._browsers:
            if browser["id"] == browser_id and browser["canSelect"]:
                browser["selected"] = selected
                break
        self.browsersChanged.emit()

    @Slot(str, bool)
    def set_setting_bool(self, key: str, value: bool) -> None:
        if key in DEFAULT_SETTINGS:
            self._settings[key] = bool(value)
            if key == "runAtStartup":
                apply_startup_setting(bool(value))
                save_settings(self._settings)
            elif key == "minimizeToTray":
                save_settings(self._settings)
            self.settingsChanged.emit()

    @Slot(str, str)
    def set_setting_value(self, key: str, value: str) -> None:
        if key in DEFAULT_SETTINGS:
            self._settings[key] = value
            if key in {"theme", "language"}:
                save_settings(self._settings)
            self.settingsChanged.emit()

    def run(self, busy_status: str, action) -> None:
        if self._busy:
            return
        try:
            self._busy = True
            self.busyChanged.emit()
            self._status = busy_status
            self.statusChanged.emit()
            self.add_log("ИНФО", busy_status)
            action()
        except Exception as error:
            self._status = str(error)
            self.statusChanged.emit()
            self.add_log("ОШИБКА", str(error))
        finally:
            self._busy = False
            self.busyChanged.emit()

    def run_async(self, busy_status: str, action) -> None:
        if self._busy:
            return
        self._busy = True
        self.busyChanged.emit()
        self._status = busy_status
        self.statusChanged.emit()
        self.add_log("ИНФО", busy_status)

        def worker() -> None:
            try:
                action()
            except Exception as error:
                self._status = str(error)
                self.statusChanged.emit()
                self.add_log("ОШИБКА", str(error))
            finally:
                self._busy = False
                self.busyChanged.emit()

        threading.Thread(target=worker, daemon=True).start()

    def _refresh_browsers(self) -> None:
        items: list[dict] = []
        current_ext = app_data_dir() / "extensions" / "chromium" / "current"
        for definition in browser_definitions():
            path = next((candidate for candidate in definition.candidates if candidate.exists()), None)
            installed = path is not None
            can_select = installed and definition.engine == "Chromium"
            if not can_select:
                continue
            profile_roots = [str(profile) for profile in definition.profile_roots]
            ext_installed = extension_installed(profile_roots, current_ext)
            items.append(
                {
                    "id": definition.id,
                    "name": definition.name,
                    "engine": definition.engine,
                    "extensionsUrl": definition.extensions_url,
                    "path": str(path) if path else "",
                    "profileRoots": profile_roots,
                    "installed": installed,
                    "canSelect": can_select,
                    "selected": can_select,
                    "extInstalled": ext_installed,
                    "status": "Расширение установлено" if ext_installed else ("Подключен" if can_select else "Не найден"),
                    "statusColor": "#54D85C" if can_select else "#FFD400",
                    "icon": (_base_dir() / "assets" / "browsers" / f"{definition.id}.svg").as_uri(),
                }
            )

        self._browsers = items
        self.browsersChanged.emit()
        self._status = "Все работает стабильно" if self.connectedCount else "Совместимые браузеры не найдены"
        self.statusChanged.emit()
        self.add_log("ГОТОВО", f"Найдено совместимых браузеров: {self.connectedCount}")

    def _install_extension(self) -> None:
        selected = [browser for browser in self._browsers if browser["selected"] and browser["canSelect"]]
        if not selected:
            raise RuntimeError("Выберите хотя бы один Chromium-браузер.")

        prepared = None
        try:
            prepared = download_extension_to_current()
            self.add_log("ГОТОВО", "Расширение скачано с сервера")
        except Exception as error:
            self.add_log("ИНФО", f"Обновление с сервера недоступно ({error}); использую встроенную копию")
            prepared = prepare_unpacked_extension_local()
        self._prepared_path = str(prepared)
        self.preparedPathChanged.emit()
        set_clipboard_text(str(prepared))
        self.add_log("ГОТОВО", "Путь к расширению скопирован в буфер обмена")

        for index, browser in enumerate(selected):
            self.open_browser_extensions(browser, prepared)
            self.add_log("ГОТОВО", f"Открыта страница расширений: {browser['name']}")
            if index < len(selected) - 1:
                time.sleep(0.6)

        set_clipboard_text(str(prepared))
        self._status = "Включите режим разработчика и загрузите распакованное расширение"
        self.statusChanged.emit()

    def open_browser_extensions(self, browser: dict, prepared_path: Path) -> None:
        path = browser["path"]
        url = browser["extensionsUrl"]
        exe_name = Path(path).name
        already_running = find_browser_window(exe_name) is not None
        developer_mode_changed = False
        if browser.get("engine") == "Chromium":
            developer_mode_changed = enable_developer_mode_preferences(browser.get("profileRoots", []))
        if developer_mode_changed:
            self.add_log("ГОТОВО", f"Режим разработчика подготовлен: {browser['name']}")
        if already_running:
            focus_browser_window(exe_name)
            time.sleep(0.35)
        else:
            subprocess.Popen([path, "--force-renderer-accessibility", "--enable-renderer-accessibility"], close_fds=True)
            time.sleep(1.1)
        focus_browser_window(exe_name)
        force_address_bar_url(url, open_new_tab=already_running)
        time.sleep(1.0)
        if enable_developer_mode_via_uia(exe_name):
            self.add_log("ГОТОВО", f"Режим разработчика включен: {browser['name']}")
        else:
            self.add_log("ИНФО", f"Не удалось подтвердить режим разработчика: {browser['name']}")
        time.sleep(0.45)
        if click_load_unpacked_button_via_uia(exe_name):
            self.add_log("ГОТОВО", f"Нажали «Загрузить распакованное»: {browser['name']}")
            if submit_unpacked_extension_path(prepared_path):
                self.add_log("ГОТОВО", f"Путь к расширению введен: {browser['name']}")
            else:
                self.add_log("ИНФО", f"Окно выбора папки не найдено: {browser['name']}")

    def _open_prepared_folder(self) -> None:
        prepared = Path(self._prepared_path) if self._prepared_path else prepare_unpacked_extension()
        self._prepared_path = str(prepared)
        self.preparedPathChanged.emit()
        subprocess.Popen(["explorer.exe", str(prepared)], close_fds=True)
        self._status = "Папка расширения открыта"
        self.statusChanged.emit()
        self.add_log("ИНФО", "Открыта подготовленная папка расширения")

    def _save_settings(self) -> None:
        save_settings(self._settings)
        apply_startup_setting(bool(self._settings.get("runAtStartup")))
        self._set_status("Настройки сохранены", "ГОТОВО", "Настройки сохранены")

    def _reset_settings(self) -> None:
        self._settings = dict(DEFAULT_SETTINGS)
        save_settings(self._settings)
        apply_startup_setting(False)
        self.settingsChanged.emit()
        self._set_status("Настройки сброшены", "ГОТОВО", "Настройки сброшены")

    def _create_backup(self) -> None:
        settings_path = settings_file()
        backup_path = settings_path.with_name(f"settings.backup.{now_stamp().replace(':', '-')}.json")
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        if settings_path.exists():
            shutil.copy2(settings_path, backup_path)
        else:
            save_settings(self._settings)
            shutil.copy2(settings_path, backup_path)
        self._set_status("Резервная копия создана", "ГОТОВО", f"Копия настроек: {backup_path.name}")

    def _set_status(self, status: str, level: str, message: str) -> None:
        self._status = status
        self.statusChanged.emit()
        self.add_log(level, message)

    def add_log(self, level: str, message: str) -> None:
        self._logs.insert(0, {"time": now_stamp(), "level": level, "message": message})
        self._logs = self._logs[:80]
        self.logsChanged.emit()


def now_stamp() -> str:
    from datetime import datetime

    return datetime.now().strftime("%H:%M:%S")


def machine_hwid() -> str:
    """Стабильный идентификатор машины (Windows MachineGuid → sha256).

    Не меняется при переустановке. Используется как clientId телеметрии и
    позволяет точно исключать собственные устройства из статистики."""
    raw = ""
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\Cryptography",
            0,
            winreg.KEY_READ | getattr(winreg, "KEY_WOW64_64KEY", 0),
        ) as key:
            value, _ = winreg.QueryValueEx(key, "MachineGuid")
            raw = str(value)
    except Exception:
        raw = ""
    if not raw:
        return ""
    return hashlib.sha256(("ymus:" + raw).encode("utf-8")).hexdigest()[:32]


def send_telemetry_ping() -> None:
    try:
        settings = load_settings()
        hwid = machine_hwid()
        if hwid:
            client_id = hwid
        else:
            if not settings.get("clientId"):
                settings["clientId"] = str(uuid.uuid4())
                save_settings(settings)
            client_id = settings["clientId"]
        request = urllib.request.Request(
            _api_url("/api/telemetry/app"),
            data=json.dumps({"version": EXTENSION_VERSION, "clientId": client_id, "hwid": hwid}).encode("utf-8"),
            headers={"Content-Type": "application/json", "User-Agent": f"YMus/{EXTENSION_VERSION}"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=2):
            pass
    except Exception:
        pass


def fetch_latest_app_version() -> str | None:
    """Запрашивает у сервера последнюю версию программы. Возвращает строку
    версии или None при любой ошибке/недоступности сервера."""
    try:
        request = urllib.request.Request(
            _api_url("/api/releases/app"),
            headers={"User-Agent": f"YMus/{EXTENSION_VERSION}"},
        )
        with urllib.request.urlopen(request, timeout=4) as response:
            data = json.loads(response.read().decode("utf-8"))
        version = data.get("version") if isinstance(data, dict) else None
        return version if isinstance(version, str) and version else None
    except Exception:
        return None


def is_newer_version(candidate: str, current: str) -> bool:
    """Сравнивает semver-подобные версии (без pre-release суффикса)."""
    def parse(value: str) -> list[int]:
        parts: list[int] = []
        for chunk in str(value).split("-")[0].split("."):
            try:
                parts.append(int(chunk))
            except ValueError:
                parts.append(0)
        return parts

    return parse(candidate) > parse(current)


def app_data_dir() -> Path:
    return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / APP_NAME


def settings_file() -> Path:
    return app_data_dir() / "settings.json"


def load_settings() -> dict:
    path = settings_file()
    if not path.exists():
        return dict(DEFAULT_SETTINGS)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        settings = dict(DEFAULT_SETTINGS)
        settings.update({key: data[key] for key in DEFAULT_SETTINGS.keys() if key in data})
        return settings
    except Exception:
        return dict(DEFAULT_SETTINGS)


def save_settings(settings: dict) -> None:
    path = settings_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")


def apply_startup_setting(enabled: bool) -> None:
    try:
        import winreg

        key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_SET_VALUE) as key:
            if enabled:
                winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, f'"{sys.executable}"')
            else:
                try:
                    winreg.DeleteValue(key, APP_NAME)
                except FileNotFoundError:
                    pass
    except Exception:
        pass


def set_clipboard_text(text: str) -> bool:
    if sys.platform != "win32":
        return False

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    CF_UNICODETEXT = 13
    GMEM_MOVEABLE = 0x0002

    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    user32.SetClipboardData.restype = wintypes.HANDLE
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]

    for _ in range(8):
        if user32.OpenClipboard(None):
            break
        time.sleep(0.04)
    else:
        return False

    try:
        user32.EmptyClipboard()
        data = (text + "\0").encode("utf-16le")
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not handle:
            return False
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            return False
        ctypes.memmove(pointer, data, len(data))
        kernel32.GlobalUnlock(handle)
        user32.SetClipboardData(CF_UNICODETEXT, handle)
        return True
    finally:
        user32.CloseClipboard()


def browser_definitions() -> list[BrowserDefinition]:
    local = Path(os.environ.get("LOCALAPPDATA", ""))
    roaming = Path(os.environ.get("APPDATA", ""))
    program_files = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
    program_files_x86 = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))

    return [
        BrowserDefinition("yandex", "Яндекс Браузер", "Chromium", "browser://extensions/", [
            local / "Yandex" / "YandexBrowser" / "Application" / "browser.exe",
            program_files / "Yandex" / "YandexBrowser" / "Application" / "browser.exe",
        ], [
            local / "Yandex" / "YandexBrowser" / "User Data",
        ]),
        BrowserDefinition("chrome", "Google Chrome", "Chromium", "chrome://extensions/", [
            local / "Google" / "Chrome" / "Application" / "chrome.exe",
            program_files / "Google" / "Chrome" / "Application" / "chrome.exe",
            program_files_x86 / "Google" / "Chrome" / "Application" / "chrome.exe",
        ], [
            local / "Google" / "Chrome" / "User Data",
        ]),
        BrowserDefinition("edge", "Microsoft Edge", "Chromium", "edge://extensions/", [
            local / "Microsoft" / "Edge" / "Application" / "msedge.exe",
            program_files / "Microsoft" / "Edge" / "Application" / "msedge.exe",
            program_files_x86 / "Microsoft" / "Edge" / "Application" / "msedge.exe",
        ], [
            local / "Microsoft" / "Edge" / "User Data",
        ]),
        BrowserDefinition("brave", "Brave", "Chromium", "brave://extensions/", [
            local / "BraveSoftware" / "Brave-Browser" / "Application" / "brave.exe",
            program_files / "BraveSoftware" / "Brave-Browser" / "Application" / "brave.exe",
            program_files_x86 / "BraveSoftware" / "Brave-Browser" / "Application" / "brave.exe",
        ], [
            local / "BraveSoftware" / "Brave-Browser" / "User Data",
        ]),
        BrowserDefinition("opera", "Opera", "Chromium", "opera://extensions/", [
            local / "Programs" / "Opera" / "opera.exe",
            roaming / "Opera Software" / "Opera Stable" / "opera.exe",
        ], [
            roaming / "Opera Software" / "Opera Stable",
        ]),
        BrowserDefinition("firefox", "Mozilla Firefox", "Firefox", "about:addons", [
            program_files / "Mozilla Firefox" / "firefox.exe",
            program_files_x86 / "Mozilla Firefox" / "firefox.exe",
            local / "Mozilla Firefox" / "firefox.exe",
        ]),
    ]


def enable_developer_mode_preferences(profile_roots: list[str]) -> bool:
    changed = False
    for root_value in profile_roots:
        root = Path(root_value)
        for preferences in preference_files(root):
            try:
                preferences.parent.mkdir(parents=True, exist_ok=True)
                data = {}
                if preferences.exists():
                    data = json.loads(preferences.read_text(encoding="utf-8"))
                extensions = data.setdefault("extensions", {})
                ui = extensions.setdefault("ui", {})
                if ui.get("developer_mode") is not True:
                    ui["developer_mode"] = True
                    preferences.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
                    changed = True
            except Exception:
                continue
    return changed


def profile_dirs(root: Path) -> list[Path]:
    """Каталоги профилей браузера, где лежат файлы Preferences."""
    if not root:
        return []
    name = root.name.lower()
    # У Opera (и Opera GX) профиль — сам корень, а не подпапка Default.
    if "opera" in name:
        return [root]
    dirs = [root / "Default"]
    if root.exists():
        dirs.extend(sorted(root.glob("Profile *")))
    return dirs


def preference_files(root: Path) -> list[Path]:
    # developer_mode пишем только в Preferences (Secure Preferences защищён MAC,
    # его правка приведёт к сбросу настроек браузером).
    return [d / "Preferences" for d in profile_dirs(root)]


def extension_installed(profile_roots: list[str], current_path: Path) -> bool:
    """Проверяет, установлено ли расширение YMus в браузере — читает профильные
    Preferences/Secure Preferences БЕЗ запуска браузера. Сопоставляет по пути
    распакованной папки и по имени расширения."""
    try:
        target = os.path.normcase(os.path.abspath(str(current_path)))
    except Exception:
        target = ""
    for root_value in profile_roots:
        root = Path(root_value)
        for pdir in profile_dirs(root):
            for pref_name in ("Preferences", "Secure Preferences"):
                pf = pdir / pref_name
                if not pf.exists():
                    continue
                try:
                    data = json.loads(pf.read_text(encoding="utf-8", errors="ignore"))
                except Exception:
                    continue
                settings = (((data or {}).get("extensions") or {}).get("settings") or {})
                if not isinstance(settings, dict):
                    continue
                for ext in settings.values():
                    if not isinstance(ext, dict):
                        continue
                    p = ext.get("path", "")
                    if isinstance(p, str) and p and target:
                        try:
                            if os.path.normcase(os.path.abspath(p)) == target:
                                return True
                        except Exception:
                            pass
                    name = (((ext.get("manifest") or {}).get("name")) or "")
                    if isinstance(name, str) and "ymus" in name.lower():
                        return True
    return False


def find_browser_window(exe_name: str):
    if sys.platform != "win32":
        return None

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    psapi = ctypes.windll.psapi
    exe_name = exe_name.lower()
    found_hwnd = wintypes.HWND()

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    PROCESS_VM_READ = 0x0010

    enum_windows_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def process_name(pid: int) -> str:
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, False, pid)
        if not handle:
            return ""
        try:
            buffer = ctypes.create_unicode_buffer(1024)
            size = wintypes.DWORD(len(buffer))
            query_full = getattr(kernel32, "QueryFullProcessImageNameW", None)
            if query_full and query_full(handle, 0, buffer, ctypes.byref(size)):
                return Path(buffer.value).name.lower()
            if psapi.GetModuleFileNameExW(handle, None, buffer, len(buffer)):
                return Path(buffer.value).name.lower()
            return ""
        finally:
            kernel32.CloseHandle(handle)

    @enum_windows_proc
    def enum_proc(hwnd, _lparam):
        nonlocal found_hwnd
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if process_name(pid.value) == exe_name:
            found_hwnd = hwnd
            return False
        return True

    user32.EnumWindows(enum_proc, 0)
    if not found_hwnd:
        return None
    return found_hwnd


def focus_browser_window(exe_name: str) -> bool:
    if sys.platform != "win32":
        return False

    hwnd = find_browser_window(exe_name)
    if not hwnd:
        return False

    user32 = ctypes.windll.user32

    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)
    user32.SetForegroundWindow(hwnd)
    return True


def enable_developer_mode_via_uia(exe_name: str) -> bool:
    if sys.platform != "win32":
        return False

    hwnd = find_browser_window(exe_name)
    if not hwnd:
        return False

    focus_browser_window(exe_name)

    # ВАЖНО: раньше здесь использовался Ctrl+F + ввод текста «режим
    # разработчика» прямо в страницу, чтобы подсветить переключатель. Это
    # ломало UX: на chrome://extensions/ открывалась панель поиска и в неё
    # (а иногда мимо неё — прямо в страницу) печатались «случайные» символы.
    # Теперь переключатель ищется и переключается строго через UI Automation,
    # без эмуляции клавиатуры. Метод идемпотентен: если режим разработчика уже
    # включён (например, выставлен заранее через Preferences), toggle-состояние
    # проверяется и повторное переключение не выполняется.
    for label in ("режим разработчика", "developer mode"):
        if click_developer_mode_with_uia(hwnd, label):
            return True

    return False


def click_developer_mode_with_uia(hwnd, label: str) -> bool:
    try:
        from pywinauto import Desktop
    except Exception:
        return False

    label = label.lower()
    desktop = Desktop(backend="uia")
    window = desktop.window(handle=int(hwnd))

    for _ in range(5):
        try:
            elements = window.descendants()
        except Exception:
            elements = []
        if elements:
            break
        time.sleep(0.25)
    else:
        return False

    label_elements = []
    for element in elements:
        try:
            text = (element.window_text() or "").lower()
        except Exception:
            continue
        if label in text:
            label_elements.append(element)

    for element in label_elements:
        if click_if_toggle_element(element):
            return True

        try:
            rect = element.rectangle()
        except Exception:
            continue

        candidates = []
        label_y = (rect.top + rect.bottom) / 2
        for candidate in elements:
            try:
                info = candidate.element_info
                c_rect = candidate.rectangle()
                c_text = (candidate.window_text() or "").lower()
                c_type = (info.control_type or "").lower()
            except Exception:
                continue

            near_y = abs(((c_rect.top + c_rect.bottom) / 2) - label_y) < 48
            right_side = c_rect.left >= rect.left - 20
            toggle_like = c_type in {"button", "checkbox", "switch"} or "toggle" in c_text or "переключ" in c_text
            if near_y and right_side and toggle_like:
                distance = abs(c_rect.left - rect.right) + abs(((c_rect.top + c_rect.bottom) / 2) - label_y)
                candidates.append((distance, candidate))

        for _distance, candidate in sorted(candidates, key=lambda item: item[0]):
            if click_if_toggle_element(candidate):
                return True

        click_x = min(rect.right + 92, window.rectangle().right - 76)
        click_y = int(label_y)
        try:
            element.click_input(coords=(click_x - rect.left, click_y - rect.top))
            return True
        except Exception:
            user32 = ctypes.windll.user32
            user32.SetCursorPos(int(click_x), int(click_y))
            user32.mouse_event(0x0002, 0, 0, 0, 0)
            user32.mouse_event(0x0004, 0, 0, 0, 0)
            return True

    return False


def click_if_toggle_element(element) -> bool:
    try:
        state = element.get_toggle_state()
        if state == 1:
            return True
        element.toggle()
        return True
    except Exception:
        pass

    try:
        text = (element.window_text() or "").lower()
        control_type = (element.element_info.control_type or "").lower()
        if control_type in {"button", "checkbox", "switch"} or "toggle" in text or "переключ" in text:
            element.click_input()
            return True
    except Exception:
        return False
    return False


def click_load_unpacked_button_via_uia(exe_name: str) -> bool:
    if sys.platform != "win32":
        return False

    hwnd = find_browser_window(exe_name)
    if not hwnd:
        return False

    focus_browser_window(exe_name)
    labels = ("загрузить распакованное", "load unpacked")

    for _ in range(8):
        if click_button_by_text_via_uia(hwnd, labels):
            return True
        time.sleep(0.25)

    return False


def click_reload_extensions_button_via_uia(exe_name: str) -> bool:
    """Жмёт кнопку «Обновить» на ПАНЕЛИ расширений (перезагружает распакованные
    расширения с новым содержимым папки). Доступна в режиме разработчика.

    Ищем по ТОЧНОМУ тексту «Обновить»/«Update», чтобы не попасть в кнопку
    перезагрузки страницы браузера (её имя — «Обновить эту страницу» /
    «Reload this page» — содержит «Обновить», но не равно ему)."""
    if sys.platform != "win32":
        return False

    hwnd = find_browser_window(exe_name)
    if not hwnd:
        return False

    focus_browser_window(exe_name)
    labels = ("обновить", "update")

    for _ in range(6):
        if click_button_by_exact_text_via_uia(hwnd, labels):
            return True
        time.sleep(0.3)

    return False


def click_button_by_exact_text_via_uia(hwnd, labels: tuple[str, ...]) -> bool:
    try:
        from pywinauto import Desktop
    except Exception:
        return False

    normalized = tuple(label.lower() for label in labels)
    try:
        window = Desktop(backend="uia").window(handle=int(hwnd))
        elements = window.descendants()
    except Exception:
        return False

    matches = []
    for element in elements:
        try:
            text = (element.window_text() or "").strip().lower()
            control_type = (element.element_info.control_type or "").lower()
            rect = element.rectangle()
        except Exception:
            continue
        if text not in normalized:
            continue
        button_like = control_type in {"button", "splitbutton", "hyperlink", "menuitem"} or "button" in control_type
        if not button_like:
            continue
        area = max(1, (rect.right - rect.left) * (rect.bottom - rect.top))
        matches.append((area, element))

    # Самая крупная кнопка с точным текстом — это «пилюля» «Обновить» на панели
    # расширений (иконка перезагрузки страницы, если и совпала бы, заметно меньше).
    for _area, element in sorted(matches, key=lambda item: -item[0]):
        try:
            element.click_input()
            return True
        except Exception:
            try:
                rect = element.rectangle()
                ctypes.windll.user32.SetCursorPos(
                    int((rect.left + rect.right) / 2),
                    int((rect.top + rect.bottom) / 2),
                )
                ctypes.windll.user32.mouse_event(0x0002, 0, 0, 0, 0)
                ctypes.windll.user32.mouse_event(0x0004, 0, 0, 0, 0)
                return True
            except Exception:
                continue

    return False


def click_button_by_text_via_uia(hwnd, labels: tuple[str, ...]) -> bool:
    try:
        from pywinauto import Desktop
    except Exception:
        return False

    normalized_labels = tuple(label.lower() for label in labels)
    try:
        window = Desktop(backend="uia").window(handle=int(hwnd))
        elements = window.descendants()
    except Exception:
        return False

    matches = []
    for element in elements:
        try:
            text = (element.window_text() or "").strip().lower()
            control_type = (element.element_info.control_type or "").lower()
            rect = element.rectangle()
        except Exception:
            continue
        if not text or not any(label in text for label in normalized_labels):
            continue
        button_like = control_type in {"button", "splitbutton", "hyperlink", "menuitem"} or "button" in control_type
        area = max(1, (rect.right - rect.left) * (rect.bottom - rect.top))
        matches.append((0 if button_like else 1, area, element))

    for _kind, _area, element in sorted(matches, key=lambda item: (item[0], item[1])):
        try:
            element.click_input()
            return True
        except Exception:
            try:
                rect = element.rectangle()
                ctypes.windll.user32.SetCursorPos(
                    int((rect.left + rect.right) / 2),
                    int((rect.top + rect.bottom) / 2),
                )
                ctypes.windll.user32.mouse_event(0x0002, 0, 0, 0, 0)
                ctypes.windll.user32.mouse_event(0x0004, 0, 0, 0, 0)
                return True
            except Exception:
                continue

    return False


def submit_unpacked_extension_path(path: Path) -> bool:
    if sys.platform != "win32":
        return False

    hwnd = wait_for_folder_dialog()
    if not hwnd:
        return False

    user32 = ctypes.windll.user32
    KEYEVENTF_KEYUP = 0x0002
    VK_CONTROL = 0x11
    VK_L = 0x4C
    VK_V = 0x56
    VK_RETURN = 0x0D

    def key_down(vk: int) -> None:
        user32.keybd_event(vk, 0, 0, 0)

    def key_up(vk: int) -> None:
        user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)

    def tap(vk: int) -> None:
        key_down(vk)
        key_up(vk)

    user32.SetForegroundWindow(hwnd)
    time.sleep(0.2)
    set_clipboard_text(str(path))

    key_down(VK_CONTROL)
    tap(VK_L)
    key_up(VK_CONTROL)
    time.sleep(0.12)

    key_down(VK_CONTROL)
    tap(VK_V)
    key_up(VK_CONTROL)
    time.sleep(0.12)

    tap(VK_RETURN)
    time.sleep(0.65)
    tap(VK_RETURN)
    time.sleep(0.45)

    if is_window(hwnd):
        click_dialog_accept_button(hwnd)

    return True


def wait_for_folder_dialog(timeout: float = 8.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        hwnd = find_folder_dialog_window()
        if hwnd:
            return hwnd
        time.sleep(0.15)
    return None


def find_folder_dialog_window():
    if sys.platform != "win32":
        return None

    user32 = ctypes.windll.user32
    foreground = user32.GetForegroundWindow()
    if foreground and is_folder_dialog_window(foreground):
        return foreground

    enum_windows_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    found = wintypes.HWND()
    fallback = wintypes.HWND()

    @enum_windows_proc
    def enum_proc(hwnd, _lparam):
        nonlocal found, fallback
        if not user32.IsWindowVisible(hwnd):
            return True
        if not is_dialog_class(hwnd):
            return True
        if not fallback:
            fallback = hwnd
        if is_folder_dialog_window(hwnd):
            found = hwnd
            return False
        return True

    user32.EnumWindows(enum_proc, 0)
    return found or fallback or None


def is_window(hwnd) -> bool:
    return bool(hwnd) and bool(ctypes.windll.user32.IsWindow(hwnd))


def is_dialog_class(hwnd) -> bool:
    buffer = ctypes.create_unicode_buffer(256)
    ctypes.windll.user32.GetClassNameW(hwnd, buffer, len(buffer))
    return buffer.value == "#32770"


def is_folder_dialog_window(hwnd) -> bool:
    if not is_dialog_class(hwnd):
        return False
    title = get_window_text(hwnd).lower()
    markers = (
        "выбор",
        "папк",
        "folder",
        "directory",
        "extension",
        "select",
        "open",
        "откры",
    )
    return any(marker in title for marker in markers)


def get_window_text(hwnd) -> str:
    user32 = ctypes.windll.user32
    length = user32.GetWindowTextLengthW(hwnd)
    buffer = ctypes.create_unicode_buffer(max(1, length + 1))
    user32.GetWindowTextW(hwnd, buffer, len(buffer))
    return buffer.value


def click_dialog_accept_button(hwnd) -> bool:
    labels = ("выбор папки", "выбрать папку", "select folder", "open", "открыть")
    return click_button_by_text_via_uia(hwnd, labels)


def force_address_bar_url(url: str, open_new_tab: bool = False) -> None:
    if sys.platform != "win32":
        return

    user32 = ctypes.windll.user32
    KEYEVENTF_KEYUP = 0x0002
    KEYEVENTF_UNICODE = 0x0004
    VK_CONTROL = 0x11
    VK_L = 0x4C
    VK_T = 0x54
    VK_RETURN = 0x0D

    def key_down(vk: int) -> None:
        user32.keybd_event(vk, 0, 0, 0)

    def key_up(vk: int) -> None:
        user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)

    def tap(vk: int) -> None:
        key_down(vk)
        key_up(vk)

    if open_new_tab:
        key_down(VK_CONTROL)
        tap(VK_T)
        key_up(VK_CONTROL)
        time.sleep(0.25)

    key_down(VK_CONTROL)
    tap(VK_L)
    key_up(VK_CONTROL)
    time.sleep(0.16)
    send_unicode_text(url, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE)
    time.sleep(0.12)
    tap(VK_RETURN)


def send_unicode_text(text: str, keyup_flag: int, unicode_flag: int) -> None:
    user32 = ctypes.windll.user32
    for char in text:
        code = ord(char)
        user32.keybd_event(0, code, unicode_flag, 0)
        user32.keybd_event(0, code, unicode_flag | keyup_flag, 0)
        time.sleep(0.008)


def app_root() -> Path:
    return Path(__file__).resolve().parent


def repo_root() -> Path:
    return app_root().parents[2]


def find_extension_source() -> Path:
    candidates = [
        app_root() / "Extension",
        app_root().parent / "Extension",
        repo_root() / "YMus",
        repo_root(),
    ]
    for candidate in candidates:
        if (candidate / "manifest.json").exists():
            return candidate
    raise RuntimeError("Не найдена локальная сборка расширения YMus.")


def prepare_unpacked_extension_local() -> Path:
    """Готовит расширение из локально вложенной сборки (фоллбэк для офлайна)."""
    source = find_extension_source()
    manifest_path = source / "manifest.json"
    version = json.loads(manifest_path.read_text(encoding="utf-8")).get("version", EXTENSION_VERSION)

    root = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / APP_NAME / "extensions" / "chromium"
    current = root / "current"
    staging = root / "staging"
    backup = root / "previous"
    root.mkdir(parents=True, exist_ok=True)

    if staging.exists():
        shutil.rmtree(staging)
    shutil.copytree(source, staging)

    if not (staging / "manifest.json").exists():
        raise RuntimeError("В подготовленной папке отсутствует manifest.json.")

    if backup.exists():
        shutil.rmtree(backup)
    if current.exists():
        current.rename(backup)

    try:
        staging.rename(current)
    except Exception:
        if backup.exists() and not current.exists():
            backup.rename(current)
        raise

    if backup.exists():
        shutil.rmtree(backup)

    return current


def fetch_extension_release() -> dict | None:
    """Получает метаданные последней версии расширения с сервера."""
    try:
        request = urllib.request.Request(
            _api_url("/api/releases/extension"),
            headers={"User-Agent": f"YMus/{EXTENSION_VERSION}"},
        )
        with urllib.request.urlopen(request, timeout=6) as response:
            data = json.loads(response.read().decode("utf-8"))
        if isinstance(data, dict) and data.get("ok"):
            return data
        return None
    except Exception:
        return None


def _safe_extract_zip(archive: zipfile.ZipFile, dest: Path) -> None:
    """Распаковка с защитой от Zip Slip."""
    dest = dest.resolve()
    for member in archive.namelist():
        target = (dest / member).resolve()
        if not str(target).startswith(str(dest)):
            raise RuntimeError("Небезопасный путь в архиве расширения")
    archive.extractall(dest)


def _find_manifest_dir(base: Path) -> Path | None:
    """Находит каталог с manifest.json (архив может иметь вложенную папку)."""
    if (base / "manifest.json").exists():
        return base
    for sub in base.iterdir():
        if sub.is_dir() and (sub / "manifest.json").exists():
            return sub
    return None


def download_extension_to_current() -> Path:
    """Скачивает расширение с сервера, проверяет SHA-256 и атомарно
    распаковывает в .../chromium/current. Бросает исключение при ошибке."""
    release = fetch_extension_release()
    if release is None:
        raise RuntimeError("релиз расширения не найден на сервере")

    rel_path = release.get("file") or release.get("latest")
    if not isinstance(rel_path, str) or not rel_path:
        raise RuntimeError("Сервер не вернул ссылку на расширение")
    url = _server_base().rstrip("/") + rel_path
    expected_sha = release.get("sha256")

    root = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / APP_NAME / "extensions" / "chromium"
    root.mkdir(parents=True, exist_ok=True)
    tmp_zip = root / "download.zip"

    request = urllib.request.Request(url, headers={"User-Agent": f"YMus/{EXTENSION_VERSION}"})
    with urllib.request.urlopen(request, timeout=120) as response, open(tmp_zip, "wb") as out:
        shutil.copyfileobj(response, out)

    if isinstance(expected_sha, str) and expected_sha:
        digest = hashlib.sha256(tmp_zip.read_bytes()).hexdigest()
        if digest.lower() != expected_sha.lower():
            tmp_zip.unlink(missing_ok=True)
            raise RuntimeError("Контрольная сумма расширения не совпала")

    staging = root / "staging"
    current = root / "current"
    backup = root / "previous"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(tmp_zip, "r") as archive:
        _safe_extract_zip(archive, staging)
    tmp_zip.unlink(missing_ok=True)

    manifest_dir = _find_manifest_dir(staging)
    if manifest_dir is None:
        shutil.rmtree(staging, ignore_errors=True)
        raise RuntimeError("В архиве расширения нет manifest.json")

    if backup.exists():
        shutil.rmtree(backup)
    if current.exists():
        current.rename(backup)
    try:
        manifest_dir.rename(current)
    except Exception:
        if backup.exists() and not current.exists():
            backup.rename(current)
        raise
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    if backup.exists():
        shutil.rmtree(backup, ignore_errors=True)
    return current


def installed_extension_version() -> str | None:
    """Версия установленного (распакованного) расширения из current/manifest.json."""
    current = (
        Path(os.environ.get("LOCALAPPDATA", str(Path.home())))
        / APP_NAME
        / "extensions"
        / "chromium"
        / "current"
    )
    manifest = current / "manifest.json"
    if not manifest.exists():
        return None
    try:
        return json.loads(manifest.read_text(encoding="utf-8")).get("version")
    except Exception:
        return None


def prepare_unpacked_extension() -> Path:
    """Готовит распакованное расширение в `current`.

    Приоритет — скачивание актуальной версии с сервера. Если сервер недоступен,
    используется локально вложенная копия (чтобы установка работала офлайн)."""
    try:
        return download_extension_to_current()
    except Exception as error:
        print(f"[ymus] Серверная загрузка расширения не удалась: {error}; беру встроенную копию")
        return prepare_unpacked_extension_local()
