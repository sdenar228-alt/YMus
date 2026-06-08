use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env,
    fs,
    path::{Path, PathBuf},
    process::Command,
};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const YMUS_EXTENSION_ID: &str = "kamgbpbgdfkdjdgbimepdlmcckggijbh";
const YMUS_EXTENSION_VERSION: &str = "1.1.2";
const YMUS_CRX_SHA256: &str = "9e9c57dc845ae703bd87f70ae7db679e664600c5d90ac85c722a87e0c7856757";
const YMUS_UPDATE_URL: &str = "https://updates.ymus.tech/ymus/chromium/update.xml";
const YMUS_CRX_BYTES: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../YMus.crx"));

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserInfo {
    id: &'static str,
    name: &'static str,
    engine: &'static str,
    path: Option<String>,
    installed: bool,
    install_mode: &'static str,
    extensions_url: &'static str,
}

#[derive(Deserialize)]
struct ExtensionManifest {
    version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedExtension {
    path: String,
    version: String,
    extension_id: String,
    sha256: String,
    update_url: String,
    package_type: &'static str,
}

struct BrowserDefinition {
    id: &'static str,
    name: &'static str,
    engine: &'static str,
    install_mode: &'static str,
    extensions_url: &'static str,
    candidates: Vec<PathBuf>,
}

struct BrowserPolicyTarget {
    force_list_key: &'static str,
    managed_note: &'static str,
}

fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name).map(PathBuf::from)
}

fn child(base: Option<PathBuf>, path: &str) -> Option<PathBuf> {
    base.map(|value| value.join(path))
}

fn browser_definitions() -> Vec<BrowserDefinition> {
    let local = env_path("LOCALAPPDATA");
    let roaming = env_path("APPDATA");
    let program_files = env_path("ProgramFiles");
    let program_files_x86 = env_path("ProgramFiles(x86)");

    vec![
        BrowserDefinition {
            id: "yandex",
            name: "Yandex Browser",
            engine: "Chromium",
            install_mode: "CRX установка",
            extensions_url: "chrome://extensions/",
            candidates: vec![
                child(local.clone(), r"Yandex\YandexBrowser\Application\browser.exe"),
                child(program_files.clone(), r"Yandex\YandexBrowser\Application\browser.exe"),
            ]
            .into_iter()
            .flatten()
            .collect(),
        },
        BrowserDefinition {
            id: "chrome",
            name: "Google Chrome",
            engine: "Chromium",
            install_mode: "CRX установка",
            extensions_url: "chrome://extensions/",
            candidates: vec![
                child(local.clone(), r"Google\Chrome\Application\chrome.exe"),
                child(program_files.clone(), r"Google\Chrome\Application\chrome.exe"),
                child(program_files_x86.clone(), r"Google\Chrome\Application\chrome.exe"),
            ]
            .into_iter()
            .flatten()
            .collect(),
        },
        BrowserDefinition {
            id: "edge",
            name: "Microsoft Edge",
            engine: "Chromium",
            install_mode: "CRX установка",
            extensions_url: "edge://extensions/",
            candidates: vec![
                child(local.clone(), r"Microsoft\Edge\Application\msedge.exe"),
                child(program_files.clone(), r"Microsoft\Edge\Application\msedge.exe"),
                child(program_files_x86.clone(), r"Microsoft\Edge\Application\msedge.exe"),
            ]
            .into_iter()
            .flatten()
            .collect(),
        },
        BrowserDefinition {
            id: "firefox",
            name: "Mozilla Firefox",
            engine: "Firefox",
            install_mode: "Подписанный XPI",
            extensions_url: "about:addons",
            candidates: vec![
                child(program_files.clone(), r"Mozilla Firefox\firefox.exe"),
                child(program_files_x86.clone(), r"Mozilla Firefox\firefox.exe"),
                child(local.clone(), r"Mozilla Firefox\firefox.exe"),
            ]
            .into_iter()
            .flatten()
            .collect(),
        },
        BrowserDefinition {
            id: "brave",
            name: "Brave",
            engine: "Chromium",
            install_mode: "CRX установка",
            extensions_url: "brave://extensions/",
            candidates: vec![
                child(local.clone(), r"BraveSoftware\Brave-Browser\Application\brave.exe"),
                child(program_files.clone(), r"BraveSoftware\Brave-Browser\Application\brave.exe"),
                child(program_files_x86.clone(), r"BraveSoftware\Brave-Browser\Application\brave.exe"),
            ]
            .into_iter()
            .flatten()
            .collect(),
        },
        BrowserDefinition {
            id: "opera",
            name: "Opera",
            engine: "Chromium",
            install_mode: "CRX установка",
            extensions_url: "opera://extensions/",
            candidates: vec![
                child(local.clone(), r"Programs\Opera\opera.exe"),
                child(roaming, r"Opera Software\Opera Stable\opera.exe"),
            ]
            .into_iter()
            .flatten()
            .collect(),
        },
    ]
}

fn browser_policy_target(browser_id: &str) -> Option<BrowserPolicyTarget> {
    match browser_id {
        "chrome" => Some(BrowserPolicyTarget {
            force_list_key: r"HKCU\Software\Policies\Google\Chrome\ExtensionInstallForcelist",
            managed_note: "Для self-hosted CRX Chrome может требовать домен, Azure AD или Chrome Browser Cloud Management.",
        }),
        "edge" => Some(BrowserPolicyTarget {
            force_list_key: r"HKCU\Software\Policies\Microsoft\Edge\ExtensionInstallForcelist",
            managed_note: "На обычном ПК Edge может разрешать force-install только из Microsoft Edge Add-ons.",
        }),
        "brave" => Some(BrowserPolicyTarget {
            force_list_key: r"HKCU\Software\Policies\BraveSoftware\Brave\ExtensionInstallForcelist",
            managed_note: "Brave использует Chromium policy; поведение зависит от версии браузера.",
        }),
        "yandex" => Some(BrowserPolicyTarget {
            force_list_key: r"HKCU\Software\Policies\YandexBrowser\ExtensionInstallForcelist",
            managed_note: "Yandex Browser применяет force-install для корпоративного сценария; на обычном ПК может заблокировать установку.",
        }),
        _ => None,
    }
}

fn find_browser(id: &str) -> Option<(BrowserDefinition, PathBuf)> {
    browser_definitions()
        .into_iter()
        .find(|browser| browser.id == id)
        .and_then(|browser| {
            browser
                .candidates
                .iter()
                .find(|path| path.is_file())
                .cloned()
                .map(|path| (browser, path))
        })
}

#[tauri::command]
fn detect_browsers() -> Vec<BrowserInfo> {
    browser_definitions()
        .into_iter()
        .map(|browser| {
            let path = browser
                .candidates
                .iter()
                .find(|candidate| candidate.is_file())
                .map(|candidate| candidate.to_string_lossy().into_owned());

            BrowserInfo {
                id: browser.id,
                name: browser.name,
                engine: browser.engine,
                installed: path.is_some(),
                path,
                install_mode: browser.install_mode,
                extensions_url: browser.extensions_url,
            }
        })
        .collect()
}

fn find_local_extension_source() -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let current_dir = env::current_dir().map_err(|error| error.to_string())?;
    let candidates = [
        manifest_dir.join(r"..\..\..\..\YMus"),
        manifest_dir.join(r"..\..\..\..\"),
        current_dir.join("YMus"),
        current_dir.clone(),
        current_dir.join(r"..\..\..\YMus"),
    ];

    candidates
        .into_iter()
        .filter_map(|candidate| candidate.canonicalize().ok())
        .find(|candidate| candidate.join("manifest.json").is_file())
        .ok_or_else(|| "Не найдена локальная сборка расширения YMus".to_string())
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;

    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let target = destination.join(entry.file_name());

        if file_type.is_symlink() {
            return Err("Символические ссылки в пакете расширения запрещены".to_string());
        }

        if file_type.is_dir() {
            copy_directory(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target).map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

fn local_app_data() -> Result<PathBuf, String> {
    env_path("LOCALAPPDATA").ok_or_else(|| "Переменная LOCALAPPDATA недоступна".to_string())
}

#[tauri::command]
fn prepare_crx_package() -> Result<PreparedExtension, String> {
    let actual_hash = sha256_hex(YMUS_CRX_BYTES);
    if actual_hash != YMUS_CRX_SHA256 {
        return Err("CRX не прошел проверку SHA-256. Установка остановлена.".to_string());
    }

    let root = local_app_data()?.join(r"YMus\packages\chromium");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;

    let target = root.join(format!(
        "YMus-{YMUS_EXTENSION_VERSION}-{YMUS_EXTENSION_ID}.crx"
    ));
    let staging = root.join("YMus-staging.crx");

    fs::write(&staging, YMUS_CRX_BYTES).map_err(|error| error.to_string())?;
    let written = fs::read(&staging).map_err(|error| error.to_string())?;
    let written_hash = sha256_hex(&written);
    if written_hash != YMUS_CRX_SHA256 {
        let _ = fs::remove_file(&staging);
        return Err("Записанный CRX не прошел проверку SHA-256".to_string());
    }

    if target.exists() {
        fs::remove_file(&target).map_err(|error| error.to_string())?;
    }
    fs::rename(&staging, &target).map_err(|error| error.to_string())?;

    Ok(PreparedExtension {
        path: target.to_string_lossy().into_owned(),
        version: YMUS_EXTENSION_VERSION.to_string(),
        extension_id: YMUS_EXTENSION_ID.to_string(),
        sha256: YMUS_CRX_SHA256.to_string(),
        update_url: YMUS_UPDATE_URL.to_string(),
        package_type: "crx",
    })
}

#[tauri::command]
fn prepare_local_extension() -> Result<PreparedExtension, String> {
    let source = find_local_extension_source()?;
    let manifest_text =
        fs::read_to_string(source.join("manifest.json")).map_err(|error| error.to_string())?;
    let manifest: ExtensionManifest =
        serde_json::from_str(&manifest_text).map_err(|error| error.to_string())?;

    let local_app_data = env_path("LOCALAPPDATA")
        .ok_or_else(|| "Переменная LOCALAPPDATA недоступна".to_string())?;
    let root = local_app_data.join(r"YMus\extensions\chromium");
    let current = root.join("current");
    let staging = root.join("staging");
    let backup = root.join("previous");

    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|error| error.to_string())?;
    }

    copy_directory(&source, &staging)?;
    if !staging.join("manifest.json").is_file() {
        let _ = fs::remove_dir_all(&staging);
        return Err("В подготовленной папке отсутствует manifest.json".to_string());
    }

    if backup.exists() {
        fs::remove_dir_all(&backup).map_err(|error| error.to_string())?;
    }
    if current.exists() {
        fs::rename(&current, &backup).map_err(|error| error.to_string())?;
    }

    if let Err(error) = fs::rename(&staging, &current) {
        if backup.exists() && !current.exists() {
            let _ = fs::rename(&backup, &current);
        }
        return Err(error.to_string());
    }

    if backup.exists() {
        let _ = fs::remove_dir_all(&backup);
    }

    Ok(PreparedExtension {
        path: current.to_string_lossy().into_owned(),
        version: manifest.version,
        extension_id: YMUS_EXTENSION_ID.to_string(),
        sha256: String::new(),
        update_url: String::new(),
        package_type: "unpacked",
    })
}

#[tauri::command]
fn open_extensions_page(browser_id: String) -> Result<(), String> {
    let (browser, executable) =
        find_browser(&browser_id).ok_or_else(|| "Браузер не найден".to_string())?;

    Command::new(executable)
        .arg(browser.extensions_url)
        .spawn()
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn validate_unpacked_extension_path(extension_path: String) -> Result<PathBuf, String> {
    let target = PathBuf::from(extension_path)
        .canonicalize()
        .map_err(|_| "Папка расширения не найдена".to_string())?;
    if !target.join("manifest.json").is_file() {
        return Err("В папке расширения отсутствует manifest.json".to_string());
    }

    let local_app_data = env_path("LOCALAPPDATA")
        .ok_or_else(|| "Переменная LOCALAPPDATA недоступна".to_string())?
        .join(r"YMus\extensions\chromium")
        .canonicalize()
        .map_err(|_| "Локальное хранилище YMus не найдено".to_string())?;
    if !target.starts_with(local_app_data) {
        return Err("Можно использовать только подготовленную папку YMus".to_string());
    }

    Ok(target)
}

#[tauri::command]
fn launch_with_extension(browser_id: String, extension_path: String) -> Result<(), String> {
    let (browser, executable) =
        find_browser(&browser_id).ok_or_else(|| "Браузер не найден".to_string())?;
    if browser.engine != "Chromium" {
        return Err("Автозапуск распакованного расширения доступен только для Chromium-браузеров".to_string());
    }

    let target = validate_unpacked_extension_path(extension_path)?;

    Command::new(executable)
        .arg(format!("--load-extension={}", target.to_string_lossy()))
        .arg(browser.extensions_url)
        .spawn()
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[tauri::command]
fn launch_isolated_with_extension(browser_id: String, extension_path: String) -> Result<(), String> {
    let (browser, executable) =
        find_browser(&browser_id).ok_or_else(|| "Браузер не найден".to_string())?;
    if browser.engine != "Chromium" {
        return Err("Изолированный запуск доступен только для Chromium-браузеров".to_string());
    }

    let target = validate_unpacked_extension_path(extension_path)?;
    let profile = local_app_data()?.join(format!(r"YMus\browser-sessions\{}", browser.id));
    fs::create_dir_all(&profile).map_err(|error| error.to_string())?;

    Command::new(executable)
        .arg(format!("--user-data-dir={}", profile.to_string_lossy()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg(format!("--disable-extensions-except={}", target.to_string_lossy()))
        .arg(format!("--load-extension={}", target.to_string_lossy()))
        .arg(browser.extensions_url)
        .spawn()
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn powershell_literal(value: &str) -> String {
    format!("@'\n{}\n'@", value.replace("'@", "' @"))
}

#[tauri::command]
fn start_unpacked_auto_wizard(browser_id: String, extension_path: String) -> Result<String, String> {
    let (browser, executable) =
        find_browser(&browser_id).ok_or_else(|| "Браузер не найден".to_string())?;
    if browser.engine != "Chromium" {
        return Err("Автомастер доступен только для Chromium-браузеров".to_string());
    }

    let target = validate_unpacked_extension_path(extension_path)?;
    let target_text = target.to_string_lossy().into_owned();
    let extensions_url = browser.extensions_url.to_string();
    let browser_name = browser.name.to_string();

    Command::new(&executable)
        .arg(browser.extensions_url)
        .spawn()
        .map_err(|error| error.to_string())?;

    let script = format!(
        r#"
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
$folder = {folder}
$extensionsUrl = {extensions_url}
$browserName = {browser_name}
$shell = New-Object -ComObject WScript.Shell
Start-Sleep -Milliseconds 1400
Set-Clipboard -Value $extensionsUrl
foreach ($title in @($browserName, 'Extensions', 'Расширения')) {{
  if ($shell.AppActivate($title)) {{ break }}
}}
Start-Sleep -Milliseconds 300
$shell.SendKeys('^l')
Start-Sleep -Milliseconds 120
$shell.SendKeys('^v')
Start-Sleep -Milliseconds 120
$shell.SendKeys('{{ENTER}}')
Start-Sleep -Milliseconds 1700

# Experimental keyboard path. It can fail when browser UI order, language, scale or focus differs.
for ($i = 0; $i -lt 6; $i++) {{
  $shell.SendKeys('{{TAB}}')
  Start-Sleep -Milliseconds 90
}}
$shell.SendKeys(' ')
Start-Sleep -Milliseconds 700
for ($i = 0; $i -lt 4; $i++) {{
  $shell.SendKeys('{{TAB}}')
  Start-Sleep -Milliseconds 90
}}
$shell.SendKeys('{{ENTER}}')
Start-Sleep -Milliseconds 1000
Set-Clipboard -Value $folder
$shell.SendKeys('^l')
Start-Sleep -Milliseconds 140
$shell.SendKeys('^v')
Start-Sleep -Milliseconds 140
$shell.SendKeys('{{ENTER}}')
Start-Sleep -Milliseconds 650
$shell.SendKeys('{{ENTER}}')
"#,
        folder = powershell_literal(&target_text),
        extensions_url = powershell_literal(&extensions_url),
        browser_name = powershell_literal(&browser_name),
    );

    let script_path = local_app_data()?.join(r"YMus\automation\unpacked-install.ps1");
    if let Some(parent) = script_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&script_path, script).map_err(|error| error.to_string())?;

    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
        ])
        .arg(&script_path);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command.spawn().map_err(|error| error.to_string())?;

    Ok("Автомастер запущен. Если браузер не выбрал папку сам, путь уже скопирован в буфер обмена.".to_string())
}

fn hkcu_subkey(key: &str) -> Result<&str, String> {
    key.strip_prefix(r"HKCU\")
        .or_else(|| key.strip_prefix(r"HKEY_CURRENT_USER\"))
        .ok_or_else(|| format!("Неподдерживаемый раздел реестра: {key}"))
}

fn registry_values(key: &str) -> Vec<(String, String)> {
    let Ok(subkey) = hkcu_subkey(key) else {
        return Vec::new();
    };
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(policy_key) = hkcu.open_subkey(subkey) else {
        return Vec::new();
    };

    policy_key
        .enum_values()
        .filter_map(|value| {
            let (name, _) = value.ok()?;
            let data = policy_key.get_value::<String, _>(&name).ok()?;
            Some((name, data))
        })
        .collect()
}

fn registry_set_string(key: &str, value_name: &str, value: &str) -> Result<(), String> {
    let subkey = hkcu_subkey(key)?;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (policy_key, _) = hkcu.create_subkey(subkey).map_err(|error| {
        format!(
            "Не удалось открыть раздел HKCU\\{subkey}: {error}. Если Windows заблокировала Policies, запустите приложение от имени администратора."
        )
    })?;

    policy_key.set_value(value_name, &value).map_err(|error| {
        format!(
            "Не удалось записать policy HKCU\\{subkey}\\{value_name}: {error}. Если Windows заблокировала Policies, запустите приложение от имени администратора."
        )
    })
}

fn policy_value_name(key: &str, policy_value: &str) -> String {
    let values = registry_values(key);
    if let Some((name, _)) = values
        .iter()
        .find(|(_, data)| data == policy_value || data.starts_with(&format!("{YMUS_EXTENSION_ID};")))
    {
        return name.clone();
    }

    for index in 1..=200 {
        let name = index.to_string();
        if values.iter().all(|(existing, _)| existing != &name) {
            return name;
        }
    }

    "200".to_string()
}

#[tauri::command]
fn install_crx_extension(browser_id: String, crx_path: String) -> Result<String, String> {
    let (browser, executable) =
        find_browser(&browser_id).ok_or_else(|| "Браузер не найден".to_string())?;
    if browser.engine != "Chromium" {
        return Err("CRX-установка доступна только для Chromium-браузеров".to_string());
    }

    let target = PathBuf::from(crx_path)
        .canonicalize()
        .map_err(|_| "CRX-файл не найден".to_string())?;
    if !target
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("crx"))
    {
        return Err("Ожидался файл .crx".to_string());
    }

    let packages_root = local_app_data()?
        .join(r"YMus\packages\chromium")
        .canonicalize()
        .map_err(|_| "Локальное хранилище CRX не найдено".to_string())?;
    if !target.starts_with(packages_root) {
        return Err("Можно устанавливать только проверенный CRX из хранилища YMus".to_string());
    }

    let bytes = fs::read(&target).map_err(|error| error.to_string())?;
    let actual_hash = sha256_hex(&bytes);
    if actual_hash != YMUS_CRX_SHA256 {
        return Err("CRX не прошел проверку SHA-256. Установка остановлена.".to_string());
    }

    let policy_target = browser_policy_target(&browser_id)
        .ok_or_else(|| "Для этого браузера CRX policy-установка пока не поддерживается".to_string())?;
    let policy_value = format!("{YMUS_EXTENSION_ID};{YMUS_UPDATE_URL}");
    let value_name = policy_value_name(policy_target.force_list_key, &policy_value);
    registry_set_string(policy_target.force_list_key, &value_name, &policy_value)?;

    Command::new(executable)
        .arg(browser.extensions_url)
        .spawn()
        .map_err(|error| error.to_string())?;

    Ok(format!(
        "{}: policy прописана. {}",
        browser.name, policy_target.managed_note
    ))
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if target.is_file() {
        let selector = format!("/select,{}", target.to_string_lossy());
        Command::new("explorer.exe")
            .arg(selector)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    if !target.is_dir() {
        return Err("Папка или файл не найдены".to_string());
    }

    Command::new("explorer.exe")
        .arg(target)
        .spawn()
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            detect_browsers,
            prepare_crx_package,
            prepare_local_extension,
            open_extensions_page,
            launch_with_extension,
            launch_isolated_with_extension,
            start_unpacked_auto_wizard,
            install_crx_extension,
            open_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running YMus Desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_crx_matches_expected_hash() {
        assert_eq!(sha256_hex(YMUS_CRX_BYTES), YMUS_CRX_SHA256);
    }
}
