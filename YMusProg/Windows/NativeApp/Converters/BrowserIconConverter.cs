using System.Globalization;
using Avalonia.Data.Converters;
using Avalonia.Media.Imaging;
using Avalonia.Platform;

namespace YMus.Native.Converters;

public sealed class BrowserIconConverter : IValueConverter
{
    private readonly Dictionary<string, Bitmap> _cache = [];

    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        if (value is not string id || string.IsNullOrWhiteSpace(id))
            return null;

        if (_cache.TryGetValue(id, out var cached))
            return cached;

        var uri = new Uri($"avares://YMus.Native/Assets/Browsers/{id}.png");
        using var stream = AssetLoader.Open(uri);
        var bitmap = new Bitmap(stream);
        _cache[id] = bitmap;
        return bitmap;
    }

    public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => throw new NotSupportedException();
}
