use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::Value;

use crate::models::{
    app_meta, checkin_date_key, local_date_key, now_iso, AppConfig, AppId, AppRuntime,
    BootstrapState, ConfigFile, GlobalSettings, NetworkStatus, RunStatus, APP_ORDER,
};

pub struct Store {
    pub data_dir: PathBuf,
    pub logs_dir: PathBuf,
    config_path: PathBuf,
    secrets_path: PathBuf,
    pub config: ConfigFile,
    pub first_run: bool,
    secrets: HashMap<AppId, String>,
    secrets_ready: bool,
}

impl Store {
    pub fn load() -> Self {
        let data_dir = data_dir();
        let logs_dir = data_dir.join("logs");
        let _ = fs::create_dir_all(&logs_dir);

        let config_path = data_dir.join("config.json");
        let secrets_path = data_dir.join("secrets.bin");
        let first_run = !config_path.exists();

        let config = load_config(&config_path);
        let (secrets, secrets_ready) = load_secrets(&secrets_path, &data_dir);

        let mut store = Self {
            data_dir,
            logs_dir,
            config_path,
            secrets_path,
            config,
            first_run,
            secrets,
            secrets_ready,
        };
        store.normalize_today();
        store
    }

    pub fn settings(&self) -> &GlobalSettings {
        &self.config.settings
    }

    pub fn app(&self, id: AppId) -> &AppConfig {
        self.config.apps.get(&id).expect("app config")
    }

    pub fn runtime(&self, id: AppId) -> &AppRuntime {
        self.config.runtime.get(&id).expect("app runtime")
    }

    pub fn update_settings(&mut self, patch: Value) {
        if let Ok(patch) = serde_json::from_value::<GlobalSettingsPatch>(patch) {
            patch.apply(&mut self.config.settings);
            self.save();
        }
    }

    pub fn update_app(&mut self, id: AppId, patch: Value) {
        if let Ok(patch) = serde_json::from_value::<AppConfigPatch>(patch) {
            if let Some(app) = self.config.apps.get_mut(&id) {
                patch.apply(app);
                self.save();
            }
        }
    }

    pub fn update_runtime(&mut self, id: AppId, patch: AppRuntimePatch) {
        if let Some(runtime) = self.config.runtime.get_mut(&id) {
            patch.apply(runtime);
            runtime.updated_at = Some(now_iso());
            self.save();
        }
    }

    pub fn secrets_state(&self) -> HashMap<AppId, bool> {
        APP_ORDER
            .iter()
            .map(|id| (*id, self.has_pat(*id)))
            .collect()
    }

    pub fn get_pat(&self, id: AppId) -> String {
        self.secrets.get(&id).cloned().unwrap_or_default()
    }

    pub fn has_pat(&self, id: AppId) -> bool {
        self.secrets.get(&id).map(|v| !v.is_empty()).unwrap_or(false)
    }

    pub fn set_pat(&mut self, id: AppId, value: String) -> Result<(), String> {
        if id != AppId::Qoder && id != AppId::QoderCn {
            return Err("该程序不需要手动令牌".into());
        }
        self.secrets.insert(id, value.trim().to_string());
        self.save_secrets()
    }

    pub fn clear_pat(&mut self, id: AppId) -> Result<(), String> {
        self.secrets.remove(&id);
        self.save_secrets()
    }

    pub fn normalize_today(&mut self) {
        let today = local_date_key();
        for id in APP_ORDER {
            let reset_hour = if id == AppId::Qoder || id == AppId::QoderCn {
                10
            } else {
                0
            };
            let checkin_day = checkin_date_key(reset_hour);
            let runtime = self.config.runtime.entry(id).or_default();
            let stale_probe = runtime.probe_date.as_deref() != Some(today.as_str());
            if stale_probe && runtime.today_checked_in == Some(true) {
                runtime.today_checked_in = Some(false);
            }
            if runtime.last_attempt_date.as_deref() != Some(checkin_day.as_str()) {
                runtime.attempts = 0;
                if runtime.status == RunStatus::Failed || runtime.status == RunStatus::Cancelled {
                    runtime.status = RunStatus::Idle;
                    runtime.message = "等待签到".into();
                }
            }
            let keep_success = runtime.last_success_date.as_deref() == Some(checkin_day.as_str())
                || (runtime.probe_date.as_deref() == Some(today.as_str())
                    && runtime.today_checked_in == Some(true));
            if !keep_success && (runtime.status == RunStatus::Success || runtime.status == RunStatus::Already)
            {
                runtime.status = RunStatus::Idle;
                runtime.message = "等待签到".into();
            }
            if runtime.status == RunStatus::Running {
                runtime.status = RunStatus::Idle;
                runtime.message = "等待签到".into();
            }
        }
        self.save();
    }

    pub fn bootstrap(&self, version: String, is_packaged: bool) -> BootstrapState {
        BootstrapState {
            settings: self.config.settings.clone(),
            apps: self.config.apps.clone(),
            runtime: self.config.runtime.clone(),
            metas: APP_ORDER.iter().map(|id| app_meta(*id)).collect(),
            secrets: self.secrets_state(),
            version,
            data_dir: self.data_dir.to_string_lossy().to_string(),
            logs_dir: self.logs_dir.to_string_lossy().to_string(),
            is_packaged,
            network: NetworkStatus {
                online: true,
                checked_at: None,
            },
        }
    }

    pub fn save(&mut self) {
        self.config.version = 1;
        let Ok(text) = serde_json::to_string_pretty(&self.config) else {
            return;
        };
        let temp = self.config_path.with_extension("json.tmp");
        if fs::write(&temp, text).is_ok() {
            let _ = fs::rename(&temp, &self.config_path);
        }
    }

    fn save_secrets(&mut self) -> Result<(), String> {
        if !self.secrets_ready {
            return Err("系统安全存储不可用，无法保存访问令牌".into());
        }
        let payload = serde_json::to_vec(&self.secrets).map_err(|e| e.to_string())?;
        // 优先使用 Electron（Chromium v10）格式，保证两代实现可互相读取。
        let encrypted = match electron_key(&self.data_dir).and_then(|key| v10::encrypt(&payload, &key))
        {
            Some(blob) => blob,
            None => dpapi::protect(&payload)?,
        };
        let encoded = base64::engine::general_purpose::STANDARD.encode(encrypted);
        fs::write(&self.secrets_path, encoded).map_err(|e| e.to_string())
    }
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct GlobalSettingsPatch {
    master_enabled: Option<bool>,
    default_time: Option<String>,
    auto_launch: Option<bool>,
    start_minimized: Option<bool>,
    close_to_tray: Option<bool>,
    show_checkin_popup: Option<bool>,
    theme: Option<crate::models::ThemeMode>,
    log_retention_days: Option<u32>,
    developer_mode: Option<bool>,
    allow_prerelease: Option<bool>,
}

impl GlobalSettingsPatch {
    fn apply(self, settings: &mut GlobalSettings) {
        if let Some(v) = self.master_enabled {
            settings.master_enabled = v;
        }
        if let Some(v) = self.default_time {
            if is_valid_time(&v) {
                settings.default_time = v;
            }
        }
        if let Some(v) = self.auto_launch {
            settings.auto_launch = v;
        }
        if let Some(v) = self.start_minimized {
            settings.start_minimized = v;
        }
        if let Some(v) = self.close_to_tray {
            settings.close_to_tray = v;
        }
        if let Some(v) = self.show_checkin_popup {
            settings.show_checkin_popup = v;
        }
        if let Some(v) = self.theme {
            settings.theme = v;
        }
        if let Some(v) = self.log_retention_days {
            settings.log_retention_days = v.clamp(1, 90);
        }
        if let Some(v) = self.developer_mode {
            settings.developer_mode = v;
        }
        if let Some(v) = self.allow_prerelease {
            settings.allow_prerelease = v;
        }
    }
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct AppConfigPatch {
    enabled: Option<bool>,
    use_custom_time: Option<bool>,
    time: Option<String>,
    custom_path: Option<String>,
    custom_exe_path: Option<String>,
}

impl AppConfigPatch {
    fn apply(self, app: &mut AppConfig) {
        if let Some(v) = self.enabled {
            app.enabled = v;
        }
        if let Some(v) = self.use_custom_time {
            app.use_custom_time = v;
        }
        if let Some(v) = self.time {
            if is_valid_time(&v) {
                app.time = v;
            }
        }
        if let Some(v) = self.custom_path {
            app.custom_path = Some(v.trim().to_string()).filter(|s| !s.is_empty());
        }
        if let Some(v) = self.custom_exe_path {
            app.custom_exe_path = Some(v.trim().to_string()).filter(|s| !s.is_empty());
        }
    }
}

#[derive(Default)]
pub struct AppRuntimePatch {
    pub status: Option<RunStatus>,
    pub message: Option<String>,
    pub credits: Option<Option<i64>>,
    pub last_success_date: Option<Option<String>>,
    pub last_success_at: Option<Option<String>>,
    pub last_attempt_at: Option<Option<String>>,
    pub last_attempt_date: Option<Option<String>>,
    pub attempts: Option<u32>,
    pub today_checked_in: Option<Option<bool>>,
    pub probe_date: Option<Option<String>>,
    pub user_label: Option<Option<String>>,
}

impl AppRuntimePatch {
    fn apply(self, runtime: &mut AppRuntime) {
        if let Some(v) = self.status {
            runtime.status = v;
        }
        if let Some(v) = self.message {
            runtime.message = v;
        }
        if let Some(v) = self.credits {
            runtime.credits = v;
        }
        if let Some(v) = self.last_success_date {
            runtime.last_success_date = v;
        }
        if let Some(v) = self.last_success_at {
            runtime.last_success_at = v;
        }
        if let Some(v) = self.last_attempt_at {
            runtime.last_attempt_at = v;
        }
        if let Some(v) = self.last_attempt_date {
            runtime.last_attempt_date = v;
        }
        if let Some(v) = self.attempts {
            runtime.attempts = v;
        }
        if let Some(v) = self.today_checked_in {
            runtime.today_checked_in = v;
        }
        if let Some(v) = self.probe_date {
            runtime.probe_date = v;
        }
        if let Some(v) = self.user_label {
            runtime.user_label = v;
        }
    }
}

pub fn is_valid_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return false;
    }
    let hour: u32 = value[..2].parse().unwrap_or(99);
    let minute: u32 = value[3..].parse().unwrap_or(99);
    hour < 24 && minute < 60
}

fn data_dir() -> PathBuf {
    if let Some(value) = std::env::var_os("AUTOCREDIT_DATA_DIR") {
        if !value.is_empty() {
            return PathBuf::from(value);
        }
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("AutoCredit")
}

fn load_config(path: &Path) -> ConfigFile {
    let mut config = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<ConfigFile>(&text).ok())
        .unwrap_or_default();

    for id in APP_ORDER {
        config.apps.entry(id).or_insert_with(|| AppConfig {
            enabled: id != AppId::Doubao,
            ..Default::default()
        });
        config
            .runtime
            .entry(id)
            .or_insert_with(RunStatus::default_runtime);
    }
    config
}

fn load_secrets(path: &Path, data_dir: &Path) -> (HashMap<AppId, String>, bool) {
    let available = dpapi::available();
    let Some(text) = fs::read_to_string(path).ok() else {
        return (HashMap::new(), available);
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return (HashMap::new(), available);
    }

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(trimmed)
        .unwrap_or_default();
    let payload = if decoded.starts_with(b"v10") {
        // Electron safeStorage（Chromium v10，AES-256-GCM）
        electron_key(data_dir).and_then(|key| v10::decrypt(&decoded, &key))
    } else {
        dpapi::unprotect(&decoded)
    }
    .or_else(|| {
        // 兼容早期直接写入明文 JSON 的情况
        serde_json::from_slice::<HashMap<AppId, String>>(&decoded)
            .ok()
            .and_then(|v| serde_json::to_vec(&v).ok())
    });
    let secrets = payload
        .and_then(|bytes| serde_json::from_slice::<HashMap<AppId, String>>(&bytes).ok())
        .unwrap_or_default();
    (secrets, available)
}

/// 读取 Electron `Local State` 中的 `os_crypt.encrypted_key`（DPAPI 保护）。
fn electron_key(data_dir: &Path) -> Option<Vec<u8>> {
    let text = fs::read_to_string(data_dir.join("Local State")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let encoded = value.get("os_crypt")?.get("encrypted_key")?.as_str()?;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let payload = raw.strip_prefix(b"DPAPI").unwrap_or(&raw);
    let key = dpapi::unprotect(payload)?;
    (key.len() == 32).then_some(key)
}

mod v10 {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};

    const PREFIX: &[u8] = b"v10";
    const NONCE: usize = 12;
    const TAG: usize = 16;

    pub fn decrypt(blob: &[u8], key: &[u8]) -> Option<Vec<u8>> {
        if key.len() != 32 || blob.len() < PREFIX.len() + NONCE + TAG {
            return None;
        }
        if !blob.starts_with(PREFIX) {
            return None;
        }
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
        let nonce = Nonce::from_slice(&blob[PREFIX.len()..PREFIX.len() + NONCE]);
        cipher.decrypt(nonce, &blob[PREFIX.len() + NONCE..]).ok()
    }

    pub fn encrypt(plain: &[u8], key: &[u8]) -> Option<Vec<u8>> {
        if key.len() != 32 {
            return None;
        }
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
        let nonce_bytes: [u8; NONCE] = rand::random();
        let nonce = Nonce::from_slice(&nonce_bytes);
        let mut out = PREFIX.to_vec();
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&cipher.encrypt(nonce, plain).ok()?);
        Some(out)
    }
}

#[cfg(windows)]
mod dpapi {
    use std::ptr;
    use windows_sys::Win32::Foundation::{LocalFree, HLOCAL};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    const UI_FORBIDDEN: u32 = 0x1;

    pub fn available() -> bool {
        true
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("系统加密失败".into());
        }
        let result = unsafe {
            std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
        };
        unsafe {
            LocalFree(output.pbData as HLOCAL);
        }
        Ok(result)
    }

    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return None;
        }
        let result = unsafe {
            std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
        };
        unsafe {
            LocalFree(output.pbData as HLOCAL);
        }
        Some(result)
    }
}

#[cfg(not(windows))]
mod dpapi {
    pub fn available() -> bool {
        false
    }

    pub fn protect(_data: &[u8]) -> Result<Vec<u8>, String> {
        Err("当前平台不支持系统安全存储".into())
    }

    pub fn unprotect(_data: &[u8]) -> Option<Vec<u8>> {
        None
    }
}
