use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use aes::Aes128;
use async_trait::async_trait;
use base64::engine::general_purpose::{STANDARD, URL_SAFE};
use base64::Engine;
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use rand::RngCore;
use reqwest::Method;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha512};

use crate::models::{DetectResult, LocateResult, RunStatus};

use super::paths::{expand_user_path, home_dir, matching_directories, unique_paths};
use super::{
    pick_number, pick_string, request, Adapter, AdapterContext, Outcome, ProbeResult, Readiness,
};

const SALT_A: [u8; 64] = [
    82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130,
    155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61,
    238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109,
    139, 209, 37,
];
const SALT_B: [u8; 64] = [
    31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25,
    181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200,
    235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33,
    12, 125,
];

const INTERNATIONAL_MESSAGE: &str = "检测到 Trae 国际版（trae.ai），国际版没有每日签到，无需签到";

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TraeAuth {
    token: String,
    refresh_token: Option<String>,
    expired_at: Option<Value>,
    refresh_expired_at: Option<Value>,
    user_id: Option<String>,
    host: Option<String>,
}

/// Trae 有时把时间写成毫秒时间戳，有时写成 ISO 字符串。
fn parse_timestamp(value: &Option<Value>) -> Option<i64> {
    match value.as_ref()? {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => chrono::DateTime::parse_from_rfc3339(text)
            .ok()
            .map(|time| time.timestamp_millis()),
        _ => None,
    }
}

#[derive(Clone, Debug)]
struct TraeStorageInfo {
    auth: TraeAuth,
    device_id: Option<String>,
    machine_id: Option<String>,
    ide_version: Option<String>,
    source: PathBuf,
    custom: bool,
}

/// 自动搜索 Roaming 下所有可能的 Trae 登录态，兼容被改名的安装目录。
fn storage_candidates() -> Vec<PathBuf> {
    let names = ["Trae CN", "TRAE SOLO CN", "Trae", "TRAE SOLO"];
    let mut roots = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.trim().is_empty() {
            roots.push(PathBuf::from(appdata));
        }
    }
    roots.push(home_dir().join("AppData").join("Roaming"));

    let mut paths = Vec::new();
    for root in unique_paths(roots) {
        for name in names {
            paths.push(
                root.join(name)
                    .join("User")
                    .join("globalStorage")
                    .join("storage.json"),
            );
        }
        for dir in matching_directories(&root, |name| {
            let lower = name.to_lowercase();
            lower.contains("trae") || lower.contains("solo")
        }) {
            paths.push(dir.join("User").join("globalStorage").join("storage.json"));
        }
        // 兜底：VS Code 系客户端的标准目录结构，避免目录名被完全本地化。
        for dir in matching_directories(&root, |_| true) {
            paths.push(dir.join("User").join("globalStorage").join("storage.json"));
        }
    }
    unique_paths(paths)
}

/// 用户手动指定的路径可以是 storage.json，也可以是它的上级目录。
fn custom_storage_candidates(custom_path: &str) -> Vec<PathBuf> {
    let value = expand_user_path(custom_path);
    if value.is_empty() {
        return Vec::new();
    }
    let path = PathBuf::from(value.as_str());
    if value.to_lowercase().ends_with(".json") {
        return vec![path];
    }
    unique_paths([
        path.join("storage.json"),
        path.join("globalStorage").join("storage.json"),
        path.join("User").join("globalStorage").join("storage.json"),
    ])
}

/// 国际版 trae.ai 没有每日签到，只有中国版 trae.cn 才需要签到。
fn is_international(info: &TraeStorageInfo) -> bool {
    if let Some(host) = info.auth.host.as_deref().filter(|host| !host.is_empty()) {
        return host.to_lowercase().contains("trae.ai");
    }
    // 手动指定的路径由用户明确选择，不再按目录名推断为国际版。
    if info.custom {
        return false;
    }
    let source = info.source.to_string_lossy().to_lowercase();
    let known = source.contains("\\trae cn\\")
        || source.contains("/trae cn/")
        || source.contains("\\trae solo cn\\")
        || source.contains("/trae solo cn/");
    !known
}

fn decode_base64(value: &str) -> Option<Vec<u8>> {
    let cleaned: String = value.chars().filter(|ch| !ch.is_whitespace()).collect();
    if let Ok(bytes) = STANDARD.decode(&cleaned) {
        return Some(bytes);
    }
    if let Ok(bytes) = URL_SAFE.decode(&cleaned) {
        return Some(bytes);
    }
    let mut padded = cleaned.trim_end_matches('=').to_string();
    while padded.len() % 4 != 0 {
        padded.push('=');
    }
    STANDARD.decode(padded).ok()
}

fn decrypt_auth_value(value: &str) -> Result<TraeAuth, String> {
    let buffer = decode_base64(value).ok_or_else(|| "未知的 Trae CN 登录态加密格式".to_string())?;
    if buffer.len() < 38 {
        return Err("未知的 Trae CN 登录态加密格式".into());
    }
    if !(buffer[0] == 0x74 && buffer[1] == 0x63 && buffer[2] == 0x05 && buffer[3] == 0x10) {
        return Err("未知的 Trae CN 登录态加密格式".into());
    }
    let random_part = &buffer[6..38];
    let encrypted = &buffer[38..];

    let mut salt = [0u8; 64];
    for (index, byte) in salt.iter_mut().enumerate() {
        *byte = SALT_A[index] ^ SALT_B[index];
    }
    let mut hasher = Sha512::new();
    hasher.update(Sha512::digest(random_part));
    hasher.update(salt);
    let final_hash = hasher.finalize();

    let mut buffer = encrypted.to_vec();
    let plain = cbc::Decryptor::<Aes128>::new_from_slices(&final_hash[0..16], &final_hash[16..32])
        .map_err(|_| "Trae CN 登录态解密失败".to_string())?
        .decrypt_padded_mut::<Pkcs7>(&mut buffer)
        .map_err(|_| "Trae CN 登录态解密失败".to_string())?;
    if plain.len() < 64 {
        return Err("Trae CN 登录态校验失败".into());
    }
    let (stored, payload) = plain.split_at(64);
    let computed = Sha512::digest(payload);
    if stored != computed.as_slice() {
        return Err("Trae CN 登录态校验失败".into());
    }
    serde_json::from_slice::<TraeAuth>(payload).map_err(|error| error.to_string())
}

fn read_storage_info(path: &Path, custom: bool) -> Option<TraeStorageInfo> {
    let text = fs::read_to_string(path).ok()?;
    let storage: Value = serde_json::from_str(&text).ok()?;
    let raw = storage.get("iCubeAuthInfo://icube.cloudide")?;
    let raw = raw.as_str()?;
    let auth = if raw.trim_start().starts_with('{') {
        serde_json::from_str::<TraeAuth>(raw).ok()?
    } else {
        decrypt_auth_value(raw).ok()?
    };
    if auth.token.is_empty() {
        return None;
    }

    let mut device_id = None;
    let mut machine_id = None;
    let mut ide_version = None;
    if let Some(map) = storage.as_object() {
        for key in map.keys() {
            if let Some(rest) = key.strip_prefix("iCubeAuthInfo://icube-dc:") {
                if !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_digit()) {
                    device_id = Some(rest.to_string());
                    break;
                }
            }
        }
        machine_id = match map.get("telemetry.machineId") {
            Some(Value::String(value)) => Some(value.clone()),
            Some(value) => pick_string(value, &["machineId"]),
            None => None,
        };
        if let Some(Value::String(value)) = map.get("iCubeLastVersion") {
            ide_version = Some(value.clone());
        }
    }

    Some(TraeStorageInfo {
        auth,
        device_id,
        machine_id,
        ide_version,
        source: path.to_path_buf(),
        custom,
    })
}

fn load_storage(custom_path: Option<&str>) -> Option<TraeStorageInfo> {
    let custom: Vec<PathBuf> = custom_path
        .map(|path| {
            custom_storage_candidates(path)
                .into_iter()
                .filter(|candidate| candidate.exists())
                .collect()
        })
        .unwrap_or_default();

    let mut all = custom.clone();
    all.extend(storage_candidates().into_iter().filter(|path| path.exists()));
    let candidates = unique_paths(all);

    let mut infos = Vec::new();
    for path in &candidates {
        if let Some(info) = read_storage_info(path, custom.contains(path)) {
            infos.push(info);
        }
    }
    infos
        .iter()
        .find(|info| !is_international(info))
        .cloned()
        .or_else(|| infos.first().cloned())
}

fn device_type() -> &'static str {    if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

fn os_release() -> String {
    static RELEASE: OnceLock<String> = OnceLock::new();
    RELEASE
        .get_or_init(|| {
            #[cfg(target_os = "windows")]
            {
                if let Ok(output) = std::process::Command::new("cmd")
                    .args(["/C", "ver"])
                    .creation_flags(0x08000000)
                    .output()
                {
                    let text = String::from_utf8_lossy(&output.stdout);
                    if let Some(index) = text.find("Version ") {
                        let version: String = text[index + 8..]
                            .chars()
                            .take_while(|ch| ch.is_ascii_digit() || *ch == '.')
                            .collect();
                        if !version.is_empty() {
                            return version;
                        }
                    }
                }
                "10.0".to_string()
            }
            #[cfg(not(target_os = "windows"))]
            {
                std::process::Command::new("uname")
                    .arg("-r")
                    .output()
                    .ok()
                    .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "unknown".to_string())
            }
        })
        .clone()
}

fn os_info() -> String {
    if cfg!(target_os = "windows") {
        format!("Windows {}", os_release())
    } else if cfg!(target_os = "macos") {
        format!("Darwin {}", os_release())
    } else {
        format!("Linux {}", os_release())
    }
}

fn random_hex(len: usize) -> String {
    let mut bytes = vec![0u8; len];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{:02x}", byte)).collect()
}

fn build_headers(info: &TraeStorageInfo, token: &str) -> Vec<(&'static str, String)> {
    let header_version = info
        .ide_version
        .clone()
        .unwrap_or_else(|| "3.3.67".to_string());
    let version_code = info
        .ide_version
        .clone()
        .unwrap_or_else(|| "20260401".to_string())
        .replace('.', "");
    vec![
        ("Authorization", format!("Cloud-IDE-JWT {token}")),
        ("X-Cloudide-Token", token.to_string()),
        (
            "x-uid",
            info.auth.user_id.clone().unwrap_or_default(),
        ),
        (
            "x-app-id",
            "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8".to_string(),
        ),
        (
            "x-device-id",
            info.device_id.clone().unwrap_or_else(|| random_hex(16)),
        ),
        (
            "x-machine-id",
            info.machine_id.clone().unwrap_or_else(|| random_hex(32)),
        ),
        ("x-request-id", uuid::Uuid::new_v4().to_string()),
        ("x-ide-version", header_version),
        ("x-ide-version-code", version_code),
        ("x-device-type", device_type().to_string()),
        ("x-os-version", os_info()),
        ("Content-Type", "application/json".to_string()),
        ("Accept", "application/json".to_string()),
    ]
}

async fn exchange_token(info: &TraeStorageInfo) -> Option<String> {
    let refresh_token = info.auth.refresh_token.clone().filter(|v| !v.is_empty())?;
    let host = info
        .auth
        .host
        .clone()
        .unwrap_or_else(|| "https://api.trae.cn".to_string());
    let url = format!("{host}/cloudide/api/v3/trae/oauth/ExchangeToken");
    let body = serde_json::json!({
        "ClientID": "ono9krqynydwx5",
        "RefreshToken": refresh_token,
        "ClientSecret": "-",
        "UserID": info.auth.user_id.clone().unwrap_or_default(),
    });
    let headers = [("Content-Type", "application/json".to_string())];
    let response = request(Method::POST, &url, &headers, Some(body), 15_000)
        .await
        .ok()?;
    let json = response.json?;
    let section = json.get("Result")?;
    pick_string(section, &["Token"])
}

async fn with_token<T, F, Fut>(info: &TraeStorageInfo, operation: F) -> Result<T, String>
where
    T: Send,
    F: Fn(String) -> Fut + Send,
    Fut: std::future::Future<Output = Result<(bool, T), String>> + Send,
{
    let now = chrono::Utc::now().timestamp_millis();
    let mut token = info.auth.token.clone();
    let expiring = match parse_timestamp(&info.auth.expired_at) {
        None => true,
        Some(at) => at - now < 30 * 60 * 1000,
    };
    if expiring {
        if let Some(refreshed) = exchange_token(info).await {
            token = refreshed;
        }
    }
    let mut result = operation(token.clone()).await?;
    if result.0 {
        if let Some(refreshed) = exchange_token(info).await {
            token = refreshed;
            result = operation(token).await?;
        }
    }
    if result.0 {
        return Err("AUTH_EXPIRED".to_string());
    }
    Ok(result.1)
}

fn code_is_ok(value: Option<&Value>) -> bool {
    value
        .and_then(|json| json.get("code"))
        .and_then(Value::as_i64)
        == Some(0)
}

fn credits_total(value: Option<&Value>) -> i64 {
    value
        .map(|json| {
            pick_number(json, &["credits"]).unwrap_or(0)
                + pick_number(json, &["extra_credits"]).unwrap_or(0)
        })
        .unwrap_or(0)
}

fn checked_in_flag(value: Option<&Value>) -> bool {
    value
        .and_then(|json| json.get("checked_in"))
        .and_then(Value::as_bool)
        == Some(true)
}

pub struct TraeAdapter;

#[async_trait]
impl Adapter for TraeAdapter {
    fn readiness(&self, ctx: &AdapterContext) -> Readiness {
        let Some(info) = load_storage(ctx.custom_path.as_deref()) else {
            return Readiness {
                ready: false,
                message: "未找到本机 Trae CN 登录态，请先打开并登录 Trae 客户端".into(),
                status: None,
            };
        };
        if is_international(&info) {
            return Readiness {
                ready: false,
                message: INTERNATIONAL_MESSAGE.into(),
                status: Some(RunStatus::Unavailable),
            };
        }
        if let Some(refresh_expired_at) = parse_timestamp(&info.auth.refresh_expired_at) {
            if refresh_expired_at < chrono::Utc::now().timestamp_millis() {
                return Readiness {
                    ready: false,
                    message: "Trae CN 登录态已过期，请重新登录客户端".into(),
                    status: None,
                };
            }
        }
        Readiness {
            ready: true,
            message: "已连接本机 Trae CN 登录态".into(),
            status: None,
        }
    }

    async fn detect(&self, ctx: AdapterContext) -> DetectResult {
        let Some(info) = load_storage(ctx.custom_path.as_deref()) else {
            return DetectResult {
                ok: false,
                message: "未找到本机 Trae CN 登录态，请先打开并登录 Trae 客户端".into(),
                user_label: None,
            };
        };
        if is_international(&info) {
            return DetectResult {
                ok: true,
                message: INTERNATIONAL_MESSAGE.into(),
                user_label: None,
            };
        }
        let probe = self.probe(ctx).await;
        if probe.status == RunStatus::NeedsAuth {
            return DetectResult {
                ok: false,
                message: probe.message,
                user_label: None,
            };
        }
        DetectResult {
            ok: true,
            message: if probe.checked_in {
                "登录态有效，今日已签到".into()
            } else {
                "登录态有效，今日待签到".into()
            },
            user_label: None,
        }
    }

    async fn probe(&self, ctx: AdapterContext) -> ProbeResult {
        let Some(info) = load_storage(ctx.custom_path.as_deref()) else {
            return ProbeResult {
                checked_in: false,
                status: RunStatus::NeedsSetup,
                message: "未找到本机 Trae CN 登录态".into(),
                credits: None,
            };
        };
        if is_international(&info) {
            return ProbeResult {
                checked_in: false,
                status: RunStatus::Unavailable,
                message: INTERNATIONAL_MESSAGE.into(),
                credits: None,
            };
        }
        let host = info
            .auth
            .host
            .clone()
            .unwrap_or_else(|| "https://api.trae.cn".to_string());
        let url = format!("{host}/trae/api/v2/ug/checkin_credits/status");

        let outcome = with_token(&info, |token| {
            let headers = build_headers(&info, &token);
            let url = url.clone();
            async move {
                let response = request(
                    Method::POST,
                    &url,
                    &headers,
                    Some(serde_json::json!({})),
                    15_000,
                )
                .await
                .map_err(|error| error.to_string())?;
                Ok((response.status == 401, response))
            }
        })
        .await;

        let response = match outcome {
            Ok(response) => response,
            Err(message) => {
                if message == "AUTH_EXPIRED" {
                    return ProbeResult {
                        checked_in: false,
                        status: RunStatus::NeedsAuth,
                        message: "Trae CN 登录态已过期，请重新打开并登录 Trae 客户端".into(),
                        credits: None,
                    };
                }
                return ProbeResult {
                    checked_in: false,
                    status: RunStatus::Failed,
                    message: format!("网络请求失败：{message}"),
                    credits: None,
                };
            }
        };

        if !response.ok {
            return ProbeResult {
                checked_in: false,
                status: RunStatus::Failed,
                message: format!("签到状态读取失败（HTTP {}）", response.status),
                credits: None,
            };
        }
        let json = response.json.as_ref();
        if !code_is_ok(json) {
            let message = json
                .and_then(|value| pick_string(value, &["message"]))
                .unwrap_or_else(|| "签到状态读取失败".to_string());
            return ProbeResult {
                checked_in: false,
                status: RunStatus::Failed,
                message,
                credits: None,
            };
        }
        let checked_in = checked_in_flag(json);
        let credits = credits_total(json);
        ProbeResult {
            checked_in,
            status: if checked_in {
                RunStatus::Already
            } else {
                RunStatus::Idle
            },
            message: if checked_in {
                "今日已签到".into()
            } else {
                "今日待签到".into()
            },
            credits: if credits > 0 { Some(credits) } else { None },
        }
    }

    async fn check_in(&self, ctx: AdapterContext) -> Outcome {
        let Some(info) = load_storage(ctx.custom_path.as_deref()) else {
            return Outcome {
                status: RunStatus::NeedsSetup,
                message: "未找到本机 Trae CN 登录态，请先登录 Trae 客户端".into(),
                credits: None,
            };
        };
        if is_international(&info) {
            return Outcome {
                status: RunStatus::Unavailable,
                message: INTERNATIONAL_MESSAGE.into(),
                credits: None,
            };
        }
        let host = info
            .auth
            .host
            .clone()
            .unwrap_or_else(|| "https://api.trae.cn".to_string());
        let status_url = format!("{host}/trae/api/v2/ug/checkin_credits/status");
        let claim_url = format!("{host}/trae/api/v2/ug/checkin_credits/claim");

        let result = with_token(&info, |token| {
            let headers = build_headers(&info, &token);
            let status_url = status_url.clone();
            let claim_url = claim_url.clone();
            async move {
                let status_response = request(
                    Method::POST,
                    &status_url,
                    &headers,
                    Some(serde_json::json!({})),
                    15_000,
                )
                .await
                .map_err(|error| error.to_string())?;
                if status_response.status == 401 {
                    return Ok((
                        true,
                        Outcome {
                            status: RunStatus::NeedsAuth,
                            message: "登录态失效".into(),
                            credits: None,
                        },
                    ));
                }
                let status_json = status_response.json.as_ref();
                if !status_response.ok || !code_is_ok(status_json) {
                    let message = status_json
                        .and_then(|value| pick_string(value, &["message"]))
                        .unwrap_or_else(|| {
                            format!("签到状态读取失败（HTTP {}）", status_response.status)
                        });
                    return Ok((
                        false,
                        Outcome {
                            status: RunStatus::Failed,
                            message,
                            credits: None,
                        },
                    ));
                }
                if checked_in_flag(status_json) {
                    let credits = credits_total(status_json);
                    return Ok((
                        false,
                        Outcome {
                            status: RunStatus::Already,
                            message: "今日已签到，已自动跳过".into(),
                            credits: if credits > 0 { Some(credits) } else { None },
                        },
                    ));
                }

                let claim_response = request(
                    Method::POST,
                    &claim_url,
                    &headers,
                    Some(serde_json::json!({})),
                    20_000,
                )
                .await
                .map_err(|error| error.to_string())?;
                if claim_response.status == 401 {
                    return Ok((
                        true,
                        Outcome {
                            status: RunStatus::NeedsAuth,
                            message: "登录态失效".into(),
                            credits: None,
                        },
                    ));
                }
                let claim_json = claim_response.json.as_ref();
                if !claim_response.ok || !code_is_ok(claim_json) {
                    let message = claim_json
                        .and_then(|value| pick_string(value, &["message"]))
                        .unwrap_or_else(|| format!("签到失败（HTTP {}）", claim_response.status));
                    return Ok((
                        false,
                        Outcome {
                            status: RunStatus::Failed,
                            message,
                            credits: None,
                        },
                    ));
                }
                let gained = claim_json.and_then(|value| {
                    pick_number(
                        value,
                        &[
                            "gained_credits",
                            "credits_gained",
                            "reward",
                            "extra_credits",
                            "credits",
                        ],
                    )
                });
                Ok((
                    false,
                    Outcome {
                        status: RunStatus::Success,
                        message: match gained {
                            Some(gained) if gained != 0 => {
                                format!("签到成功，+{gained} 积分")
                            }
                            _ => "签到成功".into(),
                        },
                        credits: gained,
                    },
                ))
            }
        })
        .await;

        match result {
            Ok(outcome) => outcome,
            Err(message) => {
                if message == "AUTH_EXPIRED" {
                    return Outcome {
                        status: RunStatus::NeedsAuth,
                        message: "Trae CN 登录态已过期，请重新打开并登录 Trae 客户端".into(),
                        credits: None,
                    };
                }
                Outcome {
                    status: RunStatus::Failed,
                    message: format!("网络请求失败：{message}"),
                    credits: None,
                }
            }
        }
    }

    fn locate(&self, ctx: &AdapterContext) -> Option<LocateResult> {
        if let Some(custom) = ctx.custom_path.as_deref() {
            if let Some(found) = custom_storage_candidates(custom)
                .into_iter()
                .find(|path| path.exists())
            {
                let display = found.to_string_lossy().to_string();
                return Some(LocateResult {
                    ok: true,
                    message: format!("已找到 Trae CN 登录态：{display}"),
                    data_path: Some(display),
                    exe_path: None,
                });
            }
        }
        let Some(found) = storage_candidates().into_iter().find(|path| path.exists()) else {
            return Some(LocateResult {
                ok: false,
                message: "未找到 Trae CN 登录态，请手动填写 storage.json 或其所在目录".into(),
                data_path: None,
                exe_path: None,
            });
        };
        let display = found.to_string_lossy().to_string();
        Some(LocateResult {
            ok: true,
            message: format!("已找到 Trae CN 登录态：{display}"),
            data_path: Some(display),
            exe_path: None,
        })
    }
}
