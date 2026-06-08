#!/usr/bin/env bash
# Локальная сборка YMus.app + YMus.dmg на macOS (Apple Silicon).
# Запускать НА Mac из корня репозитория:  bash YMusProg/MacOS/QtApp/build_mac.sh
#
# Требуется: Python 3.12, Node 20, Xcode CLT.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

echo "==> Сборка расширения (офлайн-фолбэк)"
npm ci
npm run build
test -f YMus/manifest.json

echo "==> Установка зависимостей сборки"
python3 -m pip install --upgrade pip
python3 -m pip install "PySide6==6.7.*" pyinstaller

echo "==> Иконка"
ICON_ARG=""
if sips -s format icns "YMusProg/Windows/QtApp/assets/app/Icon128x128.png" --out "ymus.icns" 2>/dev/null; then
  ICON_ARG="--icon ymus.icns"
fi

echo "==> Сборка .app"
pyinstaller --noconfirm --windowed --name YMus \
  $ICON_ARG \
  --paths "YMusProg/MacOS/QtApp" \
  --add-data "YMusProg/Windows/QtApp/qml:qml" \
  --add-data "YMusProg/Windows/QtApp/assets:assets" \
  --add-data "YMus:Extension" \
  --osx-bundle-identifier "tech.ymus.app" \
  "YMusProg/MacOS/QtApp/main.py"

echo "==> Упаковка .dmg"
rm -rf dmgroot YMus.dmg
mkdir -p dmgroot
cp -R "dist/YMus.app" dmgroot/
ln -s /Applications dmgroot/Applications
hdiutil create -volname "YMus" -srcfolder dmgroot -ov -format UDZO "YMus.dmg"

echo "==> Готово: $REPO_ROOT/YMus.dmg"
