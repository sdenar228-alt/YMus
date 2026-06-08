# YMus Native Windows

Native Windows installer shell for YMus, built with .NET and Avalonia UI.

## What it does

- detects Chromium browsers installed on the PC;
- verifies embedded `YMus.crx` with SHA-256;
- prepares an unpacked extension copy in `%LOCALAPPDATA%\YMus`;
- can write Chromium `ExtensionInstallForcelist` policy for signed CRX installation;
- can launch selected browsers with `--load-extension`;
- includes diagnostics buttons for CRX and unpacked package checks.

## Build

```powershell
dotnet build YMusProg/Windows/NativeApp/YMus.Native.csproj
```

## Publish

```powershell
dotnet publish YMusProg/Windows/NativeApp/YMus.Native.csproj -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true
```

Published app:

```text
YMusProg\Windows\NativeApp\bin\Release\net10.0-windows\win-x64\publish\YMus.Native.exe
```

## Current extension package

- Version: `1.1.2`
- Extension ID: `kamgbpbgdfkdjdgbimepdlmcckggijbh`
- Update URL: `https://updates.ymus.tech/ymus/chromium/update.xml`
- CRX SHA-256: `9e9c57dc845ae703bd87f70ae7db679e664600c5d90ac85c722a87e0c7856757`
