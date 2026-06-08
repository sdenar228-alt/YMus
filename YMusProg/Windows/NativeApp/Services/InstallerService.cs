using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Win32;
using YMus.Native.Models;

namespace YMus.Native.Services;

public sealed class InstallerService
{
    public const string ExtensionId = "kamgbpbgdfkdjdgbimepdlmcckggijbh";
    public const string ExtensionVersion = "1.1.2";
    public const string CrxSha256 = "9e9c57dc845ae703bd87f70ae7db679e664600c5d90ac85c722a87e0c7856757";
    public const string UpdateUrl = "https://updates.ymus.tech/ymus/chromium/update.xml";

    private sealed record BrowserDefinition(
        string Id,
        string Name,
        string Engine,
        string InstallMode,
        string ExtensionsUrl,
        IReadOnlyList<string> Candidates);

    public IReadOnlyList<BrowserItem> DetectBrowsers()
    {
        return BrowserDefinitions()
            .Select(def =>
            {
                var path = def.Candidates.FirstOrDefault(File.Exists);
                return new BrowserItem
                {
                    Id = def.Id,
                    Name = def.Name,
                    Engine = def.Engine,
                    InstallMode = def.InstallMode,
                    ExtensionsUrl = def.ExtensionsUrl,
                    Path = path,
                    Installed = path is not null,
                    IsSelected = path is not null && def.Engine == "Chromium"
                };
            })
            .ToList();
    }

    public PreparedPackage PrepareCrx()
    {
        var bytes = ReadEmbeddedCrx();
        var hash = Sha256Hex(bytes);
        if (!hash.Equals(CrxSha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("CRX не прошёл проверку SHA-256.");

        var root = Path.Combine(LocalAppData(), "YMus", "packages", "chromium");
        Directory.CreateDirectory(root);
        var target = Path.Combine(root, $"YMus-{ExtensionVersion}-{ExtensionId}.crx");
        var staging = Path.Combine(root, "YMus-staging.crx");

        File.WriteAllBytes(staging, bytes);
        var writtenHash = Sha256Hex(File.ReadAllBytes(staging));
        if (!writtenHash.Equals(CrxSha256, StringComparison.OrdinalIgnoreCase))
        {
            File.Delete(staging);
            throw new InvalidOperationException("Сохранённый CRX не прошёл проверку SHA-256.");
        }

        if (File.Exists(target))
            File.Delete(target);
        File.Move(staging, target);

        return new PreparedPackage(target, ExtensionVersion, ExtensionId, CrxSha256, UpdateUrl, "crx");
    }

    public PreparedPackage PrepareUnpacked()
    {
        var source = FindExtensionSource();
        var manifestPath = Path.Combine(source, "manifest.json");
        var manifest = JsonSerializer.Deserialize<ExtensionManifest>(File.ReadAllText(manifestPath))
            ?? throw new InvalidOperationException("Не удалось прочитать manifest.json.");

        var root = Path.Combine(LocalAppData(), "YMus", "extensions", "chromium");
        var current = Path.Combine(root, "current");
        var staging = Path.Combine(root, "staging");
        var backup = Path.Combine(root, "previous");
        Directory.CreateDirectory(root);

        if (Directory.Exists(staging))
            Directory.Delete(staging, true);
        CopyDirectory(source, staging);

        if (!File.Exists(Path.Combine(staging, "manifest.json")))
            throw new InvalidOperationException("В подготовленной папке отсутствует manifest.json.");

        if (Directory.Exists(backup))
            Directory.Delete(backup, true);
        if (Directory.Exists(current))
            Directory.Move(current, backup);

        try
        {
            Directory.Move(staging, current);
        }
        catch
        {
            if (Directory.Exists(backup) && !Directory.Exists(current))
                Directory.Move(backup, current);
            throw;
        }

        if (Directory.Exists(backup))
            Directory.Delete(backup, true);

        return new PreparedPackage(current, manifest.Version, ExtensionId, string.Empty, string.Empty, "unpacked");
    }

    public void InstallPolicy(BrowserItem browser, string crxPath)
    {
        EnsureChromium(browser);
        var fullPath = Path.GetFullPath(crxPath);
        if (!File.Exists(fullPath) || !Path.GetExtension(fullPath).Equals(".crx", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Файл CRX не найден.");

        var hash = Sha256Hex(File.ReadAllBytes(fullPath));
        if (!hash.Equals(CrxSha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("CRX не прошёл проверку SHA-256.");

        var keyPath = PolicyKey(browser.Id);
        using var key = Registry.CurrentUser.CreateSubKey(keyPath, true)
            ?? throw new InvalidOperationException($"Не удалось открыть HKCU\\{keyPath}.");
        var policyValue = $"{ExtensionId};{UpdateUrl}";
        var valueName = PolicyValueName(key, policyValue);
        key.SetValue(valueName, policyValue, RegistryValueKind.String);
        OpenExtensionsPage(browser);
    }

    public void LaunchWithExtension(BrowserItem browser, string unpackedPath, bool isolated)
    {
        EnsureChromium(browser);
        var folder = ValidateUnpackedPath(unpackedPath);
        var args = new List<string>();
        if (isolated)
        {
            var profile = Path.Combine(LocalAppData(), "YMus", "browser-sessions", browser.Id);
            Directory.CreateDirectory(profile);
            args.Add($"--user-data-dir=\"{profile}\"");
            args.Add("--no-first-run");
            args.Add("--no-default-browser-check");
            args.Add($"--disable-extensions-except=\"{folder}\"");
        }
        args.Add($"--load-extension=\"{folder}\"");
        args.Add("--new-window");
        args.Add(browser.ExtensionsUrl);
        StartBrowser(browser.Path!, string.Join(" ", args));
    }

    public void OpenExtensionsPage(BrowserItem browser)
    {
        if (browser.Path is null)
            throw new InvalidOperationException($"{browser.Name} не найден.");
        StartBrowser(browser.Path, $"--new-window {browser.ExtensionsUrl}");
    }

    public void CopyToClipboard(string value)
    {
        var escaped = value.Replace("'", "''");
        StartHidden("powershell.exe", $"-NoProfile -WindowStyle Hidden -Command \"Set-Clipboard -Value '{escaped}'\"");
    }

    public void OpenFolder(string path)
    {
        var full = Path.GetFullPath(path);
        var args = File.Exists(full) ? $"/select,\"{full}\"" : $"\"{full}\"";
        StartHidden("explorer.exe", args);
    }

    public string ValidateUnpackedPath(string unpackedPath)
    {
        var folder = Path.GetFullPath(unpackedPath);
        if (!Directory.Exists(folder) || !File.Exists(Path.Combine(folder, "manifest.json")))
            throw new InvalidOperationException("Папка распакованного расширения повреждена.");
        return folder;
    }

    private static IReadOnlyList<BrowserDefinition> BrowserDefinitions()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);

        return
        [
            new("yandex", "Яндекс Браузер", "Chromium", "Распакованное расширение",
                "browser://extensions/",
                [Path.Combine(local, "Yandex", "YandexBrowser", "Application", "browser.exe"),
                 Path.Combine(programFiles, "Yandex", "YandexBrowser", "Application", "browser.exe")]),
            new("chrome", "Google Chrome", "Chromium", "Распакованное расширение",
                "chrome://extensions/",
                [Path.Combine(local, "Google", "Chrome", "Application", "chrome.exe"),
                 Path.Combine(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
                 Path.Combine(programFilesX86, "Google", "Chrome", "Application", "chrome.exe")]),
            new("edge", "Microsoft Edge", "Chromium", "Распакованное расширение",
                "browser://extensions/",
                [Path.Combine(local, "Microsoft", "Edge", "Application", "msedge.exe"),
                 Path.Combine(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
                 Path.Combine(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe")]),
            new("brave", "Brave", "Chromium", "Распакованное расширение",
                "browser://extensions/",
                [Path.Combine(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
                 Path.Combine(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
                 Path.Combine(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")]),
            new("opera", "Opera", "Chromium", "Распакованное расширение",
                "browser://extensions/",
                [Path.Combine(local, "Programs", "Opera", "opera.exe"),
                 Path.Combine(roaming, "Opera Software", "Opera Stable", "opera.exe")]),
            new("firefox", "Mozilla Firefox", "Firefox", "Поддержка появится позже",
                "about:addons",
                [Path.Combine(programFiles, "Mozilla Firefox", "firefox.exe"),
                 Path.Combine(programFilesX86, "Mozilla Firefox", "firefox.exe"),
                 Path.Combine(local, "Mozilla Firefox", "firefox.exe")])
        ];
    }

    private static void EnsureChromium(BrowserItem browser)
    {
        if (!browser.Installed || browser.Path is null)
            throw new InvalidOperationException($"{browser.Name} не установлен.");
        if (browser.Engine != "Chromium")
            throw new InvalidOperationException("Действие доступно только для Chromium-браузеров.");
    }

    private static string PolicyKey(string browserId) => browserId switch
    {
        "chrome" => @"Software\Policies\Google\Chrome\ExtensionInstallForcelist",
        "edge" => @"Software\Policies\Microsoft\Edge\ExtensionInstallForcelist",
        "brave" => @"Software\Policies\BraveSoftware\Brave\ExtensionInstallForcelist",
        "yandex" => @"Software\Policies\YandexBrowser\ExtensionInstallForcelist",
        _ => throw new InvalidOperationException("Установка через policy не поддерживается этим браузером.")
    };

    private static string PolicyValueName(RegistryKey key, string policyValue)
    {
        foreach (var name in key.GetValueNames())
        {
            var value = key.GetValue(name)?.ToString();
            if (value == policyValue || value?.StartsWith($"{ExtensionId};", StringComparison.OrdinalIgnoreCase) == true)
                return name;
        }

        for (var i = 1; i <= 200; i++)
        {
            var name = i.ToString();
            if (key.GetValue(name) is null)
                return name;
        }

        return "200";
    }

    private static byte[] ReadEmbeddedCrx()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("YMus.crx")
            ?? throw new InvalidOperationException("Встроенный файл YMus.crx не найден.");
        using var memory = new MemoryStream();
        stream.CopyTo(memory);
        return memory.ToArray();
    }

    private static string FindExtensionSource()
    {
        var bundled = Path.Combine(AppContext.BaseDirectory, "Extension");
        if (File.Exists(Path.Combine(bundled, "manifest.json")))
            return bundled;

        var roots = new List<string>();
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            roots.Add(dir.FullName);
            dir = dir.Parent;
        }

        foreach (var root in roots)
        {
            var nested = Path.Combine(root, "YMus");
            if (File.Exists(Path.Combine(nested, "manifest.json")))
                return nested;
            if (File.Exists(Path.Combine(root, "manifest.json")))
                return root;
        }

        var repo = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", ".."));
        var candidate = Path.Combine(repo, "YMus");
        if (File.Exists(Path.Combine(candidate, "manifest.json")))
            return candidate;

        throw new InvalidOperationException("Не найдена локальная сборка расширения YMus.");
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.EnumerateFiles(source))
            File.Copy(file, Path.Combine(destination, Path.GetFileName(file)), true);
        foreach (var directory in Directory.EnumerateDirectories(source))
            CopyDirectory(directory, Path.Combine(destination, Path.GetFileName(directory)));
    }

    private static string Sha256Hex(byte[] bytes)
        => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static string LocalAppData()
        => Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

    private static void StartHidden(string fileName, string arguments)
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        });
    }

    private static void StartBrowser(string fileName, string arguments)
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            UseShellExecute = false,
            CreateNoWindow = false,
            WindowStyle = ProcessWindowStyle.Normal
        });
    }

    private sealed class ExtensionManifest
    {
        [JsonPropertyName("version")]
        public string Version { get; init; } = "0.0.0";
    }
}
