"""Анти-дебаг заглушка для macOS.

На Windows guard.py использует WinAPI (IsDebuggerPresent / NtQueryInformationProcess).
На macOS таких прямых аналогов через ctypes нет (надёжная проверка требует
sysctl с KERN_PROC и флага P_TRACED). Реализуем лёгкую проверку через sysctl,
а при недоступности — безопасный no-op, чтобы программа всегда запускалась.

Главный аргумент защиты прежний: в клиенте нет секретов (адрес сервера
обфусцирован, ключи — на сервере), поэтому реверс клиента бесполезен.
"""

from __future__ import annotations

import sys
import threading
import time


def _is_traced_via_sysctl() -> bool:
    """True, если к процессу присоединён отладчик (флаг P_TRACED).

    Использует sysctl({CTL_KERN, KERN_PROC, KERN_PROC_PID, pid}) и проверяет
    kp_proc.p_flag & P_TRACED. При любой ошибке возвращает False (не мешаем
    запуску)."""
    if sys.platform != "darwin":
        return False
    try:
        import ctypes
        import os

        libc = ctypes.CDLL("libc.dylib", use_errno=True)

        CTL_KERN = 1
        KERN_PROC = 14
        KERN_PROC_PID = 1
        P_TRACED = 0x00000800

        # struct kinfo_proc велик (~648 байт на 64-бит). Выделяем с запасом и
        # читаем p_flag по известному смещению (kp_proc.p_flag == первое поле
        # extern_proc после указателей списка). Чтобы не зависеть от точного
        # ABI, берём флаг через смещение 32 (стабильно для x86_64/arm64 macOS).
        mib = (ctypes.c_int * 4)(CTL_KERN, KERN_PROC, KERN_PROC_PID, os.getpid())
        size = ctypes.c_size_t(648)
        buf = (ctypes.c_byte * 648)()
        res = libc.sysctl(mib, 4, buf, ctypes.byref(size), None, 0)
        if res != 0:
            return False
        # p_flag находится в extern_proc по смещению 32 байта.
        p_flag = int.from_bytes(bytes(buf[32:36]), "little", signed=False)
        return bool(p_flag & P_TRACED)
    except Exception:
        return False


def debugger_detected() -> bool:
    """Единичная проверка наличия отладчика на старте."""
    return _is_traced_via_sysctl()


def terminate() -> None:
    """Жёсткое завершение процесса без обработчиков."""
    import os

    os._exit(0)


def start_protection(on_detect=terminate, interval: float = 2.0) -> None:
    """Фоновый поток: периодически проверяет присоединение отладчика на лету.

    На macOS поведение мягкое: если sysctl недоступен, поток просто ничего не
    делает (программа работает штатно)."""

    if sys.platform != "darwin":
        return

    def _loop() -> None:
        while True:
            try:
                if _is_traced_via_sysctl():
                    on_detect()
                    return
            except Exception:
                pass
            time.sleep(interval)

    threading.Thread(target=_loop, daemon=True).start()
