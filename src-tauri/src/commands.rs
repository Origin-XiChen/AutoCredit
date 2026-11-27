use std::fs;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

use crate::checkin::{adapter_for, AdapterContext};
use crate::models::{
    app_meta, now_iso, visible_app_ids, AppConfig, AppId, BootstrapState, DetectResult,
    GlobalSettings, LocateResult, LogEntry, PopupData, RunStatus, SavePatResult, UpdatePhase,
    UpdateStatus,
};
use crate::scheduler;
use crate::state::AppState;
use crate::store::AppRuntimePatch;

#[tauri::command]
pub fn state_get(app: AppHandle) -> BootstrapState {
    app.state::<AppState>().bootstrap()
}

#[tauri::command]
pub async fn master_set(app: AppHandle, enabled: bool) {
    let state = app.state::<AppState>();
    if let Ok(mut store) = state.store.lock() {
        store.update_settings(serde_json::json!({ "masterEnabled": enabled }));
    }
    state
        .logger
        .info(if enabled { "自动签到已开启" } else { "自动签到已暂停" });
    crate::tray::refresh(&app);
    emit_state(&app);
    if enabled {
        tauri::async_runtime::spawn(async move {
            scheduler::tick(&app).await;
        });
    }
}

#[tauri::command]
pub async fn settings_update(app: AppHandle, patch: Value) {
    let state = app.state::<AppState>();
    let developer_mode = patch
        .get("developerMode")
        .and_then(Value::as_bool);
    let allow_prerelease = patch
        .get("allowPrerelease")
        .and_then(Value::as_bool);
    let auto_launch = patch.get("autoLaunch").and_then(Value::as_bool);
    let master_enabled = patch.get("masterEnabled").and_then(Value::as_bool);

    if let Ok(mut store) = state.store.lock() {
        store.update_settings(patch.clone());
        if developer_mode == Some(false) && store.app(AppId::Doubao).enabled {
            store.update_app(AppId::Doubao, serde_json::json!({ "enabled": false }));
            state
                .logger
                .info("开发者模式已关闭，豆包签到已停用");
        }
    }

    if let Some(enabled) = auto_launch {
        set_autostart(&app, enabled);
    }
    if let Some(enabled) = allow_prerelease {
        state.logger.info(if enabled {
            "已开启接收 dev 版本更新"
        } else {
            "已关闭接收 dev 版本更新"
        });
    }
    if let Some(enabled) = master_enabled {
        state
            .logger
            .info(if enabled { "自动签到已开启" } else { "自动签到已暂停" });
    }

    state.logger.info("设置已更新");
    crate::tray::refresh(&app);
    emit_state(&app);
    if master_enabled != Some(false) {
        tauri::async_runtime::spawn(async move {
            scheduler::tick(&app).await;
        });
    }
}

#[tauri::command]
pub async fn app_update(app: AppHandle, id: String, patch: Value) {
    let Some(id) = AppId::parse(&id) else {
        return;
    };
    let state = app.state::<AppState>();
    let enable = patch.get("enabled").and_then(Value::as_bool);
    if id == AppId::Doubao && enable == Some(true) {
        let developer_mode = state
            .store
            .lock()
            .map(|store| store.settings().developer_mode)
            .unwrap_or(false);
        if !developer_mode {
            state
                .logger
                .warn("豆包签到属于实验功能，请先在设置中开启开发者模式", Some(id));
            return;
        }
    }

    if let Ok(mut store) = state.store.lock() {
        store.update_app(id, patch.clone());
    }

    if let Some(enabled) = enable {
        state.logger.info_app(
            format!(
                "{} 签到已{}",
                app_meta(id).name,
                if enabled { "启用" } else { "关闭" }
            ),
            id,
        );
    }
    if let Some(custom) = patch.get("useCustomTime").and_then(Value::as_bool) {
        state.logger.info_app(
            format!(
                "{} 独立签到时间已{}",
                app_meta(id).name,
                if custom { "开启" } else { "关闭" }
            ),
            id,
        );
    }
    emit_state(&app);
}

#[tauri::command]
pub async fn pat_save(app: AppHandle, id: String, pat: String) -> SavePatResult {
    let Some(id) = AppId::parse(&id) else {
        return SavePatResult {
            ok: false,
            message: "未知程序".into(),
        };
    };
    if id != AppId::Qoder && id != AppId::QoderCn {
        return SavePatResult {
            ok: false,
            message: "该程序不需要手动令牌".into(),
        };
    }
    if pat.trim().is_empty() {
        return SavePatResult {
            ok: false,
            message: "请先粘贴个人访问令牌".into(),
        };
    }

    let state = app.state::<AppState>();
    let result = match state.store.lock() {
        Ok(mut store) => store.set_pat(id, pat.trim().to_string()),
        Err(_) => Err("无法保存令牌".to_string()),
    };
    if result.is_err() {
        return SavePatResult {
            ok: false,
            message: result.err().unwrap_or_else(|| "无法保存令牌".into()),
        };
    }

    if let Ok(mut store) = state.store.lock() {
        store.update_runtime(
            id,
            AppRuntimePatch {
                status: Some(RunStatus::Idle),
                message: Some("正在验证令牌…".into()),
                today_checked_in: Some(Some(false)),
                probe_date: Some(None),
                last_attempt_date: Some(None),
                last_attempt_at: Some(None),
                attempts: Some(0),
                ..Default::default()
            },
        );
    }
    state
        .logger
        .info_app(format!("{} 个人访问令牌已保存", app_meta(id).name), id);
    emit_state(&app);

    let context = context_for(&app, id);
    let result = adapter_for(id).detect(context).await;
    if let Ok(mut store) = state.store.lock() {
        store.update_runtime(
            id,
            AppRuntimePatch {
                status: Some(if result.ok {
                    RunStatus::Idle
                } else {
                    RunStatus::NeedsAuth
                }),
                message: Some(if result.ok {
                    "令牌有效，等待签到".into()
                } else {
                    result.message.clone()
                }),
                user_label: Some(result.user_label.clone()),
                ..Default::default()
            },
        );
    }
    let ok = result.ok;
    let message = result.message.clone();
    if ok {
        state
            .logger
            .success(format!("{}：{}", app_meta(id).name, message), id);
    } else {
        state
            .logger
            .warn(format!("{}：{}", app_meta(id).name, message), Some(id));
    }
    emit_state(&app);

    if ok {
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            scheduler::probe_all(&app_handle, Some(vec![id])).await;
            scheduler::tick(&app_handle).await;
        });
    }
    SavePatResult { ok, message }
}

#[tauri::command]
pub fn pat_clear(app: AppHandle, id: String) {
    let Some(id) = AppId::parse(&id) else {
        return;
    };
    if id != AppId::Qoder && id != AppId::QoderCn {
        return;
    }
    let state = app.state::<AppState>();
    if let Ok(mut store) = state.store.lock() {
        let _ = store.clear_pat(id);
        store.update_runtime(
            id,
            AppRuntimePatch {
                status: Some(RunStatus::NeedsSetup),
                message: Some("尚未保存个人访问令牌".into()),
                user_label: Some(None),
                today_checked_in: Some(Some(false)),
                ..Default::default()
            },
        );
    }
    state
        .logger
        .info_app(format!("已清除 {} 个人访问令牌", app_meta(id).name), id);
    emit_state(&app);
}

#[tauri::command]
pub async fn app_detect(app: AppHandle, id: String) -> DetectResult {
    let Some(id) = AppId::parse(&id) else {
        return DetectResult {
            ok: false,
            message: "未知程序".into(),
            user_label: None,
        };
    };
    let context = context_for(&app, id);
    let result = adapter_for(id).detect(context).await;
    let state = app.state::<AppState>();

    if result.ok {
        if let Ok(mut store) = state.store.lock() {
            let status = store.runtime(id).status;
            if status == RunStatus::NeedsAuth || status == RunStatus::NeedsSetup {
                store.update_runtime(
                    id,
                    AppRuntimePatch {
                        status: Some(RunStatus::Idle),
                        message: Some("连接正常，等待签到".into()),
                        user_label: Some(result.user_label.clone()),
                        ..Default::default()
                    },
                );
            }
        }
        state
            .logger
            .success(format!("{}：{}", app_meta(id).name, result.message), id);
    } else {
        state.logger.warn(
            format!("{}：{}", app_meta(id).name, result.message),
            Some(id),
        );
    }
    emit_state(&app);
    result
}

#[tauri::command]
pub fn app_locate(app: AppHandle, id: String) -> LocateResult {
    let Some(id) = AppId::parse(&id) else {
        return LocateResult {
            ok: false,
            message: "未知程序".into(),
            data_path: None,
            exe_path: None,
        };
    };
    let context = context_for(&app, id);
    let result = adapter_for(id)
        .locate(&context)
        .unwrap_or(LocateResult {
            ok: false,
            message: "该程序无需配置路径".into(),
            data_path: None,
            exe_path: None,
        });
    app.state::<AppState>()
        .logger
        .info_app(format!("{}路径自动搜索：{}", app_meta(id).name, result.message), id);
    result
}

#[tauri::command]
pub fn path_pick(app: AppHandle, kind: String) -> Option<String> {
    let dialog = app.dialog().file();
    let picked = if kind == "file" {
        dialog.blocking_pick_file()
    } else {
        dialog.blocking_pick_folder()
    };
    picked
        .and_then(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn probe_all(app: AppHandle) {
    scheduler::probe_all(&app, None).await;
}

#[tauri::command]
pub async fn run_now(app: AppHandle, ids: Option<Vec<String>>) {
    let ids = ids.map(|values| {
        values
            .into_iter()
            .filter_map(|value| AppId::parse(&value))
            .collect::<Vec<_>>()
    });
    scheduler::run_now(&app, ids).await;
}

#[tauri::command]
pub fn logs_get(app: AppHandle) -> Vec<LogEntry> {
    app.state::<AppState>().logger.entries()
}

#[tauri::command]
pub fn logs_clear(app: AppHandle) {
    let state = app.state::<AppState>();
    state.logger.clear();
    emit_state(&app);
}

#[tauri::command]
pub fn logs_export(app: AppHandle) -> Option<String> {
    let file_name = format!(
        "AutoCredit-日志-{}.txt",
        chrono::Local::now().format("%Y-%m-%d")
    );
    let picked = app
        .dialog()
        .file()
        .set_file_name(&file_name)
        .add_filter("文本文件", &["txt"])
        .blocking_save_file()?;
    let path = picked.into_path().ok()?;
    let state = app.state::<AppState>();
    fs::write(&path, state.logger.export_text()).ok()?;
    Some(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn popup_data(app: AppHandle) -> Option<PopupData> {
    app.state::<AppState>().popup.data()
}

#[tauri::command]
pub fn popup_cancel(app: AppHandle) {
    app.state::<AppState>().popup.cancel();
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return;
    }
    let _ = app.opener().open_url(url, None::<&str>);
}

#[tauri::command]
pub fn open_path(app: AppHandle, path: String) {
    let _ = app.opener().open_path(path, None::<&str>);
}

#[tauri::command]
pub fn window_minimize(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.minimize();
    }
}

#[tauri::command]
pub fn window_maximize(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_maximized().unwrap_or(false) {
            let _ = window.unmaximize();
        } else {
            let _ = window.maximize();
        }
    }
}

#[tauri::command]
pub fn window_close(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.close();
    }
}

#[tauri::command]
pub async fn update_check(app: AppHandle) {
    let state = app.state::<AppState>();
    if !state.is_packaged {
        let _ = app.emit(
            "update:status",
            UpdateStatus {
                phase: UpdatePhase::Blocked,
                message: "开发模式下不检查更新".into(),
                version: None,
            },
        );
        return;
    }
    let _ = app.emit(
        "update:status",
        UpdateStatus {
            phase: UpdatePhase::Checking,
            message: "正在检查更新…".into(),
            version: None,
        },
    );

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            let _ = app.emit(
                "update:status",
                UpdateStatus {
                    phase: UpdatePhase::Error,
                    message: format!("更新器不可用：{error}"),
                    version: None,
                },
            );
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let _ = app.emit(
                "update:status",
                UpdateStatus {
                    phase: UpdatePhase::Available,
                    message: format!("发现新版本 {version}，正在后台下载…"),
                    version: Some(version.clone()),
                },
            );
            state
                .logger
                .info(format!("发现新版本 {version}，正在后台下载"));
            match update
                .download_and_install(|_, _| {}, || {})
                .await
            {
                Ok(()) => {
                    let _ = app.emit(
                        "update:status",
                        UpdateStatus {
                            phase: UpdatePhase::Ready,
                            message: format!("新版本 {version} 已下载，重启应用后完成安装"),
                            version: Some(version),
                        },
                    );
                }
                Err(error) => {
                    let _ = app.emit(
                        "update:status",
                        UpdateStatus {
                            phase: UpdatePhase::Error,
                            message: format!("更新下载失败：{error}"),
                            version: None,
                        },
                    );
                }
            }
        }
        Ok(None) => {
            let version = app.package_info().version.to_string();
            let _ = app.emit(
                "update:status",
                UpdateStatus {
                    phase: UpdatePhase::Latest,
                    message: format!("当前已是最新版本（{version}）"),
                    version: Some(version),
                },
            );
        }
        Err(error) => {
            let _ = app.emit(
                "update:status",
                UpdateStatus {
                    phase: UpdatePhase::Error,
                    message: format!("检查更新失败：{error}"),
                    version: None,
                },
            );
        }
    }
}

#[tauri::command]
pub fn update_install(app: AppHandle) {
    app.restart();
}

fn emit_state(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _ = app.emit("state:update", state.bootstrap());
}

fn context_for(app: &AppHandle, id: AppId) -> AdapterContext {
    let state = app.state::<AppState>();
    let (_, contexts) = state.contexts();
    contexts
        .into_iter()
        .find(|(app_id, _)| *app_id == id)
        .map(|(_, context)| context)
        .unwrap_or_default()
}

fn set_autostart(app: &AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    if let Err(error) = result {
        app.state::<AppState>()
            .logger
            .warn(format!("更新开机自启动失败：{error}"), None);
    }
}

#[allow(dead_code)]
fn _unused(_: Option<GlobalSettings>, _: Option<AppConfig>, _: Option<&str>, _: Option<&str>) {
    let _ = now_iso();
    let _ = visible_app_ids;
}
