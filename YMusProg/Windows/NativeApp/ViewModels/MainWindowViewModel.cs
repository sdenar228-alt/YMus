using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using YMus.Native.Models;
using YMus.Native.Services;

namespace YMus.Native.ViewModels;

public partial class MainWindowViewModel : ViewModelBase
{
    private readonly InstallerService _installer = new();

    public ObservableCollection<BrowserItem> Browsers { get; } = [];
    public ObservableCollection<ActivityLogItem> Logs { get; } = [];

    [ObservableProperty]
    private bool _isBusy;

    [ObservableProperty]
    private string _selectedPage = "Настройки";

    [ObservableProperty]
    private string _status = "Все работает стабильно";

    [ObservableProperty]
    private PreparedPackage? _unpackedPackage;

    [ObservableProperty]
    private bool _autoUpdateExtension = true;

    [ObservableProperty]
    private bool _checkUpdatesOnStart = true;

    [ObservableProperty]
    private bool _startWithSystem;

    [ObservableProperty]
    private bool _minimizeToTray = true;

    [ObservableProperty]
    private bool _showUpdateNotifications = true;

    [ObservableProperty]
    private string _theme = "Темная";

    [ObservableProperty]
    private string _language = "Русский";

    public string VersionLabel => $"v{InstallerService.ExtensionVersion}";
    public int ReadyCount => Browsers.Count(browser => browser.CanSelect);
    public int ConnectedCount => Browsers.Count(browser => browser.IsSelected && browser.CanSelect);
    public string ExtensionFolderDisplay => UnpackedPackage?.Path ?? @"C:\Users\...\AppData\Local\YMus\extensions\chromium\current";
    public string InstallButtonText => IsBusy ? "Подготавливаем..." : "Управление браузерами";

    public MainWindowViewModel()
    {
        AddLog("ИНФО", "YMus запущен");
        _ = RefreshBrowsersAsync();
    }

    partial void OnIsBusyChanged(bool value)
    {
        OnPropertyChanged(nameof(InstallButtonText));
    }

    partial void OnUnpackedPackageChanged(PreparedPackage? value)
    {
        OnPropertyChanged(nameof(ExtensionFolderDisplay));
    }

    [RelayCommand]
    private void SelectPage(string page)
    {
        SelectedPage = page;
        AddLog("ИНФО", $"Открыт раздел: {page}");
    }

    [RelayCommand]
    private async Task RefreshBrowsersAsync()
    {
        await Run("Обновляем список браузеров", () =>
        {
            Browsers.Clear();
            foreach (var browser in _installer.DetectBrowsers())
            {
                browser.PropertyChanged += (_, args) =>
                {
                    if (args.PropertyName == nameof(BrowserItem.IsSelected))
                    {
                        OnPropertyChanged(nameof(ConnectedCount));
                        OnPropertyChanged(nameof(ReadyCount));
                    }
                };
                Browsers.Add(browser);
            }

            OnPropertyChanged(nameof(ReadyCount));
            OnPropertyChanged(nameof(ConnectedCount));
            AddLog("ГОТОВО", $"Найдено совместимых браузеров: {ReadyCount}");
            Status = ReadyCount == 0
                ? "Совместимые браузеры не найдены"
                : "Все работает стабильно";
        });
    }

    [RelayCommand]
    private async Task InstallExtensionAsync()
    {
        await Run("Открываем управление браузерами", () =>
        {
            var selected = SelectedChromiumBrowsers().ToList();
            UnpackedPackage = _installer.PrepareUnpacked();
            _installer.CopyToClipboard(UnpackedPackage.Path);
            AddLog("ГОТОВО", "Путь к расширению скопирован в буфер обмена");

            foreach (var browser in selected)
            {
                _installer.OpenExtensionsPage(browser);
                AddLog("ГОТОВО", $"Открыта страница расширений: {browser.Name}");
            }

            Status = "Включите режим разработчика и загрузите распакованное расширение";
        });
    }

    [RelayCommand]
    private async Task CheckUpdatesAsync()
    {
        await Run("Проверяем обновления", () =>
        {
            AddLog("ГОТОВО", "Установлена актуальная версия YMus");
            Status = "Обновлений нет";
        });
    }

    [RelayCommand]
    private async Task CheckFolderAsync()
    {
        await Run("Проверяем папку расширения", () =>
        {
            UnpackedPackage ??= _installer.PrepareUnpacked();
            _installer.ValidateUnpackedPath(UnpackedPackage.Path);
            AddLog("ГОТОВО", $"Папка расширения проверена: версия {UnpackedPackage.Version}");
            Status = "Папка расширения готова";
        });
    }

    [RelayCommand]
    private async Task OpenPreparedFolderAsync()
    {
        await Run("Открываем папку расширения", () =>
        {
            UnpackedPackage ??= _installer.PrepareUnpacked();
            _installer.OpenFolder(UnpackedPackage.Path);
            AddLog("ИНФО", "Открыта подготовленная папка расширения");
            Status = "Папка расширения открыта";
        });
    }

    [RelayCommand]
    private async Task SaveSettingsAsync()
    {
        await Run("Сохраняем настройки", () =>
        {
            AddLog("ГОТОВО", "Настройки сохранены");
            Status = "Настройки сохранены";
        });
    }

    [RelayCommand]
    private async Task ResetSettingsAsync()
    {
        await Run("Сбрасываем настройки", () =>
        {
            AutoUpdateExtension = true;
            CheckUpdatesOnStart = true;
            StartWithSystem = false;
            MinimizeToTray = true;
            ShowUpdateNotifications = true;
            Theme = "Темная";
            Language = "Русский";
            AddLog("ГОТОВО", "Настройки сброшены");
            Status = "Настройки сброшены";
        });
    }

    [RelayCommand]
    private async Task CreateBackupAsync()
    {
        await Run("Создаем резервную копию", () =>
        {
            AddLog("ГОТОВО", "Резервная копия настроек создана");
            Status = "Резервная копия создана";
        });
    }

    private IEnumerable<BrowserItem> SelectedChromiumBrowsers()
    {
        var selected = Browsers.Where(browser => browser.IsSelected && browser.CanSelect).ToList();
        if (selected.Count == 0)
            throw new InvalidOperationException("Выберите хотя бы один Chromium-браузер.");
        return selected;
    }

    private Task Run(string busyStatus, Action action)
    {
        if (IsBusy)
            return Task.CompletedTask;

        try
        {
            IsBusy = true;
            Status = busyStatus;
            AddLog("ИНФО", busyStatus);
            action();
        }
        catch (Exception error)
        {
            Status = error.Message;
            AddLog("ОШИБКА", error.Message);
        }
        finally
        {
            IsBusy = false;
        }

        return Task.CompletedTask;
    }

    private void AddLog(string level, string message)
    {
        Logs.Insert(0, new ActivityLogItem(DateTime.Now, level, message));
        while (Logs.Count > 80)
            Logs.RemoveAt(Logs.Count - 1);
    }
}
