$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = Resolve-Path (Join-Path $Root "..\..\..")
$Out = Join-Path (Split-Path -Parent $Repo) "YMus Build"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Payload = Join-Path $Root "payload.zip"
# Nuitka standalone build (Python -> C). The main.dist folder contains YMus.exe and all dependencies.
$AppDist = Join-Path $Root "dist_nuitka\main.dist"

if (!(Test-Path (Join-Path $AppDist "YMus.exe"))) {
  throw "Build YMus first: dist_nuitka\main.dist\YMus.exe not found. Run build_nuitka.ps1."
}

if (Test-Path $Payload) {
  Remove-Item $Payload -Force
}

Compress-Archive -Path (Join-Path $AppDist "*") -DestinationPath $Payload -Force

py -m PyInstaller `
  --noconfirm `
  --clean `
  --onefile `
  --windowed `
  --name YMusSetup `
  --distpath "$Out" `
  --workpath "$Root\build_setup" `
  --specpath "$Root" `
  --icon "$Root\assets\app\ymus.ico" `
  --add-data "$Root\assets;assets" `
  --add-data "$Payload;." `
  "$Root\installer.py"

Write-Host "Setup ready:" -ForegroundColor Green
Write-Host "$Out\YMusSetup.exe"
