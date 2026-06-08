using CommunityToolkit.Mvvm.ComponentModel;

namespace YMus.Wpf.Models;

public partial class BrowserItem : ObservableObject
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Engine { get; init; }
    public required string InstallMode { get; init; }
    public required string ExtensionsUrl { get; init; }
    public string? Path { get; init; }
    public bool Installed { get; init; }
    public bool CanSelect => Installed && Engine == "Chromium";
    public string IconPath => $"pack://application:,,,/Assets/Browsers/{Id}.png";
    public string ConnectionStatus => CanSelect ? "Подключен" : "Не найден";
    public string ConnectionBrush => CanSelect ? "#54D85C" : "#FFD400";
    public string Mark => Id switch
    {
        "yandex" => "Y",
        "chrome" => "C",
        "edge" => "E",
        "brave" => "B",
        "opera" => "O",
        "firefox" => "F",
        _ => Name[..1]
    };
    public string Status => Installed ? (CanSelect ? "Готов" : "Не поддерживается") : "Не найден";

    [ObservableProperty]
    private bool _isSelected;
}
