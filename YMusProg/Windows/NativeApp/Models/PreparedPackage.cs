namespace YMus.Native.Models;

public sealed record PreparedPackage(
    string Path,
    string Version,
    string ExtensionId,
    string Sha256,
    string UpdateUrl,
    string PackageType);

