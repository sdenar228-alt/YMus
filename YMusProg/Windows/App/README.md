# YMus Desktop for Windows

Windows-приложение для установки подписанного CRX-пакета YMus в Chromium-браузеры.

## Что уже делает приложение

- находит Yandex Browser, Google Chrome, Microsoft Edge, Brave, Opera и Firefox;
- выбирает установленные Chromium-браузеры;
- готовит встроенный `YMus.crx` в `%LOCALAPPDATA%\YMus\packages\chromium`;
- готовит распакованную копию расширения в `%LOCALAPPDATA%\YMus\extensions\chromium\current`;
- сверяет SHA-256 перед подготовкой и перед установкой;
- использует стабильный extension ID `kamgbpbgdfkdjdgbimepdlmcckggijbh`;
- прописывает Chromium `ExtensionInstallForcelist` policy с update URL `https://updates.ymus.tech/ymus/chromium/update.xml`;
- запускает Chromium-браузер с `--load-extension`;
- запускает отдельный Chromium-профиль с YMus;
- открывает страницу расширений выбранного браузера для ручного fallback;
- содержит экспериментальный UI-мастер для попытки загрузки unpacked-папки через `chrome://extensions`.

## Ограничение Chromium

Chrome, Edge и некоторые другие Chromium-браузеры могут принимать self-hosted CRX через policy только в управляемой или корпоративной среде. Приложение делает корректную policy-установку, но финальное решение все равно принимает браузер.

Автоматизация `chrome://extensions` через UI-мастер не является официальным API браузера. Она зависит от языка интерфейса, порядка фокуса, версии браузера и активного окна, поэтому должна считаться экспериментальным fallback.

## Запуск разработки

```powershell
npm install
npm run tauri dev
```

## Проверка

```powershell
npm run build
cargo test
cargo check
```

## Сборка NSIS

```powershell
npm run tauri build
```

Готовый установщик появляется в `src-tauri\target\release\bundle\nsis`.
