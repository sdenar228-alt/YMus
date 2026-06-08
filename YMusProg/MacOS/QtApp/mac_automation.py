"""Автоматизация браузеров на macOS через AppleScript (osascript).

Это macOS-аналог Windows-логики на pywinauto/UIA из backend.py. Управление
идёт через System Events (нужно разрешение «Универсальный доступ» /
Accessibility в Системных настройках).

Что умеет:
  - activate_browser   — поднять/активировать окно браузера;
  - launch_browser     — запустить браузер с нужными флагами и URL;
  - navigate_to_url    — открыть адрес (Cmd+L → ввод → Enter), опц. новая вкладка;
  - click_web_button   — найти и нажать кнопку внутри страницы (chrome://extensions)
                         по подстроке названия (AXTitle/AXDescription);
  - submit_open_panel  — в нативном диалоге выбора папки ввести путь
                         (Cmd+Shift+G) и подтвердить;
  - is_browser_running — открыто ли окно браузера.

ВАЖНО: клик по элементам ВНУТРИ веб-страницы возможен только когда браузер
запущен с флагом --force-renderer-accessibility (мы его передаём). Поиск по
AX-дереву Chrome бывает медленным, поэтому глубина ограничена.
"""

from __future__ import annotations

import subprocess
import time


def _osascript(script: str, timeout: float = 25.0) -> tuple[bool, str]:
    """Выполняет AppleScript. Возвращает (успех, вывод/ошибка)."""
    try:
        proc = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        out = (proc.stdout or "").strip()
        err = (proc.stderr or "").strip()
        if proc.returncode != 0:
            return False, err or out
        return True, out
    except Exception as error:  # noqa: BLE001
        return False, str(error)


def _escape(text: str) -> str:
    """Экранирует строку для вставки в двойные кавычки AppleScript."""
    return text.replace("\\", "\\\\").replace('"', '\\"')


def is_browser_running(process_name: str) -> bool:
    """True, если у процесса браузера есть хотя бы одно окно."""
    script = f'''
    tell application "System Events"
        if exists (process "{_escape(process_name)}") then
            return (count of windows of process "{_escape(process_name)}") as string
        else
            return "0"
        end if
    end tell
    '''
    ok, out = _osascript(script, timeout=8)
    if not ok:
        return False
    try:
        return int(out) > 0
    except ValueError:
        return False


def activate_browser(app_name: str) -> bool:
    """Активирует (поднимает на передний план) приложение браузера по имени."""
    ok, _ = _osascript(f'tell application "{_escape(app_name)}" to activate', timeout=8)
    return ok


def launch_browser(binary_path: str, url: str, accessibility: bool = True) -> bool:
    """Запускает бинарник браузера с URL и флагами доступности (для AX в вебе)."""
    args = [binary_path]
    if accessibility:
        args += ["--force-renderer-accessibility", "--enable-renderer-accessibility"]
    if url:
        args.append(url)
    try:
        subprocess.Popen(args, close_fds=True)
        return True
    except Exception:
        return False


def navigate_to_url(app_name: str, url: str, open_new_tab: bool = False) -> bool:
    """Открывает адрес в активном окне браузера: Cmd+T (опц.) → Cmd+L → ввод → Enter."""
    new_tab = ""
    if open_new_tab:
        new_tab = '''
        keystroke "t" using {command down}
        delay 0.35'''
    script = f'''
    tell application "{_escape(app_name)}" to activate
    delay 0.3
    tell application "System Events"{new_tab}
        keystroke "l" using {{command down}}
        delay 0.18
        keystroke "{_escape(url)}"
        delay 0.12
        key code 36
    end tell
    '''
    ok, _ = _osascript(script, timeout=15)
    return ok


# AppleScript-обработчик рекурсивного поиска UI-элемента по подстроке имени.
# Ограничение глубины защищает от зависания на огромном AX-дереве Chrome.
_FIND_AND_CLICK_TEMPLATE = '''
on findAndClick(el, targetList, depth)
    if depth > 22 then return false
    try
        set elRole to (role of el) as string
    on error
        set elRole to ""
    end try
    try
        set elTitle to ""
        try
            set elTitle to (title of el) as string
        end try
        set elDesc to ""
        try
            set elDesc to (description of el) as string
        end try
        set hay to (elTitle & " " & elDesc)
        ignoring case
            repeat with t in targetList
                if %CMP% then
                    if elRole contains "button" or elRole contains "Button" or elRole is "AXLink" then
                        try
                            perform action "AXPress" of el
                            return true
                        on error
                            try
                                click el
                                return true
                            end try
                        end try
                    end if
                end if
            end repeat
        end ignoring
    end try
    try
        set kids to UI elements of el
    on error
        return false
    end try
    repeat with k in kids
        if my findAndClick(k, targetList, depth + 1) then return true
    end repeat
    return false
end findAndClick

tell application "System Events"
    if not (exists process "%PROC%") then return "no-process"
    set proc to process "%PROC%"
    set targetList to {%TARGETS%}
    repeat with w in windows of proc
        if my findAndClick(w, targetList, 0) then return "clicked"
    end repeat
    return "not-found"
end tell
'''


def click_web_button(process_name: str, labels: tuple[str, ...], attempts: int = 6, exact: bool = False) -> bool:
    """Ищет в окнах процесса браузера кнопку по названиям и жмёт её.

    exact=False — совпадение по подстроке (Load unpacked, Developer mode);
    exact=True  — точное равенство названия (кнопка «Обновить»/«Update» на
                  панели расширений, чтобы не попасть в «Обновить эту страницу»).
    """
    targets = ", ".join('"%s"' % _escape(label) for label in labels)
    if exact:
        cmp_expr = "((elTitle as string) is (t as string)) or ((elDesc as string) is (t as string))"
    else:
        cmp_expr = "hay contains (t as string)"
    script = (
        _FIND_AND_CLICK_TEMPLATE.replace("%PROC%", _escape(process_name))
        .replace("%TARGETS%", targets)
        .replace("%CMP%", cmp_expr)
    )
    for _ in range(attempts):
        ok, out = _osascript(script, timeout=30)
        if ok and out == "clicked":
            return True
        time.sleep(0.4)
    return False


def submit_open_panel(path: str, accept_labels: tuple[str, ...] = ("Open", "Открыть", "Select", "Выбрать")) -> bool:
    """В нативном NSOpenPanel вводит путь через «Перейти к папке» (Cmd+Shift+G),
    подтверждает и нажимает кнопку открытия/выбора."""
    accept = " or ".join('name of b contains "%s"' % _escape(a) for a in accept_labels)
    script = f'''
    tell application "System Events"
        delay 0.5
        keystroke "g" using {{command down, shift down}}
        delay 0.4
        keystroke "{_escape(path)}"
        delay 0.25
        key code 36
        delay 0.5
        key code 36
        delay 0.5
        -- попытка нажать кнопку подтверждения в активном диалоге
        try
            set frontProc to first process whose frontmost is true
            repeat with w in windows of frontProc
                repeat with b in (buttons of w)
                    if ({accept}) then
                        perform action "AXPress" of b
                        return "ok"
                    end if
                end repeat
            end repeat
        end try
        return "typed"
    end tell
    '''
    ok, out = _osascript(script, timeout=20)
    return ok and out in ("ok", "typed")


def has_accessibility_permission() -> bool:
    """Грубая проверка наличия разрешения Accessibility: пробуем прочитать
    список процессов через System Events. Если запрещено — osascript вернёт
    ошибку с кодом -1719 / -25211."""
    ok, out = _osascript(
        'tell application "System Events" to return (count of processes)', timeout=8
    )
    return ok
