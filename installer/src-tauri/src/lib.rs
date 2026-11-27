use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    default_path: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallOptions {
    path: String,
    create_shortcut: bool,
    auto_start: bool,
    launch_after: bool,
}

fn emit_status(app: &AppHandle, stage: &str, message: &str) {
    let _ = app.emit(
        "install:status",
        serde_json::json!({ "stage": stage, "message": message }),
    );
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    let default_path = old_install_dir().unwrap_or_else(|| {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("C:\\"))
            .join("AutoCredit")
    });
    AppInfo {
        version: app.package_info().version.to_string(),
        default_path: default_path.display().to_string(),
    }
}

/// 旧版 Electron 的安装目录；未安装旧版时返回 None。
fn old_install_dir() -> Option<PathBuf> {
    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\9a306f92-57d0-53be-904f-2e00aea31131";
    let output = Command::new("reg")
        .args(["query", KEY, "/v", "InstallLocation"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let value = text
        .lines()
        .find(|line| line.contains("InstallLocation"))?
        .split("REG_SZ")
        .nth(1)?
        .trim()
        .trim_matches('"')
        .trim();
    if value.is_empty() {
        return None;
    }
    let path = PathBuf::from(value);
    path.is_dir().then_some(path)
}

#[tauri::command]
fn pick_folder(app: AppHandle) -> Option<String> {
    let mut dialog = app.dialog().file();
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog
        .blocking_pick_folder()
        .and_then(|path| path.into_path().ok())
        .map(|path| path.display().to_string())
}

#[tauri::command]
fn minimize(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.minimize();
    }
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
async fn install(app: AppHandle, options: InstallOptions) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_install(&app, options))
        .await
        .map_err(|error| format!("安装线程异常：{error}"))?
}

fn run_install(app: &AppHandle, options: InstallOptions) -> Result<(), String> {
    let target = PathBuf::from(options.path.trim());
    if !target.is_absolute() {
        return Err("安装路径必须是绝对路径".into());
    }
    std::fs::create_dir_all(&target).map_err(|error| format!("无法创建安装目录：{error}"))?;
    let old_dir = old_install_dir();

    emit_status(app, "preparing", "正在准备安装包…");
    let setup = std::env::temp_dir().join("AutoCredit-setup-embedded.exe");
    std::fs::write(&setup, include_bytes!("../resources/setup-embedded.exe"))
        .map_err(|error| format!("无法释放安装包：{error}"))?;

    if std::env::var_os("AUTOCREDIT_INSTALLER_DRY_RUN").is_some() {
        for (stage, message) in [
            ("uninstalling", "正在卸载旧版…"),
            ("installing", "正在安装…"),
        ] {
            emit_status(app, stage, message);
            std::thread::sleep(Duration::from_millis(1200));
        }
        let _ = std::fs::remove_file(&setup);
        return Ok(());
    }

    emit_status(app, "installing", "正在卸载旧版并安装…");
    let mut install_dir = target.display().to_string();
    if install_dir.len() > 3 {
        install_dir = install_dir.trim_end_matches('\\').to_string();
    }
    let status = Command::new(&setup)
        .arg("/S")
        .arg(format!("/D={install_dir}"))
        .current_dir(std::env::temp_dir())
        .status()
        .map_err(|error| format!("无法启动安装程序：{error}"))?;
    let _ = std::fs::remove_file(&setup);

    if !status.success() {
        return Err(format!(
            "安装程序退出码 {}，请重试或运行完整安装包",
            status.code().unwrap_or(-1)
        ));
    }

    // 新版装到其他位置时，清掉旧版卸载后留下的空目录。
    if let Some(old) = old_dir {
        let same = match (old.canonicalize(), target.canonicalize()) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        };
        if !same {
            let _ = std::fs::remove_dir(&old);
        }
    }

    if options.create_shortcut {
        create_shortcut(&target);
    }
    set_auto_launch(options.auto_start);
    if options.launch_after {
        let exe = target.join("AutoCredit.exe");
        let _ = Command::new(exe).current_dir(&target).spawn();
    }
    Ok(())
}

/// 把开机自启选项写入保留的配置文件，应用首次启动时会按该设置注册自启。
fn set_auto_launch(enabled: bool) {
    let Some(config_dir) = dirs::config_dir() else {
        return;
    };
    let dir = config_dir.join("AutoCredit");
    let path = dir.join("config.json");
    let mut value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .unwrap_or_else(|| {
            serde_json::json!({ "settings": {}, "apps": {}, "runtime": {} })
        });
    let Some(settings) = value.get_mut("settings").and_then(|item| item.as_object_mut()) else {
        return;
    };
    settings.insert(
        "autoLaunch".into(),
        serde_json::Value::Bool(enabled),
    );
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(text) = serde_json::to_string_pretty(&value) {
        let _ = std::fs::write(&path, text);
    }
}

fn create_shortcut(target: &Path) {
    let exe = target.join("AutoCredit.exe");
    if !exe.exists() {
        return;
    }
    let exe = exe.display().to_string().replace('\'', "''");
    let dir = target.display().to_string().replace('\'', "''");
    let script = format!(
        "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\\AutoCredit.lnk'); $s.TargetPath='{exe}'; $s.WorkingDirectory='{dir}'; $s.IconLocation='{exe},0'; $s.Save()"
    );
    let _ = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .status();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 避免继承旧安装目录作为工作目录，导致该目录在安装期间被占用。
    let _ = std::env::set_current_dir(std::env::temp_dir());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            app_info,
            pick_folder,
            minimize,
            quit,
            install
        ])
        .run(tauri::generate_context!())
        .expect("error while running AutoCredit installer");
}
