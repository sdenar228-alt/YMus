# YMus — ЗАЩИЩЁННАЯ сборка: PyArmor (обфускация/шифрование байткода) + PyInstaller.
#
# ⚠️ ЭКСПЕРИМЕНТАЛЬНО — обязательно протестируй результат (запуск, иконки, QML,
#    обновление). PyArmor + PyInstaller + PySide6/QML — связка капризная.
#
# Подготовка (один раз):
#   py -m pip install --upgrade pyarmor
#
# Сила защиты:
#   - Бесплатный PyArmor: умеренная обфускация байткода (снимается опытным
#     реверсером, но это уже не "decompyle за минуту").
#   - PyArmor Pro (платно): режимы BCC (байткод → C) и RFT + рантайм anti-debug
#     — это и есть "сильная" защита. Включается флагами `--enable-bcc --enable-rft`.
#
# Запуск:
#   powershell -ExecutionPolicy Bypass -File build_protected.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = Resolve-Path (Join-Path $Root "..\..\..")
$Obf  = Join-Path $Root "obf"
$PySide = (py -c "import PySide6,os;print(os.path.dirname(PySide6.__file__))").Trim()

# 1. Обфускация исходников PyArmor'ом в папку obf/ (вместе с зависимостями).
#    Для Pro добавь:  --enable-bcc --enable-rft  (сильнее, но обязательно тестить)
if (Test-Path $Obf) { Remove-Item -Recurse -Force $Obf }
py -m pyarmor gen --output "$Obf" --recursive `
  "$Root\main.py" "$Root\backend.py" "$Root\guard.py"

# 2. PyInstaller по обфусцированному main.py. --paths указывает на obf/, чтобы
#    нашёлся pyarmor_runtime_* (его подтягивает обфусцированный код).
py -m PyInstaller `
  --noconfirm `
  --clean `
  --windowed `
  --name YMus `
  --distpath "$Root\dist" `
  --workpath "$Root\build" `
  --specpath "$Root" `
  --icon "$Root\assets\app\ymus.ico" `
  --paths "$Obf" `
  --collect-submodules pywinauto `
  --collect-submodules comtypes `
  --hidden-import win32timezone `
  --hidden-import PySide6.QtSvg `
  --add-data "$PySide\plugins\imageformats;PySide6\plugins\imageformats" `
  --add-binary "$PySide\Qt6Svg.dll;PySide6" `
  --add-data "$Root\qml;qml" `
  --add-data "$Root\assets;assets" `
  --add-data "$Repo\YMus;Extension" `
  "$Obf\main.py"

Write-Host "Protected build ready:" -ForegroundColor Yellow
Write-Host "$Root\dist\YMus\YMus.exe"
Write-Host "Проверь запуск, иконки, обновление расширения." -ForegroundColor Yellow
