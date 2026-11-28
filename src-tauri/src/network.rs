use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::models::now_iso;
use crate::state::AppState;

const PROBE_URLS: [&str; 2] = ["https://www.baidu.com/", "https://www.qq.com/"];
const ONLINE_INTERVAL: Duration = Duration::from_secs(30);
const OFFLINE_INTERVAL: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(4);

/// 周期性检测外网连通性；断网恢复后自动重新探测签到状态并补签。
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        let mut online = check().await;
        apply(&app, online);
        loop {
            tokio::time::sleep(if online {
                ONLINE_INTERVAL
            } else {
                OFFLINE_INTERVAL
            })
            .await;
            let next = check().await;
            if next == online {
                continue;
            }
            online = next;
            apply(&app, online);
            {
                let state = app.state::<AppState>();
                if online {
                    state.logger.info("网络已恢复，重新检测签到状态");
                } else {
                    state.logger.warn("网络已断开，等待联网后自动重试", None);
                }
            }
            if online {
                crate::scheduler::probe_all(&app, None).await;
                crate::scheduler::tick(&app).await;
            }
        }
    });
}

fn apply(app: &AppHandle, online: bool) {
    let state = app.state::<AppState>();
    state.network_online.store(online, Ordering::Relaxed);
    if let Ok(mut checked) = state.network_checked_at.lock() {
        *checked = Some(now_iso());
    }
    crate::commands::emit_state(app);
}

async fn check() -> bool {
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(REQUEST_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
    else {
        return false;
    };
    for url in PROBE_URLS {
        if client.get(url).send().await.is_ok() {
            return true;
        }
    }
    false
}
