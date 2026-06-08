"""Базовый рантайм anti-debug для YMus.

ВАЖНО (честно): в открытом виде эти проверки снимаются тривиально (патч
байткода). Реальную силу они приобретают ТОЛЬКО под PyArmor (он шифрует
байткод и прячет эти ветки). Здесь — надёжные, без ложных срабатываний у
обычных пользователей: только достоверные WinAPI-признаки присоединённого
отладчика. Никакого сканирования процессов/анти-VM, чтобы не ломать легитимный
запуск.
"""
from __future__ import annotations

import ctypes
import os
import sys
import threading
import time


def _is_debugger_present() -> bool:
    if sys.platform != "win32":
        return False
    try:
        k32 = ctypes.windll.kernel32
        k32.IsDebuggerPresent.restype = ctypes.c_int
        if k32.IsDebuggerPresent():
            return True

        k32.GetCurrentProcess.restype = ctypes.c_void_p
        k32.CheckRemoteDebuggerPresent.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
        k32.CheckRemoteDebuggerPresent.restype = ctypes.c_int
        present = ctypes.c_int(0)
        k32.CheckRemoteDebuggerPresent(k32.GetCurrentProcess(), ctypes.byref(present))
        if present.value:
            return True
    except Exception:
        return False
    return False


def _debug_port_present() -> bool:
    """NtQueryInformationProcess(ProcessDebugPort) != 0 → присоединён отладчик."""
    if sys.platform != "win32":
        return False
    try:
        ntdll = ctypes.windll.ntdll
        k32 = ctypes.windll.kernel32
        k32.GetCurrentProcess.restype = ctypes.c_void_p
        ntdll.NtQueryInformationProcess.argtypes = [
            ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p
        ]
        ntdll.NtQueryInformationProcess.restype = ctypes.c_long
        ProcessDebugPort = 7
        port = ctypes.c_void_p(0)
        status = ntdll.NtQueryInformationProcess(
            k32.GetCurrentProcess(),
            ProcessDebugPort,
            ctypes.byref(port),
            ctypes.sizeof(port),
            None,
        )
        return status == 0 and bool(port.value)
    except Exception:
        return False


def debugger_detected() -> bool:
    return _is_debugger_present() or _debug_port_present()


def start_protection(on_detect) -> None:
    """Однократная проверка + фоновый поток периодической проверки.
    При обнаружении отладчика вызывает on_detect()."""
    if debugger_detected():
        on_detect()
        return

    def worker() -> None:
        while True:
            try:
                if debugger_detected():
                    on_detect()
                    return
            except Exception:
                pass
            time.sleep(2.0)

    threading.Thread(target=worker, daemon=True).start()


def terminate() -> None:
    """Немедленный выход без обработчиков (труднее перехватить)."""
    try:
        os._exit(0)
    except Exception:
        sys.exit(0)
