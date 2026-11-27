//! 豆包签到适配器（移植自 src/main/checkin/doubao.ts），通过 CDP 驱动桌面端。

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

use super::paths::{expand_user_path, matching_directories, unique_paths};
use super::{pick_number, pick_string, Adapter, AdapterContext, Outcome, ProbeResult, Readiness};
use crate::models::{DetectResult, LocateResult, RunStatus};

const DEBUG_PORT: u16 = 9222;
const STATUS_PATH: &str = "/alice/ug/campaign/v3/detail/";
const CHECKIN_PATH: &str = "/alice/ug/campaign/landing/checkin";
const LAUNCH_TIMEOUT: u64 = 30_000;

const PAGE_STATE_EXPR: &str = r#"(() => {
  const nodes = [...document.querySelectorAll('button,div,span,a,p')]
  const visible = (el) => {
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const text = (el) => (el.textContent || '').trim()
  const button = nodes.some((el) => text(el) === '立即签到' && visible(el))
  const success = nodes.some((el) => {
    const value = text(el)
    return value.length > 0 && value.length <= 12 && /签到成功|今日已签到|已签到/.test(value) && visible(el)
  })
  return JSON.stringify({ button, success })
})()"#;

const CLICK_POINT_EXPR: &str = r#"(() => {
  const nodes = [...document.querySelectorAll('button,div,span,a')]
  const el = nodes.find((node) => {
    const rect = node.getBoundingClientRect()
    return (node.textContent || '').trim() === '立即签到' && rect.width > 0 && rect.height > 0
  })
  if (!el) return ''
  const rect = el.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) })
})()"#;

#[derive(Deserialize)]
struct CdpTarget {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(rename = "webSocketDebuggerUrl", default)]
    web_socket_debugger_url: Option<String>,
}

#[derive(Default)]
struct PageState {
    button: bool,
    success: bool,
}

struct DoubaoStatus {
    checked_in: bool,
    credits: Option<i64>,
}

struct CheckinResult {
    ok: bool,
    credits: Option<i64>,
    message: Option<String>,
}

#[derive(Default)]
struct NetworkRecorder {
    recording: bool,
    responses: HashMap<String, String>,
    finished: HashSet<String>,
}

type PendingMap = HashMap<u64, oneshot::Sender<Result<Value, String>>>;

/// 最小的 CDP 客户端：请求 id 关联、事件记录与超时处理。
struct CdpSession {
    sender: mpsc::UnboundedSender<String>,
    pending: Arc<Mutex<PendingMap>>,
    next_id: AtomicU64,
    network: Arc<Mutex<NetworkRecorder>>,
    reader: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl CdpSession {
    async fn connect(url: &str, timeout_ms: u64) -> Result<Self, String> {
        let socket = match tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            tokio_tungstenite::connect_async(url),
        )
        .await
        {
            Err(_) => return Err("连接豆包调试端口超时".into()),
            Ok(Err(_)) => return Err("无法连接豆包调试端口".into()),
            Ok(Ok((socket, _))) => socket,
        };

        let (mut sink, mut stream) = socket.split();
        let (sender, mut receiver) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(text) = receiver.recv().await {
                if sink.send(Message::text(text)).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        let pending: Arc<Mutex<PendingMap>> = Arc::new(Mutex::new(HashMap::new()));
        let network = Arc::new(Mutex::new(NetworkRecorder::default()));
        let reader_pending = Arc::clone(&pending);
        let reader_network = Arc::clone(&network);
        let reader = tokio::spawn(async move {
            while let Some(item) = stream.next().await {
                match item {
                    Ok(Message::Text(text)) => handle_message(
                        text.as_str(),
                        reader_pending.as_ref(),
                        reader_network.as_ref(),
                    ),
                    Ok(Message::Close(_)) => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            for (_, sender) in lock(reader_pending.as_ref()).drain() {
                let _ = sender.send(Err("豆包调试连接已断开".into()));
            }
        });

        Ok(Self {
            sender,
            pending,
            next_id: AtomicU64::new(0),
            network,
            reader: Mutex::new(Some(reader)),
        })
    }

    async fn send(&self, method: &str, params: Value, timeout_ms: u64) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (sender, receiver) = oneshot::channel();
        lock(self.pending.as_ref()).insert(id, sender);
        let payload = json!({ "id": id, "method": method, "params": params });
        if self.sender.send(payload.to_string()).is_err() {
            lock(self.pending.as_ref()).remove(&id);
            return Err("发送调试指令失败".into());
        }
        match tokio::time::timeout(Duration::from_millis(timeout_ms), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("豆包调试连接已断开".into()),
            Err(_) => {
                lock(self.pending.as_ref()).remove(&id);
                Err(format!("{method} 超时"))
            }
        }
    }

    async fn start_recording(&self) -> Result<(), String> {
        self.send("Network.enable", json!({ "maxPostDataSize": 262_144 }), 8000)
            .await?;
        let mut recorder = lock(self.network.as_ref());
        recorder.recording = true;
        recorder.responses.clear();
        recorder.finished.clear();
        Ok(())
    }

    fn stop_recording(&self) {
        let mut recorder = lock(self.network.as_ref());
        recorder.recording = false;
        recorder.responses.clear();
        recorder.finished.clear();
    }

    async fn response_for(&self, path: &str, timeout_ms: u64) -> Option<Value> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        while Instant::now() < deadline {
            let ids: Vec<String> = {
                let recorder = lock(self.network.as_ref());
                recorder
                    .responses
                    .iter()
                    .filter(|(request_id, url)| {
                        url.contains(path) && recorder.finished.contains(*request_id)
                    })
                    .map(|(request_id, _)| request_id.to_string())
                    .collect()
            };
            for request_id in ids {
                let params = json!({ "requestId": request_id });
                if let Ok(body) = self.send("Network.getResponseBody", params, 6000).await {
                    if let Some(text) = body.get("body").and_then(Value::as_str) {
                        if !text.is_empty() {
                            if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                                return Some(parsed);
                            }
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(280)).await;
        }
        None
    }

    async fn read_page_state(&self) -> PageState {
        let params = json!({ "expression": PAGE_STATE_EXPR, "returnByValue": true });
        let response = self
            .send("Runtime.evaluate", params, 8000)
            .await
            .unwrap_or(Value::Null);
        let raw = response
            .get("result")
            .and_then(|remote| remote.get("value"))
            .and_then(Value::as_str);
        let Some(raw) = raw else {
            return PageState::default();
        };
        match serde_json::from_str::<Value>(raw) {
            Ok(parsed) => PageState {
                button: parsed.get("button").and_then(Value::as_bool) == Some(true),
                success: parsed.get("success").and_then(Value::as_bool) == Some(true),
            },
            Err(_) => PageState::default(),
        }
    }

    async fn click_check_in(&self, timeout_ms: u64) -> bool {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        while Instant::now() < deadline {
            let params = json!({ "expression": CLICK_POINT_EXPR, "returnByValue": true });
            let response = self
                .send("Runtime.evaluate", params, 6000)
                .await
                .unwrap_or(Value::Null);
            if let Some(raw) = response
                .get("result")
                .and_then(|remote| remote.get("value"))
                .and_then(Value::as_str)
            {
                if !raw.is_empty() {
                    if let Ok(point) = serde_json::from_str::<Value>(raw) {
                        let x = point.get("x").and_then(Value::as_f64);
                        let y = point.get("y").and_then(Value::as_f64);
                        if let (Some(x), Some(y)) = (x, y) {
                            let _ = self
                                .send(
                                    "Input.dispatchMouseEvent",
                                    json!({ "type": "mouseMoved", "x": x, "y": y }),
                                    15_000,
                                )
                                .await;
                            let _ = self
                                .send(
                                    "Input.dispatchMouseEvent",
                                    json!({ "type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1 }),
                                    15_000,
                                )
                                .await;
                            let _ = self
                                .send(
                                    "Input.dispatchMouseEvent",
                                    json!({ "type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1 }),
                                    15_000,
                                )
                                .await;
                            return true;
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        false
    }

    async fn wait_check_in_result(&self, timeout_ms: u64) -> Option<CheckinResult> {
        if let Some(json) = self.response_for(CHECKIN_PATH, timeout_ms).await {
            let data = json.get("data").cloned().unwrap_or(Value::Null);
            if data.get("checked_in").and_then(Value::as_bool) == Some(true) {
                return Some(CheckinResult {
                    ok: true,
                    credits: pick_number(
                        &data,
                        &["reward_amount", "reward", "credits", "quota"],
                    ),
                    message: None,
                });
            }
            let message =
                pick_string(&json, &["msg", "message"]).unwrap_or_else(|| "豆包签到未完成".into());
            return Some(CheckinResult {
                ok: false,
                credits: None,
                message: Some(message),
            });
        }
        if self.read_page_state().await.success {
            return Some(CheckinResult {
                ok: true,
                credits: None,
                message: None,
            });
        }
        None
    }

    fn close(&self) {
        if let Some(handle) = lock(&self.reader).take() {
            handle.abort();
        }
        for (_, sender) in lock(self.pending.as_ref()).drain() {
            let _ = sender.send(Err("豆包调试连接已断开".into()));
        }
    }
}

pub struct DoubaoAdapter;

#[async_trait]
impl Adapter for DoubaoAdapter {
    fn readiness(&self, ctx: &AdapterContext) -> Readiness {
        if !ctx.developer_mode {
            return Readiness {
                ready: false,
                message: "豆包签到属于实验功能，请先在设置中开启开发者模式".into(),
                status: None,
            };
        }
        if find_executable(ctx).is_none() {
            return Readiness {
                ready: false,
                message: "未找到豆包桌面端，请先安装并登录豆包，或在设置中填写客户端路径".into(),
                status: None,
            };
        }
        Readiness {
            ready: true,
            message: "已找到豆包客户端，签到时会自动启动".into(),
            status: None,
        }
    }

    async fn detect(&self, ctx: AdapterContext) -> DetectResult {
        if !ctx.developer_mode {
            return DetectResult {
                ok: false,
                message: "请先在设置中开启开发者模式".into(),
                user_label: None,
            };
        }
        if find_executable(&ctx).is_none() {
            return DetectResult {
                ok: false,
                message: "未找到豆包桌面端，请先安装并登录豆包，或在设置中填写客户端路径".into(),
                user_label: None,
            };
        }
        let Some(session) = open_page(None).await else {
            return DetectResult {
                ok: true,
                message: "已找到豆包客户端，签到时会自动启动".into(),
                user_label: None,
            };
        };
        let state = session.read_page_state().await;
        session.close();
        let message = if state.success {
            "豆包已登录，今日已签到"
        } else if state.button {
            "豆包已登录，今日待签到"
        } else {
            "豆包客户端已就绪，签到时会自动确认状态"
        };
        DetectResult {
            ok: true,
            message: message.into(),
            user_label: None,
        }
    }

    async fn probe(&self, ctx: AdapterContext) -> ProbeResult {
        if !ctx.developer_mode {
            return ProbeResult {
                checked_in: false,
                status: RunStatus::Unavailable,
                message: "开发者模式未开启".into(),
                credits: None,
            };
        }
        if find_executable(&ctx).is_none() {
            return ProbeResult {
                checked_in: false,
                status: RunStatus::NeedsSetup,
                message: "未找到豆包桌面端".into(),
                credits: None,
            };
        }
        let Some(session) = open_page(None).await else {
            return ProbeResult {
                checked_in: false,
                status: RunStatus::Idle,
                message: "豆包客户端未运行，签到时会自动启动".into(),
                credits: None,
            };
        };
        let state = session.read_page_state().await;
        session.close();
        if state.success {
            ProbeResult {
                checked_in: true,
                status: RunStatus::Already,
                message: "今日已签到".into(),
                credits: None,
            }
        } else {
            ProbeResult {
                checked_in: false,
                status: RunStatus::Idle,
                message: "今日待签到".into(),
                credits: None,
            }
        }
    }

    async fn check_in(&self, ctx: AdapterContext) -> Outcome {
        if !ctx.developer_mode {
            return Outcome {
                status: RunStatus::Unavailable,
                message: "开发者模式未开启".into(),
                credits: None,
            };
        }
        if find_executable(&ctx).is_none() {
            return Outcome {
                status: RunStatus::NeedsSetup,
                message: "未找到豆包桌面端，请先安装并登录豆包，或在设置中填写客户端路径".into(),
                credits: None,
            };
        }

        if let Err(message) = ensure_debug_port(&ctx).await {
            return Outcome {
                status: RunStatus::Failed,
                message,
                credits: None,
            };
        }

        let Some(session) = open_page(None).await else {
            return Outcome {
                status: RunStatus::Failed,
                message: "未能连接豆包页面，请稍后重试".into(),
                credits: None,
            };
        };

        let result = run_check_in(&session).await;
        session.stop_recording();
        session.close();
        match result {
            Ok(outcome) => outcome,
            Err(message) => Outcome {
                status: RunStatus::Failed,
                message: format!("豆包签到失败：{message}"),
                credits: None,
            },
        }
    }

    fn locate(&self, ctx: &AdapterContext) -> Option<LocateResult> {
        let exe = find_executable(ctx);
        match exe {
            Some(path) => Some(LocateResult {
                ok: true,
                message: format!("已找到豆包客户端：{}", path.to_string_lossy()),
                data_path: None,
                exe_path: Some(path.to_string_lossy().to_string()),
            }),
            None => Some(LocateResult {
                ok: false,
                message: "未找到豆包客户端，请手动填写 Doubao.exe 或其安装目录".into(),
                data_path: None,
                exe_path: None,
            }),
        }
    }
}

async fn run_check_in(session: &CdpSession) -> Result<Outcome, String> {
    session.start_recording().await?;
    let _ = session.send("Page.enable", json!({}), 6000).await;
    let _ = session.send("Page.reload", json!({}), 6000).await;

    let status_json = session.response_for(STATUS_PATH, 20_000).await;
    let status = status_json.as_ref().and_then(parse_status);
    if let Some(status) = &status {
        if status.checked_in {
            return Ok(Outcome {
                status: RunStatus::Already,
                message: "今日已签到，已自动跳过".into(),
                credits: status.credits,
            });
        }
    }

    if !session.click_check_in(15_000).await {
        return Ok(Outcome {
            status: RunStatus::Failed,
            message: "未找到豆包“立即签到”按钮，请打开豆包确认活动状态".into(),
            credits: None,
        });
    }

    let result = session.wait_check_in_result(25_000).await;
    if let Some(result) = result {
        if result.ok {
            let credits = result.credits.or_else(|| status.and_then(|value| value.credits));
            return Ok(Outcome {
                status: RunStatus::Success,
                message: match credits {
                    Some(value) if value != 0 => format!("签到成功，+{value} 额度"),
                    _ => "签到成功".into(),
                },
                credits,
            });
        }
        return Ok(Outcome {
            status: RunStatus::Failed,
            message: result
                .message
                .unwrap_or_else(|| "未能确认豆包签到结果，请打开客户端查看".into()),
            credits: None,
        });
    }
    Ok(Outcome {
        status: RunStatus::Failed,
        message: "未能确认豆包签到结果，请打开客户端查看".into(),
        credits: None,
    })
}

fn parse_status(json: &Value) -> Option<DoubaoStatus> {
    let data = json.get("data")?;
    let tasks = data.get("tasks")?.as_array()?;
    for item in tasks {
        if item.get("campaign_code").and_then(Value::as_str) != Some("daily_signin") {
            continue;
        }
        let Some(daily) = item.get("daily_checkin") else {
            continue;
        };
        if !daily.is_object() {
            continue;
        }
        let checked_in = daily.get("checked_in_today").and_then(Value::as_bool) == Some(true);
        let credits = daily
            .get("reward")
            .and_then(|reward| pick_number(reward, &["reward_amount", "amount"]));
        return Some(DoubaoStatus {
            checked_in,
            credits,
        });
    }
    None
}

async fn open_page(targets: Option<Vec<CdpTarget>>) -> Option<CdpSession> {
    let list = match targets {
        Some(list) => list,
        None => fetch_targets(1200).await?,
    };
    let page = list.into_iter().find(|target| {
        target.kind == "page"
            && target
                .url
                .as_deref()
                .map(|url| url.contains("doubao-chat/chat"))
                .unwrap_or(false)
    })?;
    let url = page.web_socket_debugger_url?;
    CdpSession::connect(&url, 8000).await.ok()
}

async fn fetch_targets(timeout_ms: u64) -> Option<Vec<CdpTarget>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .no_proxy()
        .build()
        .ok()?;
    let url = format!("http://127.0.0.1:{DEBUG_PORT}/json/list");
    let response = client.get(url).send().await.ok()?;
    let value = response.json::<Value>().await.ok()?;
    let items = value.as_array()?;
    Some(
        items
            .iter()
            .filter_map(|item| serde_json::from_value::<CdpTarget>(item.clone()).ok())
            .collect(),
    )
}

async fn ensure_debug_port(ctx: &AdapterContext) -> Result<(), String> {
    if fetch_targets(800).await.is_some() {
        return Ok(());
    }
    let Some(executable) = find_executable(ctx) else {
        return Err("未找到豆包桌面端，请先安装并登录豆包，或在设置中填写客户端路径".into());
    };
    let mut command = Command::new(&executable);
    command
        .arg(format!("--remote-debugging-port={DEBUG_PORT}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match command.spawn() {
        Ok(child) => drop(child),
        Err(error) => return Err(format!("启动豆包失败：{error}")),
    }

    let deadline = Instant::now() + Duration::from_millis(LAUNCH_TIMEOUT);
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(800)).await;
        if fetch_targets(700).await.is_some() {
            return Ok(());
        }
    }
    Err("未能连接豆包调试端口；若豆包已在运行，请先完全退出豆包后重试".into())
}

fn custom_executable_candidates(ctx: &AdapterContext) -> Vec<PathBuf> {
    let Some(custom) = ctx.custom_exe_path.as_deref() else {
        return Vec::new();
    };
    let value = expand_user_path(custom);
    if value.to_lowercase().ends_with(".exe") {
        return vec![PathBuf::from(value)];
    }
    let base = PathBuf::from(value);
    unique_paths([
        base.join("Doubao.exe"),
        base.join("Application").join("Doubao.exe"),
        base.join("Doubao").join("Application").join("Doubao.exe"),
    ])
}

fn find_executable(ctx: &AdapterContext) -> Option<PathBuf> {
    for candidate in custom_executable_candidates(ctx) {
        if candidate.exists() {
            return Some(candidate);
        }
    }
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let program_files = env_path("ProgramFiles", "C:\\Program Files");
    let program_files_x86 = env_path("ProgramFiles(x86)", "C:\\Program Files (x86)");
    let candidates = [
        PathBuf::from(&local)
            .join("Doubao")
            .join("Application")
            .join("Doubao.exe"),
        PathBuf::from(&local)
            .join("Programs")
            .join("Doubao")
            .join("Application")
            .join("Doubao.exe"),
        PathBuf::from(&program_files)
            .join("Doubao")
            .join("Application")
            .join("Doubao.exe"),
        PathBuf::from(&program_files_x86)
            .join("Doubao")
            .join("Application")
            .join("Doubao.exe"),
    ];
    for candidate in candidates {
        if candidate.exists() {
            return Some(candidate);
        }
    }
    for root in unique_paths([
        PathBuf::from(&local).join("Programs"),
        PathBuf::from(&program_files),
        PathBuf::from(&program_files_x86),
        PathBuf::from(&local),
    ]) {
        for dir in matching_directories(&root, |name| name.to_lowercase().contains("doubao")) {
            for exe in [
                dir.join("Application").join("Doubao.exe"),
                dir.join("Doubao.exe"),
                dir.join("Doubao").join("Application").join("Doubao.exe"),
            ] {
                if exe.exists() {
                    return Some(exe);
                }
            }
        }
        // 兜底：安装目录名完全不带 doubao 时，按可执行文件名扫描一层。
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let base = entry.path();
                for exe in [
                    base.join("Application").join("Doubao.exe"),
                    base.join("Doubao.exe"),
                ] {
                    if exe.exists() {
                        return Some(exe);
                    }
                }
            }
        }
    }
    None
}

fn handle_message(text: &str, pending: &Mutex<PendingMap>, network: &Mutex<NetworkRecorder>) {
    let Ok(message) = serde_json::from_str::<Value>(text) else {
        return;
    };
    if let Some(id) = message.get("id").and_then(Value::as_u64) {
        let Some(sender) = lock(pending).remove(&id) else {
            return;
        };
        let result = match message.get("error") {
            Some(error) => Err(pick_string(error, &["message"])
                .unwrap_or_else(|| "调试指令执行失败".into())),
            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = sender.send(result);
        return;
    }
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return;
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let mut recorder = lock(network);
    if !recorder.recording {
        return;
    }
    match method {
        "Network.responseReceived" => {
            let url = params
                .get("response")
                .and_then(|response| response.get("url"))
                .and_then(Value::as_str);
            let request_id = params.get("requestId").and_then(Value::as_str);
            if let (Some(url), Some(request_id)) = (url, request_id) {
                recorder
                    .responses
                    .insert(request_id.to_string(), url.to_string());
            }
        }
        "Network.loadingFinished" => {
            if let Some(request_id) = params.get("requestId").and_then(Value::as_str) {
                recorder.finished.insert(request_id.to_string());
            }
        }
        _ => {}
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn env_path(name: &str, fallback: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}
