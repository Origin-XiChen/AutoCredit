//! WorkBuddy 签到适配器（移植自 src/main/checkin/workbuddy.ts）。

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::paths::{expand_user_path, matching_directories, unique_paths};
use super::{
    pick_number, pick_string, request, Adapter, AdapterContext, Outcome, ProbeResult, Readiness,
};
use crate::models::{DetectResult, LocateResult, RunStatus};

const DEFAULT_DOMAIN: &str = "www.codebuddy.cn";
const CACHE_TTL_MS: i128 = 10 * 60 * 1000;
const INTERNATIONAL_MESSAGE: &str = "检测到 WorkBuddy 国际版，国际版没有每日签到，无需签到";

/// 由 WorkBuddy.exe 以 ELECTRON_RUN_AS_NODE=1 执行，用于解密登录态。
const HELPER: &str = r#"
const fs = require('node:fs');
const crypto = require('node:crypto');
function parseEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if (value.$wbEncrypted !== 1 || typeof value.envelope !== 'string') return;
  let inner;
  try { inner = JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8')); } catch { return; }
  const nonce = Buffer.from(inner.nonce, 'base64');
  const authTag = Buffer.from(inner.authTag, 'base64');
  const ciphertext = Buffer.from(inner.ciphertext, 'base64');
  if (nonce.length !== 12 || authTag.length !== 16 || !ciphertext.length) return;
  return { suite: inner.suite, keyId: inner.keyId, nonce, authTag, ciphertext };
}
function aad(keyId, suite) {
  const lp = (v) => { const b = Buffer.from(v, 'utf8'); const h = Buffer.allocUnsafe(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]); };
  const s = Buffer.allocUnsafe(4); s.writeUInt32BE(suite);
  return Buffer.concat([Buffer.from('WB-AAD\0', 'ascii'), Buffer.from([1]), lp('WBEV1'), lp('sym-v1'), s, lp(keyId), Buffer.from([2]), Buffer.from([0]), Buffer.from([0])]);
}
try {
  const file = process.argv[2];
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const auth = doc.auth || {};
  const account = doc.account || {};
  let token = auth.accessToken;
  if (token && typeof token === 'object') {
    const raw = String(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet());
    const payload = JSON.parse(raw);
    const key = crypto.createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest();
    const keyId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
    const env = parseEnvelope(token);
    if (!env) throw new Error('credential envelope is invalid');
    if (env.keyId !== keyId) throw new Error('credential key does not match this client');
    const d = crypto.createDecipheriv('aes-256-gcm', key, env.nonce, { authTagLength: 16 });
    d.setAAD(aad(env.keyId, env.suite));
    d.setAuthTag(env.authTag);
    token = Buffer.concat([d.update(env.ciphertext), d.final()]).toString('utf8');
  }
  if (typeof token !== 'string' || !token) throw new Error('no access token');
  process.stdout.write(JSON.stringify({
    token,
    uid: String(account.uid || auth.uid || ''),
    domain: String(auth.domain || 'www.codebuddy.cn'),
    expiresAt: Number(auth.expiresAt) || undefined,
  }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error && error.message ? error.message : 'decrypt failed' }));
}
"#;

#[derive(Clone)]
struct Credential {
    token: String,
    uid: String,
    domain: String,
    expires_at: Option<i64>,
    #[allow(dead_code)]
    source: PathBuf,
}

struct CachedCredential {
    credential: Credential,
    at: i128,
    mtime_ms: i128,
}

struct StatusInfo {
    ok: bool,
    checked_in: bool,
    credits: Option<i64>,
    unauthorized: bool,
    message: String,
}

#[derive(Default)]
pub struct WorkBuddyAdapter {
    cache: Mutex<Option<CachedCredential>>,
}

impl WorkBuddyAdapter {
    async fn read_credential(
        &self,
        ctx: &AdapterContext,
        force: bool,
    ) -> Result<Option<Credential>, String> {
        let Some(file) = find_credential_file(ctx) else {
            return Ok(None);
        };
        let mtime = mtime_ms(&file);
        if !force {
            if let Ok(cache) = self.cache.lock() {
                if let Some(cached) = cache.as_ref() {
                    if cached.mtime_ms == mtime && now_ms() - cached.at < CACHE_TTL_MS {
                        return Ok(Some(cached.credential.clone()));
                    }
                }
            }
        }

        let text = fs::read_to_string(&file).map_err(|error| error.to_string())?;
        let doc: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
        let empty = json!({});
        let auth = doc
            .get("auth")
            .filter(|value| value.is_object())
            .unwrap_or(&empty);
        let account = doc.get("account").unwrap_or(&empty);
        let uid = pick_string(account, &["uid", "id"]).unwrap_or_default();
        let domain = pick_string(auth, &["domain"]).unwrap_or_else(|| DEFAULT_DOMAIN.into());
        let expires_at = pick_number(auth, &["expiresAt"]);
        let raw_token = auth.get("accessToken").and_then(Value::as_str);

        let credential = match raw_token {
            Some(token) if !token.is_empty() => Credential {
                token: token.to_string(),
                uid,
                domain,
                expires_at,
                source: file.clone(),
            },
            _ => decrypt_via_client(ctx, &file).await?,
        };

        if let Ok(mut cache) = self.cache.lock() {
            *cache = Some(CachedCredential {
                credential: credential.clone(),
                at: now_ms(),
                mtime_ms: mtime,
            });
        }
        Ok(Some(credential))
    }

    async fn detect_inner(&self, ctx: &AdapterContext) -> Result<DetectResult, String> {
        let Some(credential) = self.read_credential(ctx, true).await? else {
            return Ok(DetectResult {
                ok: false,
                message: "未找到 WorkBuddy 登录态，请先打开并登录 WorkBuddy".into(),
                user_label: None,
            });
        };
        if is_international_domain(&credential.domain) {
            return Ok(DetectResult {
                ok: true,
                message: INTERNATIONAL_MESSAGE.into(),
                user_label: None,
            });
        }
        if expired(&credential) {
            return Ok(DetectResult {
                ok: false,
                message: "WorkBuddy 登录态已过期，请重新打开客户端".into(),
                user_label: None,
            });
        }
        let status = status(&credential).await?;
        if status.unauthorized {
            return Ok(DetectResult {
                ok: false,
                message: status.message,
                user_label: None,
            });
        }
        let message = if status.ok {
            if status.checked_in {
                "登录态有效，今日已签到"
            } else {
                "登录态有效，今日待签到"
            }
        } else {
            "登录态已读取，稍后自动签到"
        };
        Ok(DetectResult {
            ok: true,
            message: message.into(),
            user_label: if credential.uid.is_empty() {
                None
            } else {
                Some(format!("用户 {}", tail_chars(&credential.uid, 6)))
            },
        })
    }

    async fn probe_inner(&self, ctx: &AdapterContext) -> Result<ProbeResult, String> {
        let Some(credential) = self.read_credential(ctx, false).await? else {
            return Ok(ProbeResult {
                checked_in: false,
                status: RunStatus::NeedsSetup,
                message: "未找到 WorkBuddy 登录态".into(),
                credits: None,
            });
        };
        if is_international_domain(&credential.domain) {
            return Ok(ProbeResult {
                checked_in: false,
                status: RunStatus::Unavailable,
                message: INTERNATIONAL_MESSAGE.into(),
                credits: None,
            });
        }
        if expired(&credential) {
            return Ok(ProbeResult {
                checked_in: false,
                status: RunStatus::NeedsAuth,
                message: "WorkBuddy 登录态已过期，请重新打开客户端".into(),
                credits: None,
            });
        }
        let status = status(&credential).await?;
        if status.unauthorized {
            return Ok(ProbeResult {
                checked_in: false,
                status: RunStatus::NeedsAuth,
                message: status.message,
                credits: None,
            });
        }
        if !status.ok {
            return Ok(ProbeResult {
                checked_in: false,
                status: RunStatus::Failed,
                message: status.message,
                credits: None,
            });
        }
        Ok(ProbeResult {
            checked_in: status.checked_in,
            status: if status.checked_in {
                RunStatus::Already
            } else {
                RunStatus::Idle
            },
            message: status.message,
            credits: status.credits,
        })
    }

    async fn check_in_inner(&self, ctx: &AdapterContext) -> Result<Outcome, String> {
        let Some(credential) = self.read_credential(ctx, false).await? else {
            return Ok(Outcome {
                status: RunStatus::NeedsSetup,
                message: "未找到 WorkBuddy 登录态，请先登录 WorkBuddy 客户端".into(),
                credits: None,
            });
        };
        if is_international_domain(&credential.domain) {
            return Ok(Outcome {
                status: RunStatus::Unavailable,
                message: INTERNATIONAL_MESSAGE.into(),
                credits: None,
            });
        }
        if expired(&credential) {
            return Ok(Outcome {
                status: RunStatus::NeedsAuth,
                message: "WorkBuddy 登录态已过期，请重新打开客户端".into(),
                credits: None,
            });
        }

        let status = status(&credential).await?;
        if status.unauthorized {
            return Ok(Outcome {
                status: RunStatus::NeedsAuth,
                message: status.message,
                credits: None,
            });
        }
        if status.ok && status.checked_in {
            return Ok(Outcome {
                status: RunStatus::Already,
                message: "今日已签到，已自动跳过".into(),
                credits: status.credits,
            });
        }

        let response = request(
            reqwest::Method::POST,
            &api(&credential, "/v2/billing/meter/daily-checkin"),
            &headers(&credential),
            Some(json!({})),
            20_000,
        )
        .await?;
        if response.status == 401 || response.status == 403 {
            return Ok(Outcome {
                status: RunStatus::NeedsAuth,
                message: "WorkBuddy 登录态已失效，请重新打开客户端".into(),
                credits: None,
            });
        }

        let body = response.json.unwrap_or(Value::Null);
        let data = body
            .get("data")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| body.clone());
        let message = pick_string(&body, &["message", "msg"]).unwrap_or_default();
        if !message.is_empty()
            && (message.contains("已签到")
                || message.contains("已经签到")
                || message.to_lowercase().contains("already"))
        {
            return Ok(Outcome {
                status: RunStatus::Already,
                message: "今日已签到，已自动跳过".into(),
                credits: None,
            });
        }

        let success = response.ok
            && body.is_object()
            && (code_is_zero(body.get("code"))
                || body.get("success").and_then(Value::as_bool) == Some(true)
                || body.get("ret").and_then(Value::as_i64) == Some(0));
        if !success {
            return Ok(Outcome {
                status: RunStatus::Failed,
                message: if message.is_empty() {
                    format!("WorkBuddy 签到失败（HTTP {}）", response.status)
                } else {
                    message
                },
                credits: None,
            });
        }

        let credits = pick_number(
            &data,
            &["daily_credit", "credit", "credits", "reward_amount", "amount"],
        );
        Ok(Outcome {
            status: RunStatus::Success,
            message: match credits {
                Some(value) if value != 0 => format!("签到成功，+{value} 积分"),
                _ => "签到成功".into(),
            },
            credits,
        })
    }
}

#[async_trait]
impl Adapter for WorkBuddyAdapter {
    fn readiness(&self, ctx: &AdapterContext) -> Readiness {
        let Some(file) = find_credential_file(ctx) else {
            return Readiness {
                ready: false,
                message: "未找到 WorkBuddy 登录态，请先打开并登录 WorkBuddy".into(),
                status: None,
            };
        };
        if let Ok(text) = fs::read_to_string(&file) {
            if let Ok(doc) = serde_json::from_str::<Value>(&text) {
                let empty = json!({});
                let auth = doc
                    .get("auth")
                    .filter(|value| value.is_object())
                    .unwrap_or(&empty);
                let domain =
                    pick_string(auth, &["domain"]).unwrap_or_else(|| DEFAULT_DOMAIN.into());
                if is_international_domain(&domain) {
                    return Readiness {
                        ready: false,
                        message: INTERNATIONAL_MESSAGE.into(),
                        status: Some(RunStatus::Unavailable),
                    };
                }
                let expires_at = pick_number(auth, &["expiresAt"]);
                if matches!(expires_at, Some(value) if value != 0 && (value as i128) < now_ms()) {
                    return Readiness {
                        ready: false,
                        message: "WorkBuddy 登录态已过期，请重新打开客户端".into(),
                        status: None,
                    };
                }
            }
        }
        Readiness {
            ready: true,
            message: "已连接本机 WorkBuddy 登录态".into(),
            status: None,
        }
    }

    async fn detect(&self, ctx: AdapterContext) -> DetectResult {
        match self.detect_inner(&ctx).await {
            Ok(result) => result,
            Err(message) => DetectResult {
                ok: false,
                message,
                user_label: None,
            },
        }
    }

    async fn probe(&self, ctx: AdapterContext) -> ProbeResult {
        match self.probe_inner(&ctx).await {
            Ok(result) => result,
            Err(message) => ProbeResult {
                checked_in: false,
                status: RunStatus::NeedsSetup,
                message,
                credits: None,
            },
        }
    }

    async fn check_in(&self, ctx: AdapterContext) -> Outcome {
        match self.check_in_inner(&ctx).await {
            Ok(outcome) => outcome,
            Err(message) => Outcome {
                status: RunStatus::Failed,
                message: format!("WorkBuddy 签到失败：{message}"),
                credits: None,
            },
        }
    }

    fn locate(&self, ctx: &AdapterContext) -> Option<LocateResult> {
        let exe = find_executable(ctx);
        let data = find_credential_file(ctx);
        if exe.is_none() && data.is_none() {
            return Some(LocateResult {
                ok: false,
                message: "未找到 WorkBuddy 客户端或登录态，请手动填写安装目录或登录态路径".into(),
                data_path: None,
                exe_path: None,
            });
        }
        let message = match (&exe, &data) {
            (Some(path), _) => format!("已找到 WorkBuddy 客户端：{}", path.to_string_lossy()),
            (None, Some(path)) => format!("已找到 WorkBuddy 登录态：{}", path.to_string_lossy()),
            (None, None) => String::new(),
        };
        Some(LocateResult {
            ok: true,
            message,
            data_path: data.map(|path| path.to_string_lossy().to_string()),
            exe_path: exe.map(|path| path.to_string_lossy().to_string()),
        })
    }
}

fn custom_credential_candidates(ctx: &AdapterContext) -> Vec<PathBuf> {
    let Some(custom) = ctx.custom_path.as_deref() else {
        return Vec::new();
    };
    let value = expand_user_path(custom);
    if value.to_lowercase().ends_with(".info") || value.to_lowercase().ends_with(".json") {
        return vec![PathBuf::from(value)];
    }
    let base = PathBuf::from(value);
    unique_paths([
        base.join("workbuddy-desktop.info"),
        base.join("auth").join("workbuddy-desktop.info"),
        base.join("Public").join("auth").join("workbuddy-desktop.info"),
        base.join("Data")
            .join("Public")
            .join("auth")
            .join("workbuddy-desktop.info"),
    ])
}

fn credential_candidates() -> Vec<PathBuf> {
    let local = env::var("LOCALAPPDATA").unwrap_or_default();
    let roaming = env::var("APPDATA").unwrap_or_default();
    let mut paths = vec![
        PathBuf::from(&local)
            .join("CodeBuddyExtension")
            .join("Data")
            .join("Public")
            .join("auth")
            .join("workbuddy-desktop.info"),
        PathBuf::from(&roaming)
            .join("CodeBuddyExtension")
            .join("Data")
            .join("Public")
            .join("auth")
            .join("workbuddy-desktop.info"),
    ];
    for root in unique_paths([PathBuf::from(&local), PathBuf::from(&roaming)]) {
        for dir in matching_directories(&root, |name| name_matches(name, &["codebuddy", "workbuddy"]))
        {
            paths.push(
                dir.join("Data")
                    .join("Public")
                    .join("auth")
                    .join("workbuddy-desktop.info"),
            );
            paths.push(
                dir.join("Public")
                    .join("auth")
                    .join("workbuddy-desktop.info"),
            );
            paths.push(dir.join("auth").join("workbuddy-desktop.info"));
        }
    }
    unique_paths(paths)
}

fn find_credential_file(ctx: &AdapterContext) -> Option<PathBuf> {
    for path in custom_credential_candidates(ctx) {
        if path.exists() {
            return Some(path);
        }
    }
    let mut existing: Vec<PathBuf> = credential_candidates()
        .into_iter()
        .filter(|path| path.exists())
        .collect();
    existing.sort_by_key(|path| std::cmp::Reverse(mtime_ms(path)));
    existing.into_iter().next()
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
        base.join("WorkBuddy.exe"),
        base.join("WorkBuddy").join("WorkBuddy.exe"),
        base.join("Application").join("WorkBuddy.exe"),
    ])
}

fn find_executable(ctx: &AdapterContext) -> Option<PathBuf> {
    for candidate in custom_executable_candidates(ctx) {
        if candidate.exists() {
            return Some(candidate);
        }
    }
    let local = env::var("LOCALAPPDATA").unwrap_or_default();
    let program_files = env_path("ProgramFiles", "C:\\Program Files");
    let program_files_x86 = env_path("ProgramFiles(x86)", "C:\\Program Files (x86)");
    let roots = unique_paths([
        PathBuf::from(&local).join("Programs"),
        PathBuf::from(&program_files),
        PathBuf::from(&program_files_x86),
        PathBuf::from(&local),
    ]);
    let candidates = [
        PathBuf::from(&local)
            .join("Programs")
            .join("WorkBuddy")
            .join("WorkBuddy.exe"),
        PathBuf::from(&program_files)
            .join("WorkBuddy")
            .join("WorkBuddy.exe"),
        PathBuf::from(&program_files_x86)
            .join("WorkBuddy")
            .join("WorkBuddy.exe"),
    ];
    for candidate in candidates {
        if candidate.exists() {
            return Some(candidate);
        }
    }
    for root in roots {
        for dir in matching_directories(&root, |name| name_matches(name, &["workbuddy", "codebuddy"]))
        {
            for exe in [
                dir.join("WorkBuddy.exe"),
                dir.join("WorkBuddy").join("WorkBuddy.exe"),
                dir.join("Application").join("WorkBuddy.exe"),
            ] {
                if exe.exists() {
                    return Some(exe);
                }
            }
        }
        // 兜底：安装目录名完全不带 WorkBuddy 时，按可执行文件名扫描一层。
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                let base = entry.path();
                for exe in [
                    base.join("WorkBuddy.exe"),
                    base.join("WorkBuddy").join("WorkBuddy.exe"),
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

/// 与 store.rs 中的 data_dir 保持一致。
fn runtime_helper_path() -> PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("AutoCredit")
        .join("runtime");
    let path = dir.join("wb-decrypt.cjs");
    if fs::read_to_string(&path)
        .map(|text| text != HELPER)
        .unwrap_or(true)
    {
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(&path, HELPER);
    }
    path
}

async fn decrypt_via_client(ctx: &AdapterContext, file: &Path) -> Result<Credential, String> {
    let Some(exe) = find_executable(ctx) else {
        return Err("未找到 WorkBuddy 客户端，请在设置中填写客户端路径".into());
    };
    let helper = runtime_helper_path();
    let mut command = hidden_command(&exe);
    command
        .arg(&helper)
        .arg(file)
        .env("ELECTRON_RUN_AS_NODE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 WorkBuddy 输出".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取 WorkBuddy 输出".to_string())?;
    let stdout_task = tokio::spawn(async move {
        let mut buffer = Vec::new();
        let _ = stdout.read_to_end(&mut buffer).await;
        buffer
    });
    let stderr_task = tokio::spawn(async move {
        let mut buffer = Vec::new();
        let _ = stderr.read_to_end(&mut buffer).await;
        buffer
    });

    let code = match tokio::time::timeout(Duration::from_millis(15_000), child.wait()).await {
        Err(_) => {
            let _ = child.kill().await;
            return Err("读取 WorkBuddy 登录态超时".into());
        }
        Ok(Err(error)) => return Err(error.to_string()),
        Ok(Ok(status)) => status.code().unwrap_or(-1),
    };

    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();
    let output = String::from_utf8_lossy(&stdout).to_string();
    if code != 0 && output.is_empty() {
        let stderr_text = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(if stderr_text.is_empty() {
            format!("WorkBuddy helper exited with {code}")
        } else {
            stderr_text
        });
    }

    let parsed: Value =
        serde_json::from_str(output.trim()).map_err(|_| "WorkBuddy 登录态解析失败".to_string())?;
    if !parsed.is_object() {
        return Err("WorkBuddy 登录态解析失败".into());
    }
    match parsed.get("error") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => {}
        Some(Value::String(text)) if text.is_empty() => {}
        Some(value) => return Err(value_to_string(value)),
    }
    let token = pick_string(&parsed, &["token"])
        .ok_or_else(|| "WorkBuddy 登录态中没有可用的访问令牌".to_string())?;
    Ok(Credential {
        token,
        uid: pick_string(&parsed, &["uid"]).unwrap_or_default(),
        domain: pick_string(&parsed, &["domain"]).unwrap_or_else(|| DEFAULT_DOMAIN.into()),
        expires_at: pick_number(&parsed, &["expiresAt"]),
        source: file.to_path_buf(),
    })
}

async fn status(credential: &Credential) -> Result<StatusInfo, String> {
    let response = request(
        reqwest::Method::POST,
        &api(credential, "/v2/billing/meter/checkin-activity-status"),
        &headers(credential),
        Some(json!({})),
        15_000,
    )
    .await?;
    if response.status == 401 || response.status == 403 {
        return Ok(StatusInfo {
            ok: false,
            checked_in: false,
            credits: None,
            unauthorized: true,
            message: "WorkBuddy 登录态已失效".into(),
        });
    }
    let body = response.json.unwrap_or(Value::Null);
    if !response.ok || !body.is_object() {
        return Ok(StatusInfo {
            ok: false,
            checked_in: false,
            credits: None,
            unauthorized: false,
            message: pick_string(&body, &["message", "msg"])
                .unwrap_or_else(|| format!("WorkBuddy 状态读取失败（HTTP {}）", response.status)),
        });
    }
    if let Some(code) = body.get("code") {
        if !code_is_zero(Some(code)) {
            return Ok(StatusInfo {
                ok: false,
                checked_in: false,
                credits: None,
                unauthorized: false,
                message: pick_string(&body, &["message", "msg"])
                    .unwrap_or_else(|| "WorkBuddy 状态读取失败".into()),
            });
        }
    }
    let data = body
        .get("data")
        .filter(|value| value.is_object())
        .unwrap_or(&body);
    let checked_in = ["today_checked_in", "checked_in", "checkedIn", "todayCheckedIn"]
        .iter()
        .any(|key| data.get(*key).and_then(Value::as_bool) == Some(true));
    Ok(StatusInfo {
        ok: true,
        checked_in,
        credits: pick_number(data, &["daily_credit", "today_credit", "credit", "credits"]),
        unauthorized: false,
        message: if checked_in {
            "今日已签到".into()
        } else {
            "今日待签到".into()
        },
    })
}

fn headers(credential: &Credential) -> Vec<(&'static str, String)> {
    vec![
        ("Content-Type", "application/json".into()),
        ("Accept", "application/json".into()),
        ("Authorization", format!("Bearer {}", credential.token)),
        ("x-user-id", credential.uid.clone()),
        ("x-domain", credential.domain.clone()),
        ("User-Agent", "AutoCredit/1.0".into()),
    ]
}

fn api(credential: &Credential, path: &str) -> String {
    format!("https://{}{}", credential.domain, path)
}

fn is_international_domain(domain: &str) -> bool {
    !domain.to_lowercase().ends_with(".cn")
}

fn expired(credential: &Credential) -> bool {
    matches!(credential.expires_at, Some(value) if value != 0 && (value as i128) < now_ms())
}

fn code_is_zero(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Number(number)) => number.as_f64() == Some(0.0),
        Some(Value::String(text)) => text == "0",
        _ => false,
    }
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn name_matches(name: &str, needles: &[&str]) -> bool {
    let lower = name.to_lowercase();
    needles.iter().any(|needle| lower.contains(needle))
}

fn env_path(name: &str, fallback: &str) -> String {
    env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn tail_chars(value: &str, count: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    chars[chars.len().saturating_sub(count)..]
        .iter()
        .copied()
        .collect()
}

fn now_ms() -> i128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i128)
        .unwrap_or(0)
}

fn mtime_ms(path: &Path) -> i128 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i128)
        .unwrap_or(0)
}

/// WorkBuddy 以 ELECTRON_RUN_AS_NODE 运行时不显示控制台窗口。
fn hidden_command(exe: &Path) -> Command {
    let mut command = Command::new(exe);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}
