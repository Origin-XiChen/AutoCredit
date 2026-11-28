use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder,
};
use tokio::sync::oneshot;

use crate::models::{
    app_meta, AppId, PopupApp, PopupData, PopupResult, PopupTone, POPUP_SECONDS,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PopupOutcome {
    Cancelled,
    Started,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PopupPhasePayload {
    phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<PopupResult>,
}

struct Session {
    data: PopupData,
    cancel_tx: Option<oneshot::Sender<()>>,
    result_tx: Option<oneshot::Sender<PopupOutcome>>,
}

#[derive(Default)]
pub struct PopupController {
    session: Mutex<Option<Session>>,
}

impl PopupController {
    pub fn data(&self) -> Option<PopupData> {
        self.session
            .lock()
            .ok()
            .and_then(|session| session.as_ref().map(|s| s.data.clone()))
    }

    pub fn cancel(&self) {
        if let Ok(mut guard) = self.session.lock() {
            if let Some(session) = guard.as_mut() {
                if let Some(tx) = session.cancel_tx.take() {
                    let _ = tx.send(());
                }
            }
        }
    }

    fn is_active(&self) -> bool {
        self.session
            .lock()
            .map(|session| session.is_some())
            .unwrap_or(false)
    }

    fn take(&self) -> Option<Session> {
        self.session.lock().ok().and_then(|mut session| session.take())
    }
}

pub async fn show(app: AppHandle, controller: &PopupController, ids: Vec<AppId>) -> PopupOutcome {
    if ids.is_empty() || controller.is_active() {
        return PopupOutcome::Cancelled;
    }

    let apps = ids
        .iter()
        .map(|id| PopupApp {
            id: *id,
            name: app_meta(*id).name.to_string(),
        })
        .collect::<Vec<_>>();
    let data = PopupData {
        apps: apps.clone(),
        seconds: POPUP_SECONDS,
    };

    let (cancel_tx, cancel_rx) = oneshot::channel();
    let (result_tx, result_rx) = oneshot::channel();
    if let Ok(mut guard) = controller.session.lock() {
        *guard = Some(Session {
            data: data.clone(),
            cancel_tx: Some(cancel_tx),
            result_tx: Some(result_tx),
        });
    } else {
        return PopupOutcome::Cancelled;
    }

    let height = 124.0 + data.apps.len() as f64 * 16.0;
    if let Some(existing) = app.get_webview_window("popup") {
        let _ = existing.close();
    }
    let builder = WebviewWindowBuilder::new(&app, "popup", WebviewUrl::App("popup.html".into()))
        .title("AutoCredit")
        .inner_size(372.0, height.min(320.0))
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .closable(false)
        .shadow(false)
        .visible(false);

    let Ok(window) = builder.build() else {
        let _ = controller.take();
        return PopupOutcome::Cancelled;
    };
    position(&window);
    let _ = window.show();

    let app_handle = app.clone();
    tokio::spawn(async move {
        let cancelled = tokio::select! {
            _ = cancel_rx => true,
            _ = tokio::time::sleep(Duration::from_secs(POPUP_SECONDS)) => false,
        };
        if cancelled {
            settle(app_handle, PopupOutcome::Cancelled).await;
        } else {
            start_running(app_handle).await;
        }
    });

    result_rx.await.unwrap_or(PopupOutcome::Cancelled)
}

async fn start_running(app: AppHandle) {
    let state = app.state::<crate::state::AppState>();
    let started = {
        let Ok(mut guard) = state.popup.session.lock() else {
            return;
        };
        let Some(session) = guard.as_mut() else {
            return;
        };
        // 倒计时结束后不再允许取消，并通知弹出窗口进入签到中状态。
        session.cancel_tx = None;
        match session.result_tx.take() {
            Some(tx) => tx.send(PopupOutcome::Started).is_ok(),
            None => false,
        }
    };
    if started {
        let _ = app.emit_to(
            "popup",
            "popup:phase",
            PopupPhasePayload {
                phase: "running",
                result: None,
            },
        );
    }
}

/// 签到流程结束后更新弹窗状态：先展示每个程序的结果，停留几秒后再淡出关闭。
pub async fn finish(app: &AppHandle, result: PopupResult) {
    let state = app.state::<crate::state::AppState>();
    if state.popup.take().is_none() {
        return;
    }
    let phase = match result.tone {
        PopupTone::Success => "success",
        PopupTone::Notice => "notice",
        PopupTone::Error => "error",
    };
    let _ = app.emit_to(
        "popup",
        "popup:phase",
        PopupPhasePayload {
            phase,
            result: Some(result),
        },
    );
    tokio::time::sleep(Duration::from_millis(5000)).await;
    let _ = app.emit_to("popup", "popup:dismiss", ());
    tokio::time::sleep(Duration::from_millis(180)).await;
    if let Some(window) = app.get_webview_window("popup") {
        let _ = window.close();
    }
}

async fn settle(app: AppHandle, outcome: PopupOutcome) {
    let state = app.state::<crate::state::AppState>();
    let Some(session) = state.popup.take() else {
        return;
    };

    let _ = app.emit_to("popup", "popup:dismiss", ());
    tokio::time::sleep(Duration::from_millis(180)).await;
    if let Some(window) = app.get_webview_window("popup") {
        let _ = window.close();
    }
    if let Some(tx) = session.result_tx {
        let _ = tx.send(outcome);
    }
}

fn position(window: &tauri::WebviewWindow) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window.outer_size().unwrap_or(tauri::PhysicalSize::new(372, 140));
    let (right, bottom) = work_area().unwrap_or_else(|| {
        let monitor = window
            .current_monitor()
            .ok()
            .flatten()
            .or_else(|| window.primary_monitor().ok().flatten());
        match monitor {
            Some(monitor) => {
                let origin = monitor.position();
                let area = monitor.size();
                (
                    origin.x + area.width as i32,
                    origin.y + area.height as i32 - (80.0 * scale) as i32,
                )
            }
            None => (1920, 1080),
        }
    });
    let x = right - size.width as i32 - (18.0 * scale) as i32;
    let y = bottom - size.height as i32 - (24.0 * scale) as i32;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

#[cfg(windows)]
fn work_area() -> Option<(i32, i32)> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPI_GETWORKAREA,
    };

    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            &mut rect as *mut RECT as *mut _,
            0,
        )
    };
    if ok == 0 {
        return None;
    }
    Some((rect.right, rect.bottom))
}

#[cfg(not(windows))]
fn work_area() -> Option<(i32, i32)> {
    None
}
