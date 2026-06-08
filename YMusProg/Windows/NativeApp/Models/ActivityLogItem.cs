namespace YMus.Native.Models;

public sealed record ActivityLogItem(DateTime Time, string Level, string Message)
{
    public string Stamp => Time.ToString("HH:mm:ss");
}
