mod checkin;
mod commands;
mod fullscreen;
mod logger;
mod models;
mod network;
mod popup;
mod scheduler;
mod state;
mod store;
mod tray;

use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::{Manager, WindowEvent};

use crate::logger::Logger;
use crate::state::AppState;
use crate::store::Store;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let store = Store::load();
            let first_run = store.first_run;
            let settings = store.settings().clone();
            let version = app.package_info().version.to_string();
            let logger = Arc::new(Logger::new(
                store.logs_dir.clone(),
                settings.log_retention_days,
            ));
            logger.attach(app.handle().clone());
            logger.info(format!("AutoCredit {version} 已启动"));

            let state = AppState::new(store, logger, version.clone(), !cfg!(debug_assertions));
            app.manage(state);

            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                round_window_corners(&window);
            }

            tray::create(app.handle())?;
            scheduler::start(app.handle().clone());
            network::start(app.handle().clone());

            // 每次启动后自动检查 GitHub 上的新版本，发现更新时由前端弹出公告。
            let update_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(6)).await;
                commands::update_check(update_handle).await;
            });

            apply_autostart(app.handle(), settings.auto_launch);

            let hidden = std::env::args().any(|arg| arg == "--hidden") && settings.start_minimized;
            if first_run || !hidden {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let state = app.state::<AppState>();
                if state.quitting.load(Ordering::Relaxed) {
                    return;
                }
                let close_to_tray = state
                    .store
                    .lock()
                    .map(|store| store.settings().close_to_tray)
                    .unwrap_or(true);
                if close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    state.quitting.store(true, Ordering::Relaxed);
                    app.exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::state_get,
            commands::master_set,
            commands::settings_update,
            commands::app_update,
            commands::pat_save,
            commands::pat_clear,
            commands::app_detect,
            commands::app_locate,
            commands::path_pick,
            commands::probe_all,
            commands::run_now,
            commands::logs_get,
            commands::logs_clear,
            commands::logs_export,
            commands::popup_data,
            commands::popup_cancel,
            commands::open_external,
            commands::open_path,
            commands::window_minimize,
            commands::window_maximize,
            commands::window_close,
            commands::update_check,
            commands::update_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AutoCredit");
}

#[cfg(target_os = "windows")]
fn round_window_corners(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let preference: u32 = DWMWCP_ROUND as u32;
    unsafe {
        DwmSetWindowAttribute(
            hwnd.0,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &preference as *const u32 as *const core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

fn apply_autostart(app: &tauri::AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let _ = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
}
