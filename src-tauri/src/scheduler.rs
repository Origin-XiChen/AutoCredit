use std::collections::HashMap;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::checkin::{self, AdapterContext, Outcome, ProbeResult, Readiness};
use crate::models::{
    app_meta, checkin_date_key, is_time_reached, local_date_key, now_iso, visible_app_ids, AppId,
    ConfigFile, LogLevel, RunStatus,
};
use crate::state::AppState;
use crate::store::AppRuntimePatch;

const TICK: Duration = Duration::from_secs(15);
const RETRY: Duration = Duration::from_secs(10 * 60);
const MAX_ATTEMPTS: u32 = 3;

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        probe_all(&app, None).await;
        tick(&app).await;
        loop {
            tokio::time::sleep(TICK).await;
            tick(&app).await;
        }
    });
}

pub async fn tick(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _guard = state.scheduler_lock.lock().await;
    roll_date(app);
    if !current_config(app).settings.master_enabled {
        return;
    }

    let due = due_apps(app);
    if due.is_empty() {
        return;
    }

    let mut ready = Vec::new();
    for id in due {
        let readiness = readiness_for(app, id);
        if !readiness.ready {
            write_runtime(
                app,
                id,
                AppRuntimePatch {
                    status: Some(readiness.status.unwrap_or_else(|| readiness_status(id))),
                    message: Some(readiness.message.clone()),
                    last_attempt_date: Some(Some(date_key(id))),
                    last_attempt_at: Some(Some(now_iso())),
                    attempts: Some(attempts_for(app, id).max(1)),
                    ..Default::default()
                },
            );
            state.logger.warn(
                format!("{}：{}", app_meta(id).name, readiness.message),
                Some(id),
            );
            continue;
        }
        if current_config(app).runtime.get(&id).map(|r| r.status) == Some(RunStatus::Running) {
            continue;
        }
        ready.push(id);
    }
    emit_state(app);
    if ready.is_empty() {
        return;
    }

    let names = ready
        .iter()
        .map(|id| app_meta(*id).name)
        .collect::<Vec<_>>()
        .join("、");

    let mut popup_flow = false;
    if !current_config(app).settings.show_checkin_popup {
        state
            .logger
            .info(format!("签到提醒窗口已关闭，直接为 {names} 签到"));
    } else {
        let notification = crate::fullscreen::get_notification_state(true);
        if notification.suppressed {
            state.logger.info(format!(
                "检测到{}，本次静默签到，不弹出提醒",
                if notification.reason.is_empty() {
                    "全屏 / 忙碌状态"
                } else {
                    notification.reason
                }
            ));
        } else {
            state.logger.info(format!("即将为 {names} 签到，10 秒倒计时开始"));
            match crate::popup::show(app.clone(), &state.popup, ready.clone()).await {
                crate::popup::PopupOutcome::Cancelled => {
                    for id in &ready {
                        write_runtime(
                            app,
                            *id,
                            AppRuntimePatch {
                                status: Some(RunStatus::Cancelled),
                                message: Some("今日签到已被取消，可在总览中手动签到".into()),
                                last_attempt_date: Some(Some(date_key(*id))),
                                last_attempt_at: Some(Some(now_iso())),
                                ..Default::default()
                            },
                        );
                    }
                    state.logger.info(format!("已取消今日 {names} 的签到"));
                    emit_state(app);
                    return;
                }
                crate::popup::PopupOutcome::Started => {
                    state.logger.info("倒计时结束，开始签到");
                    popup_flow = true;
                }
            }
        }
    }

    let mut all_ok = true;
    for id in ready {
        let status = execute(app, id).await;
        if !matches!(status, RunStatus::Success | RunStatus::Already) {
            all_ok = false;
        }
    }
    if popup_flow {
        crate::popup::finish(app, all_ok).await;
    }
    emit_state(app);
}

pub async fn probe_all(app: &AppHandle, ids: Option<Vec<AppId>>) {
    let state = app.state::<AppState>();
    let _guard = state.scheduler_lock.lock().await;
    roll_date(app);

    let targets = ids.unwrap_or_else(|| active_app_ids(app));
    state.logger.info(format!(
        "正在检测 {} 的签到状态",
        targets
            .iter()
            .map(|id| app_meta(*id).name)
            .collect::<Vec<_>>()
            .join("、")
    ));

    for id in targets {
        let ctx = context_for(app, id);
        let result = checkin::adapter_for(id).probe(ctx).await;
        apply_probe(app, id, result);
    }
    emit_state(app);
}

pub async fn run_now(app: &AppHandle, ids: Option<Vec<AppId>>) {
    let state = app.state::<AppState>();
    let _guard = state.scheduler_lock.lock().await;
    roll_date(app);

    let targets = match ids {
        Some(ids) if !ids.is_empty() => ids
            .into_iter()
            .filter(|id| current_config(app).apps.get(id).map(|a| a.enabled).unwrap_or(false))
            .collect::<Vec<_>>(),
        _ => active_app_ids(app)
            .into_iter()
            .filter(|id| current_config(app).apps.get(id).map(|a| a.enabled).unwrap_or(false))
            .collect::<Vec<_>>(),
    };

    if targets.is_empty() {
        state.logger.warn("没有可签到或已启用的程序", None);
        return;
    }

    state.logger.info(format!(
        "手动签到：{}",
        targets
            .iter()
            .map(|id| app_meta(*id).name)
            .collect::<Vec<_>>()
            .join("、")
    ));

    for id in targets {
        let readiness = readiness_for(app, id);
        if !readiness.ready {
            write_runtime(
                app,
                id,
                AppRuntimePatch {
                    status: Some(readiness.status.unwrap_or_else(|| readiness_status(id))),
                    message: Some(readiness.message.clone()),
                    last_attempt_date: Some(Some(date_key(id))),
                    last_attempt_at: Some(Some(now_iso())),
                    attempts: Some(attempts_for(app, id).max(1)),
                    ..Default::default()
                },
            );
            state.logger.warn(
                format!("{}：{}", app_meta(id).name, readiness.message),
                Some(id),
            );
            continue;
        }
        execute(app, id).await;
    }
    emit_state(app);
}

async fn execute(app: &AppHandle, id: AppId) -> RunStatus {
    let state = app.state::<AppState>();
    let started_at = now_iso();
    let today = date_key(id);
    let attempts = attempts_for(app, id) + 1;

    write_runtime(
        app,
        id,
        AppRuntimePatch {
            status: Some(RunStatus::Running),
            message: Some("正在签到…".into()),
            attempts: Some(attempts),
            last_attempt_date: Some(Some(today.clone())),
            last_attempt_at: Some(Some(started_at)),
            ..Default::default()
        },
    );
    emit_state(app);
    state
        .logger
        .log(LogLevel::Info, Some(id), format!("开始签到 {}", app_meta(id).name));

    let ctx = context_for(app, id);
    let outcome = checkin::adapter_for(id).check_in(ctx).await;
    let status = outcome.status;
    apply_outcome(app, id, outcome, attempts);
    status
}

fn apply_outcome(app: &AppHandle, id: AppId, outcome: Outcome, attempts: u32) {
    let state = app.state::<AppState>();
    let name = app_meta(id).name;
    let today = date_key(id);
    let current = runtime_of(app, id);

    match outcome.status {
        RunStatus::Success | RunStatus::Already => {
            let already = outcome.status == RunStatus::Already;
            let first = current.last_success_date.as_deref() != Some(today.as_str());
            write_runtime(
                app,
                id,
                AppRuntimePatch {
                    status: Some(if already {
                        RunStatus::Already
                    } else {
                        RunStatus::Success
                    }),
                    message: Some(outcome.message.clone()),
                    credits: Some(outcome.credits.or(current.credits)),
                    today_checked_in: Some(Some(true)),
                    probe_date: Some(Some(today.clone())),
                    last_success_date: Some(Some(today)),
                    last_success_at: Some(Some(if first || current.last_success_at.is_none() {
                        now_iso()
                    } else {
                        current.last_success_at.clone().unwrap_or_else(now_iso)
                    })),
                    ..Default::default()
                },
            );
            if already {
                state
                    .logger
                    .log(LogLevel::Info, Some(id), format!("{name}：{}", outcome.message));
            } else {
                state.logger.success(format!("{name}：{}", outcome.message), id);
            }
        }
        RunStatus::NeedsSetup | RunStatus::NeedsAuth | RunStatus::Unavailable => {
            write_runtime(
                app,
                id,
                AppRuntimePatch {
                    status: Some(outcome.status),
                    message: Some(outcome.message.clone()),
                    credits: Some(outcome.credits.or(current.credits)),
                    ..Default::default()
                },
            );
            state
                .logger
                .warn(format!("{name}：{}", outcome.message), Some(id));
        }
        RunStatus::Failed => {
            let will_retry = attempts < MAX_ATTEMPTS;
            let suffix = if will_retry {
                format!("，10 分钟后第 {} 次尝试", attempts + 1)
            } else {
                "，今日不再重试".to_string()
            };
            write_runtime(
                app,
                id,
                AppRuntimePatch {
                    status: Some(RunStatus::Failed),
                    message: Some(format!("{}{}", outcome.message, suffix)),
                    attempts: Some(attempts),
                    last_attempt_date: Some(Some(today)),
                    last_attempt_at: Some(Some(now_iso())),
                    ..Default::default()
                },
            );
            state.logger.error(
                format!("{name}：{}{}", outcome.message, suffix),
                Some(id),
            );
        }
        _ => {
            write_runtime(
                app,
                id,
                AppRuntimePatch {
                    status: Some(RunStatus::Idle),
                    message: Some(outcome.message.clone()),
                    today_checked_in: Some(Some(false)),
                    ..Default::default()
                },
            );
            state
                .logger
                .log(LogLevel::Info, Some(id), format!("{name}：{}", outcome.message));
        }
    }
    emit_state(app);
}

fn apply_probe(app: &AppHandle, id: AppId, probe: ProbeResult) {
    let state = app.state::<AppState>();
    let name = app_meta(id).name;
    let today = date_key(id);
    let current = runtime_of(app, id);

    if current.status == RunStatus::Running {
        return;
    }
    if current.status == RunStatus::Cancelled
        && current.last_attempt_date.as_deref() == Some(today.as_str())
        && !probe.checked_in
    {
        return;
    }

    if probe.checked_in {
        let first = current.last_success_date.as_deref() != Some(today.as_str());
        write_runtime(
            app,
            id,
            AppRuntimePatch {
                status: Some(RunStatus::Already),
                message: Some(if probe.message.is_empty() {
                    "今日已签到".into()
                } else {
                    probe.message.clone()
                }),
                credits: Some(probe.credits.or(current.credits)),
                today_checked_in: Some(Some(true)),
                probe_date: Some(Some(today.clone())),
                last_success_date: Some(Some(today)),
                last_success_at: Some(Some(if first || current.last_success_at.is_none() {
                    now_iso()
                } else {
                    current.last_success_at.clone().unwrap_or_else(now_iso)
                })),
                ..Default::default()
            },
        );
        state.logger.log(
            LogLevel::Info,
            Some(id),
            format!(
                "{name}：{}",
                if probe.message.is_empty() {
                    "今日已签到"
                } else {
                    probe.message.as_str()
                }
            ),
        );
        return;
    }

    if current.last_success_date.as_deref() == Some(today.as_str()) {
        return;
    }

    match probe.status {
        RunStatus::Failed => {
            write_runtime(
                app,
                id,
                AppRuntimePatch {
                    status: Some(RunStatus::Failed),
                    message: Some(probe.message.clone()),
                    today_checked_in: Some(Some(false)),
                    probe_date: Some(Some(today)),
                    ..Default::default()
                },
            );
            state.logger.warn(
                format!("{name}：状态检测失败：{}", probe.message),
                Some(id),
            );
        }
        RunStatus::NeedsSetup | RunStatus::NeedsAuth | RunStatus::Unavailable => {
            write_runtime(
                app,
                id,
                AppRuntimePatch {
                    status: Some(probe.status),
                    message: Some(probe.message.clone()),
                    today_checked_in: Some(Some(false)),
                    probe_date: Some(Some(today)),
                    ..Default::default()
                },
            );
            state
                .logger
                .warn(format!("{name}：{}", probe.message), Some(id));
        }
        _ => {
            write_runtime(
                app,
                id,
                AppRuntimePatch {
                    status: Some(RunStatus::Idle),
                    message: Some("今日待签到".into()),
                    today_checked_in: Some(Some(false)),
                    probe_date: Some(Some(today)),
                    ..Default::default()
                },
            );
            state
                .logger
                .log(LogLevel::Info, Some(id), format!("{name}：今日待签到"));
        }
    }
}

fn roll_date(app: &AppHandle) {
    let state = app.state::<AppState>();
    let today = local_date_key();
    let changed = state
        .today
        .lock()
        .map(|mut current| {
            if *current == today {
                false
            } else {
                *current = today.clone();
                true
            }
        })
        .unwrap_or(false);
    if changed {
        if let Ok(mut store) = state.store.lock() {
            store.normalize_today();
        }
        state.logger.info("日期已更新，签到状态已重置");
        emit_state(app);
    }
}

fn active_app_ids(app: &AppHandle) -> Vec<AppId> {
    let config = current_config(app);
    visible_app_ids(&config.settings)
}

fn due_apps(app: &AppHandle) -> Vec<AppId> {
    let config = current_config(app);
    if !config.settings.master_enabled {
        return Vec::new();
    }
    visible_app_ids(&config.settings)
        .into_iter()
        .filter(|id| {
            let Some(app_config) = config.apps.get(id) else {
                return false;
            };
            if !app_config.enabled {
                return false;
            }
            if done_today(&config, *id) {
                return false;
            }
            if !is_time_reached(&schedule_time(&config, *id)) {
                return false;
            }
            !settled_today(&config, *id)
        })
        .collect()
}

fn schedule_time(config: &ConfigFile, id: AppId) -> String {
    config
        .apps
        .get(&id)
        .map(|app| {
            if app.use_custom_time {
                app.time.clone()
            } else {
                config.settings.default_time.clone()
            }
        })
        .unwrap_or_else(|| config.settings.default_time.clone())
}

fn reset_hour(id: AppId) -> u32 {
    match id {
        AppId::Qoder | AppId::QoderCn => 10,
        _ => 0,
    }
}

fn date_key(id: AppId) -> String {
    checkin_date_key(reset_hour(id))
}

fn attempts_for(app: &AppHandle, id: AppId) -> u32 {
    let config = current_config(app);
    config
        .runtime
        .get(&id)
        .filter(|runtime| runtime.last_attempt_date.as_deref() == Some(date_key(id).as_str()))
        .map(|runtime| runtime.attempts)
        .unwrap_or(0)
}

fn done_today(config: &ConfigFile, id: AppId) -> bool {
    let today = date_key(id);
    config
        .runtime
        .get(&id)
        .map(|runtime| {
            runtime.last_success_date.as_deref() == Some(today.as_str())
                || (runtime.probe_date.as_deref() == Some(today.as_str())
                    && runtime.today_checked_in == Some(true))
        })
        .unwrap_or(false)
}

fn settled_today(config: &ConfigFile, id: AppId) -> bool {
    let today = date_key(id);
    let Some(runtime) = config.runtime.get(&id) else {
        return false;
    };
    if runtime.last_attempt_date.as_deref() != Some(today.as_str()) {
        return false;
    }
    if runtime.status == RunStatus::Cancelled {
        return true;
    }
    if matches!(
        runtime.status,
        RunStatus::NeedsSetup | RunStatus::NeedsAuth | RunStatus::Unavailable
    ) {
        return true;
    }
    if runtime.status == RunStatus::Failed {
        if runtime.attempts >= MAX_ATTEMPTS {
            return true;
        }
        let last = runtime
            .last_attempt_at
            .as_deref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|date| date.timestamp_millis())
            .unwrap_or(0);
        return chrono::Utc::now().timestamp_millis() - last < RETRY.as_millis() as i64;
    }
    false
}

fn current_config(app: &AppHandle) -> ConfigFile {
    app.state::<AppState>().config_snapshot()
}

fn runtime_of(app: &AppHandle, id: AppId) -> crate::models::AppRuntime {
    current_config(app)
        .runtime
        .get(&id)
        .cloned()
        .unwrap_or_else(|| RunStatus::default_runtime())
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

fn readiness_for(app: &AppHandle, id: AppId) -> Readiness {
    let state = app.state::<AppState>();
    let (_, contexts) = state.contexts();
    let context = contexts
        .into_iter()
        .find(|(app_id, _)| *app_id == id)
        .map(|(_, context)| context)
        .unwrap_or_default();
    checkin::adapter_for(id).readiness(&context)
}

fn readiness_status(id: AppId) -> RunStatus {
    match id {
        AppId::Qoder | AppId::QoderCn | AppId::Doubao => RunStatus::NeedsSetup,
        _ => RunStatus::NeedsAuth,
    }
}

fn write_runtime(app: &AppHandle, id: AppId, patch: AppRuntimePatch) {
    let state = app.state::<AppState>();
    if let Ok(mut store) = state.store.lock() {
        store.update_runtime(id, patch);
    };
}

fn emit_state(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _ = app.emit("state:update", state.bootstrap());
}

#[allow(dead_code)]
fn _contexts_map(app: &AppHandle) -> HashMap<AppId, AdapterContext> {
    app.state::<AppState>()
        .contexts()
        .1
        .into_iter()
        .collect()
}
