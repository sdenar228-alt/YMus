"""macOS-бэкенд YMus.

Портирован с Windows-версии (YMusProg/Windows/QtApp/backend.py). Кроссплатформенная
логика (настройки, телеметрия, скачивание расширения, сравнение версий, детект
установленного расширения через чтение Preferences, включение developer mode
правкой Preferences) повторяет Windows один в один. Платформенные части
заменены на macOS-аналоги:

  - пути браузеров      → ~/Library/Application Support/...  и  .app-бандлы;
  - автоматизация       → AppleScript (mac_automation.py) вместо pywinauto/UIA;
  - автозапуск          → LaunchAgent plist вместо реестра Windows;
  - ID устройства       → IOPlatformUUID вместо MachineGuid;
  - буфер обмена        → pbcopy.
"""

from __future__ import annotations

import json
import os
import plistlib
import shutil
import subprocess
import sys
import threading
import time
import base64
import hashlib
import zipfile
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from PySide6.QtCore import QObject, Property, Signal, Slot, QTimer

import mac_automation


EXTENSION_VERSION = "1.1.2"
APP_NAME = "YMus"

# Базовый адрес сервера в обфусцированном виде (XOR + base64) — тот же ключ и
# та же строка, что в Windows-версии, чтобы клиент ходил на тот же сервер.
_SRV_K = "ym-aurora-shield-key"
_SRV_B = "ERlZEQZIQF0YQAYbRxEJB0U="


def _server_base() -> str:
    raw = base64.b64decode(_SRV_B)
    key = _SRV_K.encode("utf-8")
    return bytes(b ^ key[i % len(key)] for i, b in enumerate(raw)).decode("utf-8")


def _api_url(path: str) -> str:
    return _server_base().rstrip("/") + path


def _base_dir() -> Path:
    """Каталог ресурсов: _MEIPASS во frozen-сборке, иначе папка скрипта."""
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
    app_paths: list[Path]                       # пути к .app-бандлам
    profile_roots: list[Path] = field(default_factory=list)
    process_name: str = ""                       # имя процесса в System Events
    app_name: str = ""                           # имя приложения для activate


class Backend(QObject):
    browsersChanged = Signal()
    logsChanged = Signal()
    statusChanged = Signal()
    preparedPathChanged = Signal()
    busyChanged = Signal()
    settingsChanged = Signal()
    ready = Signal()
    updateInfoChanged = Signal()
    accessibilityChanged = Signal()

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
        self._accessibility_needed = True
        self.add_log("ИНФО", "YMus (macOS) запущен")
        _device_id = machine_hwid()
        if _device_id:
            self.add_log("ИНФО", f"ID устройства: {_device_id}")
        threading.Thread(target=send_telemetry_ping, daemon=True).start()
        QTimer.singleShot(0, self._initial_load)

    def _initial_load(self) -> None:
        try:
            self._refresh_browsers()
        finally:
            self.ready.emit()
        threading.Thread(target=self._check_extension_update, daemon=True).start()
        threading.Thread(target=self._update_accessibility, daemon=True).start()
        # Периодически перепроверяем разрешение, чтобы плашка спряталась сразу
        # после того, как пользователь включит «Универсальный доступ».
        self._access_timer = QTimer(self)
        self._access_timer.setInterval(4000)
        self._access_timer.timeout.connect(
            lambda: threading.Thread(target=self._update_accessibility, daemon=True).start()
        )
        self._access_timer.start()

    def _update_accessibility(self) -> None:
        needed = not mac_automation.has_accessibility_permission()
        if needed != self._accessibility_needed:
            self._accessibility_needed = needed
            self.accessibilityChanged.emit()
        # Когда разрешение выдано — больше не дёргаем проверку.
        if not needed and hasattr(self, "_access_timer"):
            try:
                self._access_timer.stop()
            except Exception:
                pass

    def _check_extension_update(self) -> None:
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
        targets = [b for b in self._browsers if b.get("extInstalled") and b.get("canSelect")]
        if not targets:
            targets = [b for b in self._browsers if b.get("selected") and b.get("canSelect")]
        if not targets:
            raise RuntimeError("Нет браузеров с установленным расширением.")

        release = fetch_extension_release()
        update_type = str((release or {}).get("updateType") or self._ext_update_type or "simple").lower()

        try:
            prepared = download_extension_to_current()
        except Exception as error:
            raise RuntimeError(f"Не удалось скачать обновление: {error}")
        self._prepared_path = str(prepared)
        self.preparedPathChanged.emit()
        set_clipboard_text(str(prepared))

        for index, browser in enumerate(targets):
            if update_type == "full":
                self.open_browser_extensions(browser, prepared)
                self.add_log("ГОТОВО", f"Полное обновление: {browser['name']}")
            else:
                self.reload_browser_extension(browser)
                self.add_log("ГОТОВО", f"Простое обновление: {browser['name']}")
            if index < len(targets) - 1:
                time.sleep(0.8)

        self._ext_update_available = False
        self.updateInfoChanged.emit()
        self._refresh_browsers()
        self._set_status(
            "Расширение обновлено",
            "ГОТОВО",
            f"Расширение обновлено до {self._ext_latest}".strip(),
        )

    def reload_browser_extension(self, browser: dict) -> None:
        """Простое обновление: открыть страницу расширений и нажать «Обновить»."""
        url = browser["extensionsUrl"]
        process_name = browser.get("processName", "")
        app_name = browser.get("appName", "")
        binary = browser.get("binary", "")
        already_running = mac_automation.is_browser_running(process_name)
        if browser.get("engine") == "Chromium":
            enable_developer_mode_preferences(browser.get("profileRoots", []))
        if already_running:
            mac_automation.activate_browser(app_name)
            time.sleep(0.4)
        else:
            mac_automation.launch_browser(binary, url)
            time.sleep(1.4)
        mac_automation.activate_browser(app_name)
        mac_automation.navigate_to_url(app_name, url, open_new_tab=already_running)
        time.sleep(1.2)
        # На панели расширений жмём «Обновить» по ТОЧНОМУ названию (exact),
        # чтобы не задеть кнопку перезагрузки страницы браузера.
        if not mac_automation.click_web_button(process_name, ("Обновить", "Update"), exact=True):
            self.add_log(
                "ИНФО",
                f"Кнопка «Обновить» не найдена — расширение применится после перезапуска: {browser['name']}",
            )

    # ─── Qt-свойства ────────────────────────────────────────────────────────

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

    @Property(bool, notify=accessibilityChanged)
    def accessibilityNeeded(self) -> bool:
        return self._accessibility_needed

    @Slot()
    def open_accessibility_settings(self) -> None:
        """Открывает Системные настройки → Конфиденциальность → Универсальный
        доступ, где включается YMus."""
        try:
            subprocess.Popen(
                ["open", "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"],
                close_fds=True,
            )
            self._set_status(
                "Открыты настройки доступа",
                "ИНФО",
                "Включите YMus в списке «Универсальный доступ» и вернитесь в программу.",
            )
        except Exception as error:
            self.add_log("ОШИБКА", f"Не удалось открыть настройки: {error}")
        # Перепроверяем разрешение чуть позже.
        threading.Timer(3.0, lambda: self._update_accessibility()).start()

    @Property(str, notify=preparedPathChanged)
    def preparedPath(self) -> str:
        return self._prepared_path or str(
            Path.home() / "Library" / "Application Support" / APP_NAME / "extensions" / "chromium" / "current"
        )

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

    # ─── Слоты для QML ───────────────────────────────────────────────────────

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
        self._check_extension_update()
        if self._ext_update_available:
            return
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

    # ─── Инфраструктура запуска действий ─────────────────────────────────────

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

    # ─── Основная логика ─────────────────────────────────────────────────────

    def _refresh_browsers(self) -> None:
        items: list[dict] = []
        current_ext = app_data_dir() / "extensions" / "chromium" / "current"
        for definition in browser_definitions():
            app_path = next((candidate for candidate in definition.app_paths if candidate.exists()), None)
            installed = app_path is not None
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
                    "path": str(app_path) if app_path else "",
                    "binary": str(browser_binary(app_path)) if app_path else "",
                    "processName": definition.process_name,
                    "appName": definition.app_name,
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

        if not mac_automation.has_accessibility_permission():
            self.add_log(
                "ИНФО",
                "Нет разрешения «Универсальный доступ». Системные настройки → "
                "Конфиденциальность и безопасность → Универсальный доступ → включите YMus.",
            )

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
                time.sleep(0.8)

        set_clipboard_text(str(prepared))
        self._status = "Включите режим разработчика и загрузите распакованное расширение"
        self.statusChanged.emit()

    def open_browser_extensions(self, browser: dict, prepared_path: Path) -> None:
        url = browser["extensionsUrl"]
        process_name = browser.get("processName", "")
        app_name = browser.get("appName", "")
        binary = browser.get("binary", "")
        already_running = mac_automation.is_browser_running(process_name)
        developer_mode_changed = False
        if browser.get("engine") == "Chromium":
            developer_mode_changed = enable_developer_mode_preferences(browser.get("profileRoots", []))
        if developer_mode_changed:
            self.add_log("ГОТОВО", f"Режим разработчика подготовлен: {browser['name']}")
        if already_running:
            mac_automation.activate_browser(app_name)
            time.sleep(0.4)
        else:
            mac_automation.launch_browser(binary, url)
            time.sleep(1.4)
        mac_automation.activate_browser(app_name)
        mac_automation.navigate_to_url(app_name, url, open_new_tab=already_running)
        time.sleep(1.2)
        # Подстраховка: если developer mode не подхватился из Preferences —
        # пробуем переключить тумблер прямо на странице.
        mac_automation.click_web_button(process_name, ("Режим разработчика", "Developer mode"), attempts=2)
        time.sleep(0.4)
        if mac_automation.click_web_button(process_name, ("Загрузить распакованное", "Load unpacked")):
            self.add_log("ГОТОВО", f"Нажали «Загрузить распакованное»: {browser['name']}")
            if mac_automation.submit_open_panel(str(prepared_path)):
                self.add_log("ГОТОВО", f"Путь к расширению введён: {browser['name']}")
            else:
                self.add_log("ИНФО", f"Окно выбора папки не найдено: {browser['name']}")
        else:
            self.add_log(
                "ИНФО",
                f"Кнопка «Загрузить распакованное» не найдена: {browser['name']}. "
                "Проверьте разрешение «Универсальный доступ».",
            )

    def _open_prepared_folder(self) -> None:
        prepared = Path(self._prepared_path) if self._prepared_path else prepare_unpacked_extension()
        self._prepared_path = str(prepared)
        self.preparedPathChanged.emit()
        subprocess.Popen(["open", str(prepared)], close_fds=True)
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
        if not settings_path.exists():
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


# ─── Платформенные и кроссплатформенные функции ──────────────────────────────


def now_stamp() -> str:
    from datetime import datetime

    return datetime.now().strftime("%H:%M:%S")


def machine_hwid() -> str:
    """Стабильный ID машины (macOS IOPlatformUUID → sha256). Не меняется при
    переустановке. Используется как clientId телеметрии."""
    raw = ""
    try:
        proc = subprocess.run(
            ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        for line in (proc.stdout or "").splitlines():
            if "IOPlatformUUID" in line:
                # строка вида:   "IOPlatformUUID" = "XXXXXXXX-...."
                parts = line.split("=", 1)
                if len(parts) == 2:
                    raw = parts[1].strip().strip('"')
                    break
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
            data=json.dumps({"version": EXTENSION_VERSION, "clientId": client_id, "hwid": hwid, "os": "macos"}).encode("utf-8"),
            headers={"Content-Type": "application/json", "User-Agent": f"YMus/{EXTENSION_VERSION}"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=2):
            pass
    except Exception:
        pass


def fetch_latest_app_version() -> str | None:
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
    return Path.home() / "Library" / "Application Support" / APP_NAME


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


_LAUNCH_AGENT_LABEL = "tech.ymus.app"


def _launch_agent_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{_LAUNCH_AGENT_LABEL}.plist"


def _startup_program_args() -> list[str]:
    """Аргументы запуска для автозапуска. Во frozen .app — открываем бандл через
    `open`, в dev — запускаем python с main.py."""
    exe = Path(sys.executable)
    # В .app бинарь лежит в Contents/MacOS/<name>; поднимаемся до .app и
    # запускаем через `open -a`, чтобы корректно стартовал GUI-бандл.
    for parent in exe.parents:
        if parent.suffix == ".app":
            return ["/usr/bin/open", "-a", str(parent)]
    if getattr(sys, "frozen", False):
        return [str(exe)]
    # dev-режим
    return [str(exe), str(Path(__file__).resolve().parent / "main.py")]


def apply_startup_setting(enabled: bool) -> None:
    """Автозапуск при входе в систему через LaunchAgent."""
    try:
        plist_path = _launch_agent_path()
        if enabled:
            plist_path.parent.mkdir(parents=True, exist_ok=True)
            data = {
                "Label": _LAUNCH_AGENT_LABEL,
                "ProgramArguments": _startup_program_args(),
                "RunAtLoad": True,
                "ProcessType": "Interactive",
            }
            with open(plist_path, "wb") as fh:
                plistlib.dump(data, fh)
            subprocess.run(["launchctl", "load", str(plist_path)], capture_output=True)
        else:
            if plist_path.exists():
                subprocess.run(["launchctl", "unload", str(plist_path)], capture_output=True)
                plist_path.unlink(missing_ok=True)
    except Exception:
        pass


def set_clipboard_text(text: str) -> bool:
    """Кладёт текст в буфер обмена через pbcopy."""
    if sys.platform != "darwin":
        return False
    try:
        proc = subprocess.run(["pbcopy"], input=text, text=True, timeout=5)
        return proc.returncode == 0
    except Exception:
        return False


def browser_binary(app_path: Path | None) -> Path | None:
    """Путь к исполняемому файлу внутри .app-бандла (Contents/MacOS/<exec>)."""
    if app_path is None:
        return None
    try:
        info = app_path / "Contents" / "Info.plist"
        exec_name = None
        if info.exists():
            with open(info, "rb") as fh:
                exec_name = plistlib.load(fh).get("CFBundleExecutable")
        macos_dir = app_path / "Contents" / "MacOS"
        if exec_name:
            candidate = macos_dir / exec_name
            if candidate.exists():
                return candidate
        # фолбэк: первый исполняемый файл в Contents/MacOS
        if macos_dir.exists():
            for child in macos_dir.iterdir():
                if child.is_file():
                    return child
    except Exception:
        pass
    return None


def browser_definitions() -> list[BrowserDefinition]:
    apps = Path("/Applications")
    home_apps = Path.home() / "Applications"
    support = Path.home() / "Library" / "Application Support"

    def app_candidates(name: str) -> list[Path]:
        return [apps / name, home_apps / name]

    return [
        BrowserDefinition(
            "yandex", "Яндекс Браузер", "Chromium", "browser://extensions/",
            app_candidates("Yandex.app"),
            [support / "Yandex" / "YandexBrowser"],
            process_name="Yandex", app_name="Yandex",
        ),
        BrowserDefinition(
            "chrome", "Google Chrome", "Chromium", "chrome://extensions/",
            app_candidates("Google Chrome.app"),
            [support / "Google" / "Chrome"],
            process_name="Google Chrome", app_name="Google Chrome",
        ),
        BrowserDefinition(
            "edge", "Microsoft Edge", "Chromium", "edge://extensions/",
            app_candidates("Microsoft Edge.app"),
            [support / "Microsoft Edge"],
            process_name="Microsoft Edge", app_name="Microsoft Edge",
        ),
        BrowserDefinition(
            "brave", "Brave", "Chromium", "brave://extensions/",
            app_candidates("Brave Browser.app"),
            [support / "BraveSoftware" / "Brave-Browser"],
            process_name="Brave Browser", app_name="Brave Browser",
        ),
        BrowserDefinition(
            "opera", "Opera", "Chromium", "opera://extensions/",
            app_candidates("Opera.app"),
            [support / "com.operasoftware.Opera"],
            process_name="Opera", app_name="Opera",
        ),
        BrowserDefinition(
            "vivaldi", "Vivaldi", "Chromium", "vivaldi://extensions/",
            app_candidates("Vivaldi.app"),
            [support / "Vivaldi"],
            process_name="Vivaldi", app_name="Vivaldi",
        ),
        BrowserDefinition(
            "chromium", "Chromium", "Chromium", "chrome://extensions/",
            app_candidates("Chromium.app"),
            [support / "Chromium"],
            process_name="Chromium", app_name="Chromium",
        ),
        BrowserDefinition(
            "firefox", "Mozilla Firefox", "Firefox", "about:addons",
            app_candidates("Firefox.app"),
            [],
            process_name="firefox", app_name="Firefox",
        ),
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
    if not root:
        return []
    name = root.name.lower()
    if "opera" in name:
        return [root]
    dirs = [root / "Default"]
    if root.exists():
        dirs.extend(sorted(root.glob("Profile *")))
    return dirs


def preference_files(root: Path) -> list[Path]:
    return [d / "Preferences" for d in profile_dirs(root)]


def extension_installed(profile_roots: list[str], current_path: Path) -> bool:
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


def app_root() -> Path:
    return Path(__file__).resolve().parent


def repo_root() -> Path:
    # .../YMusProg/MacOS/QtApp → подняться до корня репозитория
    return app_root().parents[2]


def find_extension_source() -> Path:
    candidates = [
        _base_dir() / "Extension",
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
    source = find_extension_source()
    root = app_data_dir() / "extensions" / "chromium"
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
    dest = dest.resolve()
    for member in archive.namelist():
        target = (dest / member).resolve()
        if not str(target).startswith(str(dest)):
            raise RuntimeError("Небезопасный путь в архиве расширения")
    archive.extractall(dest)


def _find_manifest_dir(base: Path) -> Path | None:
    if (base / "manifest.json").exists():
        return base
    for sub in base.iterdir():
        if sub.is_dir() and (sub / "manifest.json").exists():
            return sub
    return None


def download_extension_to_current() -> Path:
    release = fetch_extension_release()
    if release is None:
        raise RuntimeError("релиз расширения не найден на сервере")

    rel_path = release.get("file") or release.get("latest")
    if not isinstance(rel_path, str) or not rel_path:
        raise RuntimeError("Сервер не вернул ссылку на расширение")
    url = _server_base().rstrip("/") + rel_path
    expected_sha = release.get("sha256")

    root = app_data_dir() / "extensions" / "chromium"
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
    current = app_data_dir() / "extensions" / "chromium" / "current"
    manifest = current / "manifest.json"
    if not manifest.exists():
        return None
    try:
        return json.loads(manifest.read_text(encoding="utf-8")).get("version")
    except Exception:
        return None


def prepare_unpacked_extension() -> Path:
    try:
        return download_extension_to_current()
    except Exception as error:
        print(f"[ymus] Серверная загрузка расширения не удалась: {error}; беру встроенную копию")
        return prepare_unpacked_extension_local()
