pub mod doubao;
pub mod paths;
pub mod qoder;
pub mod trae;
pub mod workbuddy;

use std::sync::OnceLock;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use crate::models::{AppId, DetectResult, LocateResult, RunStatus};
use crate::store::Store;

#[derive(Clone, Debug)]
pub struct Outcome {
    pub status: RunStatus,
    pub message: String,
    pub credits: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct ProbeResult {
    pub checked_in: bool,
    pub status: RunStatus,
    pub message: String,
    pub credits: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct Readiness {
    pub ready: bool,
    pub message: String,
    pub status: Option<RunStatus>,
}

/// 判断接口返回是否表示“不在活动时间 / 活动未开放”，这类情况只作为提醒。
pub fn is_inactive_message(message: &str) -> bool {
    const KEYS: [&str; 8] = [
        "不在活动",
        "活动期",
        "活动时间",
        "活动未开始",
        "活动已结束",
        "未到活动",
        "not in activity",
        "activity not",
    ];
    let lower = message.to_lowercase();
    KEYS.iter().any(|key| lower.contains(&key.to_lowercase()))
}

#[derive(Clone, Debug, Default)]
pub struct AdapterContext {
    pub pat: String,
    pub custom_path: Option<String>,
    pub custom_exe_path: Option<String>,
    pub developer_mode: bool,
    pub machine_id: String,
}

impl AdapterContext {
    pub fn from_store(store: &Store, id: AppId) -> Self {
        let app = store.app(id);
        Self {
            pat: store.get_pat(id),
            custom_path: app.custom_path.clone(),
            custom_exe_path: app.custom_exe_path.clone(),
            developer_mode: store.settings().developer_mode,
            machine_id: store.config.machine_id.clone(),
        }
    }
}

#[async_trait]
pub trait Adapter: Send + Sync {
    fn readiness(&self, ctx: &AdapterContext) -> Readiness;
    async fn detect(&self, ctx: AdapterContext) -> DetectResult;
    async fn probe(&self, ctx: AdapterContext) -> ProbeResult;
    async fn check_in(&self, ctx: AdapterContext) -> Outcome;
    fn locate(&self, ctx: &AdapterContext) -> Option<LocateResult> {
        let _ = ctx;
        None
    }
}

pub fn adapter_for(id: AppId) -> Box<dyn Adapter> {
    match id {
        AppId::Trae => Box::new(trae::TraeAdapter),
        AppId::Qoder => Box::new(qoder::QoderAdapter::new(AppId::Qoder, qoder::QoderMode::Global)),
        AppId::QoderCn => Box::new(qoder::QoderAdapter::new(AppId::QoderCn, qoder::QoderMode::Cn)),
        AppId::Workbuddy => Box::new(workbuddy::WorkBuddyAdapter::default()),
        AppId::Doubao => Box::new(doubao::DoubaoAdapter),
    }
}

pub struct HttpResponse {
    pub status: u16,
    pub ok: bool,
    pub json: Option<Value>,
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("AutoCredit/1.0")
            .build()
            .expect("http client")
    })
}

pub async fn request(
    method: reqwest::Method,
    url: &str,
    headers: &[(&str, String)],
    body: Option<Value>,
    timeout_ms: u64,
) -> Result<HttpResponse, String> {
    let mut builder = client()
        .request(method, url)
        .timeout(Duration::from_millis(timeout_ms));
    for (key, value) in headers {
        builder = builder.header(*key, value);
    }
    if let Some(body) = body {
        builder = builder.json(&body);
    }
    let response = builder.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let json = serde_json::from_str::<Value>(&text).ok();
    Ok(HttpResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        json,
    })
}

pub fn as_record(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    value.as_object()
}

pub fn pick_string(value: &Value, keys: &[&str]) -> Option<String> {
    let map = value.as_object()?;
    for key in keys {
        match map.get(*key) {
            Some(Value::String(v)) if !v.is_empty() => return Some(v.clone()),
            Some(Value::Number(v)) => return Some(v.to_string()),
            _ => {}
        }
    }
    None
}

pub fn pick_number(value: &Value, keys: &[&str]) -> Option<i64> {
    let map = value.as_object()?;
    for key in keys {
        match map.get(*key) {
            Some(Value::Number(v)) => {
                if let Some(n) = v.as_i64() {
                    return Some(n);
                }
                if let Some(n) = v.as_f64() {
                    return Some(n as i64);
                }
            }
            Some(Value::String(v)) => {
                if let Ok(n) = v.parse::<i64>() {
                    return Some(n);
                }
            }
            _ => {}
        }
    }
    None
}

pub fn describe_http_error(response: &HttpResponse, action: &str) -> String {
    if let Some(json) = &response.json {
        if let Some(message) = pick_string(json, &["message", "msg", "error"]) {
            return format!("{action}：{message}");
        }
    }
    format!("{action}（HTTP {}）", response.status)
}
