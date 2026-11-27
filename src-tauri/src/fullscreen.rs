use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Default)]
pub struct NotificationState {
    pub suppressed: bool,
    pub reason: &'static str,
}

static CACHE: Mutex<Option<(Instant, NotificationState)>> = Mutex::new(None);

pub fn get_notification_state(force: bool) -> NotificationState {
    if !force {
        if let Ok(cache) = CACHE.lock() {
            if let Some((at, value)) = cache.as_ref() {
                if at.elapsed() < Duration::from_millis(2500) {
                    return value.clone();
                }
            }
        }
    }

    let value = query();
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((Instant::now(), value.clone()));
    }
    value
}

#[cfg(windows)]
fn query() -> NotificationState {
    use windows_sys::Win32::UI::Shell::SHQueryUserNotificationState;

    let mut state: i32 = 0;
    let result = unsafe { SHQueryUserNotificationState(&mut state as *mut i32 as *mut _) };
    if result < 0 {
        return NotificationState::default();
    }
    let reason = match state {
        1 => "屏幕已锁定或暂无前台用户",
        2 => "系统处于忙碌状态",
        3 => "检测到全屏应用或游戏",
        4 => "检测到演示模式",
        6 => "系统处于静音时间",
        7 => "检测到全屏应用",
        _ => "",
    };
    NotificationState {
        suppressed: matches!(state, 1 | 2 | 3 | 4 | 6 | 7),
        reason,
    }
}

#[cfg(not(windows))]
fn query() -> NotificationState {
    NotificationState::default()
}
