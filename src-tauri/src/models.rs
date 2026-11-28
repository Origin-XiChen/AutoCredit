use chrono::{Duration, Local, SecondsFormat, Timelike, Utc};
use serde::{Deserialize, Serialize};

pub const POPUP_SECONDS: u64 = 10;

pub const APP_ORDER: [AppId; 5] = [
    AppId::Trae,
    AppId::Qoder,
    AppId::QoderCn,
    AppId::Workbuddy,
    AppId::Doubao,
];

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum AppId {
    Trae,
    Qoder,
    QoderCn,
    Workbuddy,
    Doubao,
}

impl AppId {
    pub fn as_str(self) -> &'static str {
        match self {
            AppId::Trae => "trae",
            AppId::Qoder => "qoder",
            AppId::QoderCn => "qoder-cn",
            AppId::Workbuddy => "workbuddy",
            AppId::Doubao => "doubao",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        APP_ORDER.iter().copied().find(|id| id.as_str() == value)
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "kebab-case")]
pub enum RunStatus {
    #[default]
    Idle,
    Running,
    Success,
    Already,
    Failed,
    Cancelled,
    NeedsAuth,
    NeedsSetup,
    Unavailable,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    #[default]
    Info,
    Success,
    Warn,
    Error,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    System,
    Light,
    Dark,
}

impl Default for ThemeMode {
    fn default() -> Self {
        Self::System
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub enabled: bool,
    pub use_custom_time: bool,
    pub time: String,
    pub custom_path: Option<String>,
    pub custom_exe_path: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            use_custom_time: false,
            time: "10:10".into(),
            custom_path: None,
            custom_exe_path: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AppRuntime {
    pub status: RunStatus,
    pub message: String,
    pub credits: Option<i64>,
    pub last_success_date: Option<String>,
    pub last_success_at: Option<String>,
    pub last_attempt_at: Option<String>,
    pub last_attempt_date: Option<String>,
    pub attempts: u32,
    pub today_checked_in: Option<bool>,
    pub probe_date: Option<String>,
    pub user_label: Option<String>,
    pub updated_at: Option<String>,
}

impl RunStatus {
    pub fn default_runtime() -> AppRuntime {
        AppRuntime {
            status: RunStatus::Idle,
            message: "等待签到".into(),
            attempts: 0,
            ..Default::default()
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct GlobalSettings {
    pub master_enabled: bool,
    pub default_time: String,
    pub auto_launch: bool,
    pub start_minimized: bool,
    pub close_to_tray: bool,
    pub show_checkin_popup: bool,
    pub theme: ThemeMode,
    pub log_retention_days: u32,
    pub developer_mode: bool,
    pub allow_prerelease: bool,
}

impl Default for GlobalSettings {
    fn default() -> Self {
        Self {
            master_enabled: false,
            default_time: "10:10".into(),
            auto_launch: false,
            start_minimized: true,
            close_to_tray: true,
            show_checkin_popup: true,
            theme: ThemeMode::System,
            log_retention_days: 14,
            developer_mode: false,
            allow_prerelease: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ConfigFile {
    pub version: u32,
    pub settings: GlobalSettings,
    pub apps: std::collections::HashMap<AppId, AppConfig>,
    pub runtime: std::collections::HashMap<AppId, AppRuntime>,
    pub machine_id: String,
    pub created_at: String,
}

impl Default for ConfigFile {
    fn default() -> Self {
        let mut apps = std::collections::HashMap::new();
        let mut runtime = std::collections::HashMap::new();
        for id in APP_ORDER {
            apps.insert(
                id,
                AppConfig {
                    enabled: id != AppId::Doubao,
                    ..Default::default()
                },
            );
            runtime.insert(id, RunStatus::default_runtime());
        }
        Self {
            version: 1,
            settings: GlobalSettings::default(),
            apps,
            runtime,
            machine_id: uuid::Uuid::new_v4().to_string(),
            created_at: now_iso(),
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppMeta {
    pub id: AppId,
    pub name: &'static str,
    pub full_name: &'static str,
    pub description: &'static str,
    pub auto_auth: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pat_url: Option<&'static str>,
    pub account_hint: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkin_reset_hour: Option<u32>,
}

pub fn app_meta(id: AppId) -> AppMeta {
    match id {
        AppId::Trae => AppMeta {
            id,
            name: "Trae CN",
            full_name: "Trae CN",
            description: "读取本机 Trae CN 登录态，自动领取每日签到积分",
            auto_auth: true,
            pat_url: None,
            account_hint: "自动读取本机 Trae CN 客户端登录态",
            note: Some("仅中国版（trae.cn）有每日签到，国际版（trae.ai）无需签到"),
            checkin_reset_hour: None,
        },
        AppId::Qoder => AppMeta {
            id,
            name: "Qoder",
            full_name: "Qoder 国际版",
            description: "使用个人访问令牌领取每日 100 Credits",
            auto_auth: false,
            pat_url: Some("https://qoder.com/account/integrations"),
            account_hint: "需要一次性保存 Qoder 个人访问令牌（PAT）",
            note: Some("每日 10:00 刷新，10:00 前的签到计为前一天；程序会按此边界判断，不会误判为当天已完成"),
            checkin_reset_hour: Some(10),
        },
        AppId::QoderCn => AppMeta {
            id,
            name: "Qoder CN",
            full_name: "Qoder CN / QoderWork",
            description: "使用个人访问令牌领取每日 100 Credits",
            auto_auth: false,
            pat_url: Some("https://qoder.com.cn/account/integrations"),
            account_hint: "需要一次性保存 Qoder CN 个人访问令牌（PAT）",
            note: Some("每日 10:00 刷新，10:00 前的签到计为前一天；程序会按此边界判断，不会误判为当天已完成"),
            checkin_reset_hour: Some(10),
        },
        AppId::Workbuddy => AppMeta {
            id,
            name: "WorkBuddy",
            full_name: "WorkBuddy",
            description: "读取本机 WorkBuddy 登录态，自动领取 Buddy 加油站积分",
            auto_auth: true,
            pat_url: None,
            account_hint: "自动读取本机 WorkBuddy 客户端登录态",
            note: Some("仅中国版（codebuddy.cn）有每日签到，国际版无需签到"),
            checkin_reset_hour: None,
        },
        AppId::Doubao => AppMeta {
            id,
            name: "豆包",
            full_name: "豆包桌面端",
            description: "通过豆包客户端调试端口模拟领取每日额度（实验功能，默认隐藏）",
            auto_auth: true,
            pat_url: None,
            account_hint: "需要本机安装并登录豆包桌面端；签到时会自动启动客户端",
            note: None,
            checkin_reset_hour: None,
        },
    }
}

pub fn visible_app_ids(settings: &GlobalSettings) -> Vec<AppId> {
    APP_ORDER
        .iter()
        .copied()
        .filter(|id| *id != AppId::Doubao || settings.developer_mode)
        .collect()
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatus {
    pub online: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapState {
    pub settings: GlobalSettings,
    pub apps: std::collections::HashMap<AppId, AppConfig>,
    pub runtime: std::collections::HashMap<AppId, AppRuntime>,
    pub metas: Vec<AppMeta>,
    pub secrets: std::collections::HashMap<AppId, bool>,
    pub version: String,
    pub data_dir: String,
    pub logs_dir: String,
    pub is_packaged: bool,
    pub network: NetworkStatus,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: u64,
    pub ts: i64,
    pub level: LogLevel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_id: Option<AppId>,
    #[serde(default)]
    pub message: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PopupApp {
    pub id: AppId,
    pub name: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PopupData {
    pub apps: Vec<PopupApp>,
    pub seconds: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DetectResult {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_label: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SavePatResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocateResult {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exe_path: Option<String>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePhase {
    Checking,
    Latest,
    Available,
    Ready,
    Error,
    Blocked,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub phase: UpdatePhase,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn local_date_key() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// Qoder 系列在 10:00 前仍算前一个签到日。
pub fn checkin_date_key(reset_hour: u32) -> String {
    let now = Local::now();
    let date = if now.hour() < reset_hour {
        now.date_naive() - Duration::days(1)
    } else {
        now.date_naive()
    };
    date.format("%Y-%m-%d").to_string()
}

pub fn is_time_reached(time: &str) -> bool {
    let now = Local::now();
    let mut parts = time.split(':');
    let hour: u32 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let minute: u32 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    (now.hour(), now.minute()) >= (hour, minute)
}
