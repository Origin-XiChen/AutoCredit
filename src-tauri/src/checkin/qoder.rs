use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use reqwest::Method;
use serde::Deserialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::models::{AppId, DetectResult, RunStatus};

use super::paths::{expand_user_path, unique_paths};
use super::{
    as_record, describe_http_error, pick_number, pick_string, request, Adapter, AdapterContext,
    Outcome, ProbeResult, Readiness,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QoderMode {
    Global,
    Cn,
}

impl QoderMode {
    fn key(self) -> &'static str {
        match self {
            QoderMode::Global => "global",
            QoderMode::Cn => "cn",
        }
    }

    fn open_api(self) -> &'static str {
        match self {
            QoderMode::Global => "https://openapi.qoder.sh",
            QoderMode::Cn => "https://openapi.qoder.com.cn",
        }
    }

    fn environment(self) -> &'static str {
        match self {
            QoderMode::Global => "3",
            QoderMode::Cn => "0",
        }
    }

    fn label(self) -> &'static str {
        match self {
            QoderMode::Global => "Qoder",
            QoderMode::Cn => "Qoder CN",
        }
    }
}

#[derive(Clone, Debug)]
struct MachineIdentity {
    machine_token: String,
    machine_code: String,
    machine_type: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Campaign {
    campaign_id: Option<String>,
    claim_status: Option<String>,
    action_type: Option<String>,
    claimable: Option<bool>,
    benefit: Option<Benefit>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Benefit {
    kind: Option<String>,
    amount: Option<f64>,
}

fn identity_cache() -> &'static Mutex<HashMap<String, (MachineIdentity, i64)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (MachineIdentity, i64)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn umid_candidates(mode: QoderMode, custom_exe_path: Option<&str>) -> Vec<PathBuf> {
    if let Ok(custom) = std::env::var("QODER_UMID_EXE") {
        if !custom.trim().is_empty() {
            return vec![PathBuf::from(expand_user_path(&custom))];
        }
    }

    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let program_files =
        std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());

    let mut paths: Vec<PathBuf> = Vec::new();
    if let Some(custom) = custom_exe_path {
        let value = expand_user_path(custom);
        if !value.is_empty() {
            let path = PathBuf::from(value.as_str());
            if value.to_lowercase().ends_with(".exe") {
                let is_runtime = path
                    .file_name()
                    .map(|name| name.to_string_lossy().eq_ignore_ascii_case("runtime-info.exe"))
                    .unwrap_or(false);
                if is_runtime {
                    paths.push(path);
                } else if let Some(parent) = path.parent() {
                    paths.push(
                        parent
                            .join("resources")
                            .join("umid")
                            .join("runtime-info.exe"),
                    );
                }
            } else {
                paths.push(
                    path.join("resources")
                        .join("umid")
                        .join("runtime-info.exe"),
                );
            }
        }
    }

    let umid = |base: PathBuf| {
        base.join("resources")
            .join("umid")
            .join("runtime-info.exe")
    };
    let local_programs = PathBuf::from(local.as_str()).join("Programs");
    let program_files_root = PathBuf::from(program_files.as_str());
    let defaults = match mode {
        QoderMode::Cn => vec![
            umid(local_programs.join("Qoder CN")),
            umid(local_programs.join("Qoder")),
            umid(program_files_root.join("Qoder CN")),
            umid(program_files_root.join("Qoder")),
        ],
        QoderMode::Global => vec![
            umid(local_programs.join("Qoder")),
            umid(program_files_root.join("Qoder")),
        ],
    };
    paths.extend(defaults);
    unique_paths(paths)
}

async fn run_umid(exe: &Path, environment: &str, account_id: &str) -> Result<String, String> {
    let mut command = Command::new(exe);
    command
        .arg(environment)
        .arg("--account-stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|error| error.to_string())?;

    if let Some(mut stdin) = child.stdin.take() {
        let payload = serde_json::json!({ "account": account_id }).to_string();
        let _ = stdin.write_all(payload.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }

    let output = tokio::time::timeout(Duration::from_millis(10_000), child.wait_with_output())
        .await
        .map_err(|_| "设备校验超时".to_string())?
        .map_err(|error| error.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !stderr.is_empty() {
            return Err(stderr);
        }
        let code = output
            .status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "null".to_string());
        return Err(format!("设备校验组件退出 {code}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

async fn resolve_machine_identity(
    mode: QoderMode,
    account_id: &str,
    custom_exe_path: Option<&str>,
) -> Option<MachineIdentity> {
    let key = format!("{}:{}", mode.key(), account_id);
    let now = chrono::Utc::now().timestamp_millis();
    if let Ok(cache) = identity_cache().lock() {
        if let Some((identity, at)) = cache.get(&key) {
            if now - at < 30 * 60 * 1000 {
                return Some(identity.clone());
            }
        }
    }

    for exe in umid_candidates(mode, custom_exe_path) {
        if !exe.exists() {
            continue;
        }
        let Ok(output) = run_umid(&exe, mode.environment(), account_id).await else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(output.trim()) else {
            continue;
        };
        if as_record(&value).is_none() {
            continue;
        }
        let identity = MachineIdentity {
            machine_token: pick_string(&value, &["machineToken"]).unwrap_or_default(),
            machine_code: pick_string(&value, &["machineCode"]).unwrap_or_default(),
            machine_type: pick_string(&value, &["machineType"]).unwrap_or_default(),
        };
        if identity.machine_token.is_empty()
            || identity.machine_code.is_empty()
            || identity.machine_type.is_empty()
        {
            continue;
        }
        if let Ok(mut cache) = identity_cache().lock() {
            cache.insert(key.clone(), (identity.clone(), now));
        }
        return Some(identity);
    }
    None
}

fn find_daily_campaign(campaigns: &[Campaign]) -> Option<Campaign> {
    let is_claim = |item: &&Campaign| item.action_type.as_deref() == Some("CLAIM_BENEFIT");
    campaigns
        .iter()
        .find(|item| {
            is_claim(item)
                && (item.benefit.as_ref().and_then(|b| b.kind.as_deref()) == Some("CREDITS")
                    || item.benefit.as_ref().and_then(|b| b.amount) == Some(100.0))
        })
        .or_else(|| campaigns.iter().find(is_claim))
        .cloned()
}

fn campaign_amount(campaign: &Campaign) -> i64 {
    campaign
        .benefit
        .as_ref()
        .and_then(|benefit| benefit.amount)
        .map(|amount| amount as i64)
        .unwrap_or(100)
}

fn encode_uri_component(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{:02X}", byte));
        }
    }
    output
}

fn last_chars(value: &str, count: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    let start = chars.len().saturating_sub(count);
    chars[start..].iter().collect()
}

fn error_outcome(message: &str, fallback: &str) -> Outcome {
    let message = if message.is_empty() {
        fallback
    } else {
        message
    };
    if message == "NO_PAT" {
        return Outcome {
            status: RunStatus::NeedsSetup,
            message: "尚未保存 Qoder 个人访问令牌（PAT）".into(),
            credits: None,
        };
    }
    if message == "BAD_PAT" {
        return Outcome {
            status: RunStatus::NeedsAuth,
            message: "个人访问令牌无效或已过期，请重新生成并保存".into(),
            credits: None,
        };
    }
    Outcome {
        status: RunStatus::Failed,
        message: message.to_string(),
        credits: None,
    }
}

struct QoderUser {
    id: String,
    email: Option<String>,
    name: Option<String>,
}

struct QoderContext {
    job_token: String,
    identity: Option<MachineIdentity>,
    campaigns: Vec<Campaign>,
}

pub struct QoderAdapter {
    #[allow(dead_code)]
    id: AppId,
    mode: QoderMode,
}

impl QoderAdapter {
    pub fn new(id: AppId, mode: QoderMode) -> Self {
        Self { id, mode }
    }

    fn exchange_headers() -> Vec<(&'static str, String)> {
        vec![
            ("Content-Type", "application/json".into()),
            ("Accept", "application/json".into()),
            ("User-Agent", "AutoCredit/1.0".into()),
            ("Cosy-Version", "1.0.1".into()),
            ("Cosy-ClientType", "5".into()),
        ]
    }

    async fn exchange_pat(&self, pat: &str) -> Result<String, String> {
        if pat.is_empty() {
            return Err("NO_PAT".into());
        }
        let url = format!("{}/api/v1/jobToken/exchange", self.mode.open_api());
        let body = serde_json::json!({ "personal_token": pat });
        let headers = Self::exchange_headers();
        let response = request(Method::POST, &url, &headers, Some(body), 15_000).await?;
        if response.status == 401 || response.status == 403 {
            return Err("BAD_PAT".into());
        }
        if !response.ok {
            return Err(describe_http_error(&response, "个人访问令牌交换失败"));
        }
        response
            .json
            .as_ref()
            .and_then(|json| pick_string(json, &["token"]))
            .ok_or_else(|| "个人访问令牌交换未返回有效令牌".to_string())
    }

    async fn user_info(&self, job_token: &str) -> Result<QoderUser, String> {
        let url = format!("{}/api/v1/userinfo", self.mode.open_api());
        let headers = vec![
            ("Authorization", format!("Bearer {job_token}")),
            ("Accept", "application/json".into()),
            ("User-Agent", "AutoCredit/1.0".into()),
            ("Cosy-Version", "1.0.1".into()),
            ("Cosy-ClientType", "5".into()),
        ];
        let response = request(Method::GET, &url, &headers, None, 15_000).await?;
        if response.status == 401 || response.status == 403 {
            return Err("BAD_PAT".into());
        }
        if !response.ok {
            return Err(describe_http_error(&response, "读取 Qoder 账号信息失败"));
        }
        let json = response.json.as_ref();
        Ok(QoderUser {
            id: json
                .and_then(|value| pick_string(value, &["id"]))
                .unwrap_or_default(),
            email: json.and_then(|value| pick_string(value, &["email"])),
            name: json.and_then(|value| pick_string(value, &["name", "username"])),
        })
    }

    fn sash_headers(
        &self,
        job_token: &str,
        identity: Option<&MachineIdentity>,
        machine_id: &str,
    ) -> Vec<(&'static str, String)> {
        let machine_os = if std::env::consts::ARCH == "aarch64" {
            "aarch64_windows"
        } else {
            "x86_64_windows"
        };
        let hostname = std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "localhost".to_string());
        let mut headers = vec![
            ("Authorization", format!("Bearer {job_token}")),
            ("Accept", "application/json".into()),
            ("Content-Type", "application/json".into()),
            ("Cosy-ClientType", "10".into()),
            ("Cosy-Version", "1.13.3".into()),
            ("Cosy-MachineId", machine_id.to_string()),
            ("Cosy-MachineOS", machine_os.to_string()),
            ("Cosy-MachineHostname", hostname),
            ("User-Agent", "Qoder".into()),
        ];
        if let Some(identity) = identity {
            headers.push(("Cosy-MachineToken", identity.machine_token.clone()));
            headers.push(("Cosy-MachineCode", identity.machine_code.clone()));
            headers.push(("Cosy-MachineType", identity.machine_type.clone()));
        }
        headers
    }

    async fn campaigns(
        &self,
        job_token: &str,
        identity: Option<&MachineIdentity>,
        machine_id: &str,
    ) -> Result<Vec<Campaign>, String> {
        let url = format!(
            "{}/sash/api/v1/me/campaigns?forceRefresh=true",
            self.mode.open_api()
        );
        let headers = self.sash_headers(job_token, identity, machine_id);
        let response = request(Method::GET, &url, &headers, None, 15_000).await?;
        if response.status == 401 || response.status == 403 {
            return Err("BAD_PAT".into());
        }
        if !response.ok {
            return Err(describe_http_error(&response, "读取 Qoder 签到活动失败"));
        }
        let list = response
            .json
            .as_ref()
            .and_then(|json| json.get("campaigns"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(list
            .iter()
            .filter_map(|value| serde_json::from_value::<Campaign>(value.clone()).ok())
            .collect())
    }

    async fn claim(
        &self,
        job_token: &str,
        identity: Option<&MachineIdentity>,
        machine_id: &str,
        campaign_id: &str,
    ) -> Result<Value, String> {
        let url = format!(
            "{}/sash/api/v1/me/campaigns/{}/claim",
            self.mode.open_api(),
            encode_uri_component(campaign_id)
        );
        let headers = self.sash_headers(job_token, identity, machine_id);
        let response = request(
            Method::POST,
            &url,
            &headers,
            Some(serde_json::json!({})),
            20_000,
        )
        .await?;
        if response.status == 401 || response.status == 403 {
            return Err("BAD_PAT".into());
        }
        if !response.ok {
            return Err(describe_http_error(&response, "领取 Qoder Credits 失败"));
        }
        Ok(response.json.unwrap_or(Value::Null))
    }

    async fn load_context(&self, ctx: &AdapterContext) -> Result<QoderContext, String> {
        let job_token = self.exchange_pat(&ctx.pat).await?;
        let user = self.user_info(&job_token).await?;
        let identity = if user.id.is_empty() {
            None
        } else {
            resolve_machine_identity(self.mode, &user.id, ctx.custom_exe_path.as_deref()).await
        };
        let campaigns = self
            .campaigns(&job_token, identity.as_ref(), &ctx.machine_id)
            .await?;
        Ok(QoderContext {
            job_token,
            identity,
            campaigns,
        })
    }
}

#[async_trait]
impl Adapter for QoderAdapter {
    fn readiness(&self, ctx: &AdapterContext) -> Readiness {
        if ctx.pat.is_empty() {
            return Readiness {
                ready: false,
                message: format!("未配置 {} 个人访问令牌", self.mode.label()),
                status: None,
            };
        }
        Readiness {
            ready: true,
            message: "已保存个人访问令牌".into(),
            status: None,
        }
    }

    async fn detect(&self, ctx: AdapterContext) -> DetectResult {
        if ctx.pat.is_empty() {
            return DetectResult {
                ok: false,
                message: "请先保存个人访问令牌（PAT）".into(),
                user_label: None,
            };
        }
        let result = async {
            let job_token = self.exchange_pat(&ctx.pat).await?;
            self.user_info(&job_token).await
        }
        .await;
        match result {
            Ok(user) => {
                let user_label = user
                    .email
                    .or(user.name)
                    .or_else(|| {
                        if user.id.is_empty() {
                            None
                        } else {
                            Some(format!("用户 {}", last_chars(&user.id, 6)))
                        }
                    });
                DetectResult {
                    ok: true,
                    message: "令牌有效".into(),
                    user_label,
                }
            }
            Err(message) => {
                let outcome = error_outcome(&message, "令牌检测失败");
                DetectResult {
                    ok: false,
                    message: outcome.message,
                    user_label: None,
                }
            }
        }
    }

    async fn probe(&self, ctx: AdapterContext) -> ProbeResult {
        let context = match self.load_context(&ctx).await {
            Ok(context) => context,
            Err(message) => {
                let outcome = error_outcome(&message, "读取 Qoder 签到状态失败");
                let status = if matches!(outcome.status, RunStatus::Success | RunStatus::Already) {
                    RunStatus::Failed
                } else {
                    outcome.status
                };
                return ProbeResult {
                    checked_in: false,
                    status,
                    message: outcome.message,
                    credits: None,
                };
            }
        };

        let campaign = find_daily_campaign(&context.campaigns);
        let Some(campaign) = campaign else {
            return ProbeResult {
                checked_in: false,
                status: RunStatus::Inactive,
                message: "当前没有可领取的签到活动，可能不在活动期内".into(),
                credits: None,
            };
        };
        if campaign
            .campaign_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .is_none()
        {
            return ProbeResult {
                checked_in: false,
                status: RunStatus::Inactive,
                message: "当前没有可领取的签到活动，可能不在活动期内".into(),
                credits: None,
            };
        }

        if campaign.claim_status.as_deref() == Some("CLAIMED") {
            return ProbeResult {
                checked_in: true,
                status: RunStatus::Already,
                message: "今日已领取".into(),
                credits: Some(campaign_amount(&campaign)),
            };
        }
        if campaign.claimable == Some(false) {
            return ProbeResult {
                checked_in: false,
                status: RunStatus::Inactive,
                message: "签到窗口尚未开放或今日暂不可领取".into(),
                credits: None,
            };
        }
        ProbeResult {
            checked_in: false,
            status: RunStatus::Idle,
            message: "今日待领取".into(),
            credits: Some(campaign_amount(&campaign)),
        }
    }

    async fn check_in(&self, ctx: AdapterContext) -> Outcome {
        let context = match self.load_context(&ctx).await {
            Ok(context) => context,
            Err(message) => return error_outcome(&message, "Qoder 签到失败"),
        };

        let campaign = match find_daily_campaign(&context.campaigns) {
            Some(campaign) => campaign,
            None => {
                return Outcome {
                    status: RunStatus::Inactive,
                    message: "当前没有可领取的签到活动，可能不在活动期内".into(),
                    credits: None,
                };
            }
        };
        let Some(campaign_id) = campaign
            .campaign_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .map(|id| id.to_string())
        else {
            return Outcome {
                status: RunStatus::Unavailable,
                message: "当前没有可领取的签到活动，可能不在活动期内".into(),
                credits: None,
            };
        };
        let amount = campaign_amount(&campaign);
        if campaign.claim_status.as_deref() == Some("CLAIMED") {
            return Outcome {
                status: RunStatus::Already,
                message: "今日已领取，已自动跳过".into(),
                credits: Some(amount),
            };
        }
        if campaign.claimable == Some(false) {
            return Outcome {
                status: RunStatus::Inactive,
                message: "签到窗口尚未开放或今日暂不可领取".into(),
                credits: None,
            };
        }

        let result = match self
            .claim(
                &context.job_token,
                context.identity.as_ref(),
                &ctx.machine_id,
                &campaign_id,
            )
            .await
        {
            Ok(result) => result,
            Err(message) => {
                if super::is_inactive_message(&message) {
                    return Outcome {
                        status: RunStatus::Inactive,
                        message,
                        credits: None,
                    };
                }
                return error_outcome(&message, "Qoder 签到失败");
            }
        };

        let gained = result
            .get("benefit")
            .and_then(|benefit| pick_number(benefit, &["amount"]))
            .unwrap_or(amount);
        let message = pick_string(&result, &["message", "msg"]);
        Outcome {
            status: RunStatus::Success,
            message: match message {
                Some(message) => format!("领取成功：{message}"),
                None if gained != 0 => format!("领取成功，+{gained} Credits"),
                None => "领取成功".into(),
            },
            credits: Some(gained),
        }
    }
}
