using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Input;
using Avalonia.Media;
using Avalonia.Threading;
using System.Runtime.InteropServices;

namespace YMus.Native.Views;

public partial class MainWindow : Window
{
    private readonly DispatcherTimer _backgroundTimer = new();
    private double _backgroundTick;

    public MainWindow()
    {
        InitializeComponent();
        Opened += OnOpened;
        Closed += (_, _) => _backgroundTimer.Stop();
        _backgroundTimer.Interval = TimeSpan.FromMilliseconds(33);
        _backgroundTimer.Tick += OnBackgroundTick;
    }

    private async void OnOpened(object? sender, EventArgs e)
    {
        Topmost = true;
        Activate();
        BringToFront();
        _backgroundTimer.Start();

        await Task.Delay(520);
        StartupOverlay.Opacity = 0;

        await Task.Delay(110);
        TopBar.Opacity = 1;

        await Task.Delay(120);
        MainContent.Opacity = 1;

        await Task.Delay(430);
        StartupOverlay.IsVisible = false;
        BringToFront();
        Topmost = false;
    }

    private void OnBackgroundTick(object? sender, EventArgs e)
    {
        _backgroundTick += 0.018;
        if (AnimatedBackground.RenderTransform is TranslateTransform motion)
        {
            motion.X = Math.Sin(_backgroundTick) * 18;
            motion.Y = Math.Cos(_backgroundTick * 0.7) * 10;
        }
        GlowOne.Opacity = 0.55 + Math.Sin(_backgroundTick * 1.4) * 0.2;
        GlowTwo.Opacity = 0.45 + Math.Cos(_backgroundTick * 1.1) * 0.18;
    }

    private void BringToFront()
    {
        var handle = TryGetPlatformHandle()?.Handle ?? IntPtr.Zero;
        if (handle == IntPtr.Zero)
            return;

        ShowWindow(handle, 9);
        BringWindowToTop(handle);
        SetForegroundWindow(handle);
    }

    private void MinimizeButton_Click(object? sender, RoutedEventArgs e)
    {
        WindowState = WindowState.Minimized;
    }

    private void MaximizeButton_Click(object? sender, RoutedEventArgs e)
    {
        WindowState = WindowState == WindowState.Maximized
            ? WindowState.Normal
            : WindowState.Maximized;
    }

    private void CloseButton_Click(object? sender, RoutedEventArgs e)
    {
        Close();
    }

    private void TopBar_PointerPressed(object? sender, PointerPressedEventArgs e)
    {
        if (e.GetCurrentPoint(this).Properties.IsLeftButtonPressed)
            BeginMoveDrag(e);
    }

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
