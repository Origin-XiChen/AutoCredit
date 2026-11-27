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
    let default_path = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("C:\\"))
        .join("AutoCredit");
    AppInfo {
        version: app.package_info().version.to_string(),
        default_path: default_path.display().to_string(),
    }
}

#[tauri::command]
fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
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
        .status()
        .map_err(|error| format!("无法启动安装程序：{error}"))?;
    let _ = std::fs::remove_file(&setup);

    if !status.success() {
        return Err(format!(
            "安装程序退出码 {}，请重试或运行完整安装包",
            status.code().unwrap_or(-1)
        ));
    }

    if options.create_shortcut {
        create_shortcut(&target);
    }
    if options.launch_after {
        let exe = target.join("AutoCredit.exe");
        let _ = Command::new(exe).spawn();
    }
    Ok(())
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
