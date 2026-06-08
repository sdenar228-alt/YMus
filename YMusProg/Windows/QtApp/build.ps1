$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = Resolve-Path (Join-Path $Root "..\..\..")

# Путь к установленному PySide6 — нужен, чтобы явно вложить Qt SVG-плагин.
# Без него в собранном .exe не рендерятся SVG-иконки (папка, браузеры,
# навигация): PyInstaller не всегда тянет qsvg.dll + Qt6Svg.dll автоматически.
$PySide = (py -c "import PySide6,os;print(os.path.dirname(PySide6.__file__))").Trim()

py -m PyInstaller `
  --noconfirm `
  --clean `
  --windowed `
  --name YMus `
  --distpath "$Root\dist" `
  --workpath "$Root\build" `
  --specpath "$Root" `
  --icon "$Root\assets\app\ymus.ico" `
  --collect-submodules pywinauto `
  --collect-submodules comtypes `
  --hidden-import win32timezone `
  --hidden-import PySide6.QtSvg `
  --add-data "$PySide\plugins\imageformats;PySide6\plugins\imageformats" `
  --add-binary "$PySide\Qt6Svg.dll;PySide6" `
  --add-data "$Root\qml;qml" `
  --add-data "$Root\assets;assets" `
  --add-data "$Repo\YMus;Extension" `
  "$Root\main.py"

Write-Host "Build ready:" -ForegroundColor Yellow
Write-Host "$Root\dist\YMus\YMus.exe"
