# YMus Qt

Qt Quick / QML prototype for the YMus Windows manager.

## Run

```powershell
py YMusProg/Windows/QtApp/main.py
```

## Build

```powershell
powershell -ExecutionPolicy Bypass -File YMusProg/Windows/QtApp/build.ps1
```

Output:

```text
YMusProg\Windows\QtApp\dist\YMus\YMus.exe
```

## Stack

- Python 3.12
- PySide6 / Qt Quick / QML
- PyInstaller

The app prepares the unpacked extension folder in `%LOCALAPPDATA%\YMus\extensions\chromium\current`, copies that path to clipboard, and opens the selected browsers' extension pages.
