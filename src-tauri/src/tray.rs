use std::sync::Mutex;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Wry};

use crate::commands;
use crate::scheduler;
use crate::state::AppState;

pub struct TrayHolder {
    handles: Mutex<Option<(TrayIcon<Wry>, CheckMenuItem<Wry>)>>,
}

impl Default for TrayHolder {
    fn default() -> Self {
        Self {
            handles: Mutex::new(None),
        }
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let enabled = app
        .state::<AppState>()
        .store
        .lock()
        .map(|store| store.settings().master_enabled)
        .unwrap_or(false);

    let show = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
    let run = MenuItem::with_id(app, "run", "立即签到", true, None::<&str>)?;
    let master = CheckMenuItem::with_id(app, "master", "自动签到", true, enabled, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "检查更新…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let separator1 = PredefinedMenuItem::separator(app)?;
    let separator2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[
            &show,
            &run,
            &separator1,
            &master,
            &settings,
            &update,
            &separator2,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(if cfg!(debug_assertions) {
            "AutoCredit-dev"
        } else {
            "AutoCredit"
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    let tray = builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "run" => {
                show_main(app);
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    scheduler::run_now(&app, None).await;
                });
            }
            "master" => {
                let next = app
                    .state::<AppState>()
                    .store
                    .lock()
                    .map(|store| !store.settings().master_enabled)
                    .unwrap_or(false);
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    commands::master_set(app, next).await;
                });
            }
            "settings" => show_main(app),
            "update" => {
                show_main(app);
                let _ = tauri::Emitter::emit(app, "ui:settings-about", ());
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    commands::update_check(app).await;
                });
            }
            "quit" => {
                let state = app.state::<AppState>();
                state
                    .quitting
                    .store(true, std::sync::atomic::Ordering::Relaxed);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    app.manage(TrayHolder {
        handles: Mutex::new(Some((tray, master))),
    });
    Ok(())
}

pub fn refresh(app: &AppHandle) {
    let enabled = app
        .state::<AppState>()
        .store
        .lock()
        .map(|store| store.settings().master_enabled)
        .unwrap_or(false);
    if let Some(holder) = app.try_state::<TrayHolder>() {
        if let Ok(guard) = holder.handles.lock() {
            if let Some((_, item)) = guard.as_ref() {
                let _ = item.set_checked(enabled);
            }
        }
    }
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
