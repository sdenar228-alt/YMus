# YMus - build with Nuitka: compiles Python -> C -> native .exe.
# Free, legal, and noticeably stronger than PyInstaller (no .pyc to decompile).
#
# WARNING: the build is slow (C compilation). Always test the result:
#    launch, icons, QML, single-instance, tray, extension update.
#
# Setup (once):
#   py -m pip install --upgrade nuitka
#   (a C compiler is required - Nuitka will offer to download MinGW64, accept it.)
#
# Run:
#   powershell -ExecutionPolicy Bypass -File build_nuitka.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = Resolve-Path (Join-Path $Root "..\..\..")

py -m nuitka `
  --standalone `
  --assume-yes-for-downloads `
  --enable-plugin=pyside6 `
  --include-qt-plugins=qml,imageformats `
  --windows-console-mode=disable `
  --windows-icon-from-ico="$Root\assets\app\ymus.ico" `
  --include-module=pywinauto `
  --include-module=comtypes `
  --include-data-dir="$Root\qml=qml" `
  --include-data-dir="$Root\assets=assets" `
  --include-data-dir="$Repo\YMus=Extension" `
  --output-dir="$Root\dist_nuitka" `
  --output-filename="YMus.exe" `
  "$Root\main.py"

Write-Host "Nuitka build:" -ForegroundColor Yellow
Write-Host "$Root\dist_nuitka\main.dist\YMus.exe"

# Copy the finished program into a handy folder on the Desktop: "YMus Build\YMus".
$Out = Join-Path (Split-Path -Parent $Repo) "YMus Build"
$AppOut = Join-Path $Out "YMus"
if (Test-Path $AppOut) { Remove-Item $AppOut -Recurse -Force }
New-Item -ItemType Directory -Force -Path $AppOut | Out-Null
Copy-Item -Path (Join-Path $Root "dist_nuitka\main.dist\*") -Destination $AppOut -Recurse -Force

Write-Host "Program is ready here:" -ForegroundColor Green
Write-Host "$AppOut\YMus.exe"
Write-Host "Test: launch, icons, QML, tray, extension update." -ForegroundColor Yellow
