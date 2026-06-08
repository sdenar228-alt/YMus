using System.Windows;
using System.Windows.Input;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using YMus.Wpf.ViewModels;

namespace YMus.Wpf;

public partial class MainWindow : Window
{
    private readonly DispatcherTimer _backgroundTimer = new();
    private double _tick;

    public MainWindow()
    {
        InitializeComponent();
        DataContext = new MainWindowViewModel();

        _backgroundTimer.Interval = TimeSpan.FromMilliseconds(33);
        _backgroundTimer.Tick += OnBackgroundTick;
        Loaded += OnLoaded;
        Closed += (_, _) => _backgroundTimer.Stop();
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        _backgroundTimer.Start();
        await Task.Delay(520);

        var fade = new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(420))
        {
            FillBehavior = FillBehavior.Stop
        };
        fade.Completed += (_, _) =>
        {
            StartupOverlay.Opacity = 0;
            StartupOverlay.Visibility = Visibility.Collapsed;
        };
        StartupOverlay.BeginAnimation(OpacityProperty, fade);
    }

    private void OnBackgroundTick(object? sender, EventArgs e)
    {
        _tick += 0.018;
        BackgroundTransform.X = Math.Sin(_tick) * 18;
        BackgroundTransform.Y = Math.Cos(_tick * 0.7) * 10;
        GlowOne.Opacity = 0.48 + Math.Sin(_tick * 1.3) * 0.16;
        GlowTwo.Opacity = 0.42 + Math.Cos(_tick * 1.1) * 0.15;
    }

    private void TopBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2)
        {
            ToggleMaximize();
            return;
        }

        DragMove();
    }

    private void MinimizeButton_Click(object sender, RoutedEventArgs e)
    {
        WindowState = WindowState.Minimized;
    }

    private void CloseButton_Click(object sender, RoutedEventArgs e)
    {
        Close();
    }

    private void ToggleMaximize()
    {
        WindowState = WindowState == WindowState.Maximized
            ? WindowState.Normal
            : WindowState.Maximized;
    }
}
