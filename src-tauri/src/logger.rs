use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use regex::Regex;
use tauri::{AppHandle, Emitter};

use crate::models::{local_date_key, AppId, LogEntry, LogLevel};

const MAX_BUFFER: usize = 2000;

struct Inner {
    next_id: u64,
    entries: VecDeque<LogEntry>,
    logs_dir: PathBuf,
}

pub struct Logger {
    inner: Mutex<Inner>,
    app: Mutex<Option<AppHandle>>,
}

impl Logger {
    pub fn new(logs_dir: PathBuf, retention_days: u32) -> Self {
        let _ = fs::create_dir_all(&logs_dir);
        cleanup(&logs_dir, retention_days);
        let mut inner = Inner {
            next_id: 1,
            entries: VecDeque::new(),
            logs_dir,
        };
        load_today(&mut inner);
        Self {
            inner: Mutex::new(inner),
            app: Mutex::new(None),
        }
    }

    pub fn attach(&self, app: AppHandle) {
        if let Ok(mut handle) = self.app.lock() {
            *handle = Some(app);
        }
    }

    pub fn info(&self, message: impl Into<String>) {
        self.log(LogLevel::Info, None, message.into());
    }

    pub fn info_app(&self, message: impl Into<String>, app_id: AppId) {
        self.log(LogLevel::Info, Some(app_id), message.into());
    }

    pub fn success(&self, message: impl Into<String>, app_id: AppId) {
        self.log(LogLevel::Success, Some(app_id), message.into());
    }

    pub fn warn(&self, message: impl Into<String>, app_id: Option<AppId>) {
        self.log(LogLevel::Warn, app_id, message.into());
    }

    pub fn error(&self, message: impl Into<String>, app_id: Option<AppId>) {
        self.log(LogLevel::Error, app_id, message.into());
    }

    pub fn log(&self, level: LogLevel, app_id: Option<AppId>, message: String) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let entry = LogEntry {
            id: inner.next_id,
            ts: chrono::Utc::now().timestamp_millis(),
            level,
            app_id,
            message: sanitize(&message),
        };
        inner.next_id += 1;
        inner.entries.push_back(entry.clone());
        while inner.entries.len() > MAX_BUFFER {
            inner.entries.pop_front();
        }
        let path = inner.logs_dir.join(format!("autocredit-{}.jsonl", local_date_key()));
        if let Ok(line) = serde_json::to_string(&entry) {
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(file, "{line}");
            }
        }
        drop(inner);

        if let Ok(handle) = self.app.lock() {
            if let Some(app) = handle.as_ref() {
                let _ = app.emit("log:new", &entry);
            }
        }
    }

    pub fn entries(&self) -> Vec<LogEntry> {
        self.inner
            .lock()
            .map(|inner| inner.entries.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn clear(&self) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        inner.entries.clear();
        if let Ok(entries) = fs::read_dir(&inner.logs_dir) {
            for entry in entries.filter_map(Result::ok) {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("autocredit-") && name.ends_with(".jsonl") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        drop(inner);
        self.info("日志已清空");
    }

    pub fn export_text(&self) -> String {
        self.entries()
            .into_iter()
            .map(|entry| {
                let time = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(entry.ts)
                    .map(|value| {
                        value
                            .with_timezone(&chrono::Local)
                            .format("%Y/%m/%d %H:%M:%S")
                            .to_string()
                    })
                    .unwrap_or_default();
                let app = entry
                    .app_id
                    .map(|id| format!(" [{}]", id.as_str()))
                    .unwrap_or_default();
                format!(
                    "[{time}] [{}]{app} {}",
                    level_name(entry.level),
                    entry.message
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn level_name(level: LogLevel) -> &'static str {
    match level {
        LogLevel::Info => "INFO",
        LogLevel::Success => "SUCCESS",
        LogLevel::Warn => "WARN",
        LogLevel::Error => "ERROR",
    }
}

fn sanitize(message: &str) -> String {
    static RULES: OnceLock<Vec<Regex>> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        vec![
            Regex::new(r"(?i)(Bearer\s+)[A-Za-z0-9\-._~+/=]+").expect("regex"),
            Regex::new(r"(?i)(Cloud-IDE-JWT\s+)\S+").expect("regex"),
            Regex::new(
                r#"(?i)((?:accessToken|refreshToken|personal_token|token|authorization)\s*[:=]\s*["']?)[^"'\s,}]+"#,
            )
            .expect("regex"),
        ]
    });
    let mut value = message.to_string();
    for rule in rules {
        value = rule.replace_all(&value, "$1***").to_string();
    }
    value.replace('\r', " ").replace('\n', " ")
}

fn load_today(inner: &mut Inner) {
    let path = inner
        .logs_dir
        .join(format!("autocredit-{}.jsonl", local_date_key()));
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let skip = lines.len().saturating_sub(800);
    for line in lines.into_iter().skip(skip) {
        if let Ok(entry) = serde_json::from_str::<LogEntry>(line) {
            inner.next_id = inner.next_id.max(entry.id + 1);
            inner.entries.push_back(entry);
        }
    }
}

fn cleanup(dir: &Path, retention_days: u32) {
    let cutoff = chrono::Local::now().date_naive() - chrono::Duration::days(retention_days as i64);
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(date) = name
            .strip_prefix("autocredit-")
            .and_then(|v| v.strip_suffix(".jsonl"))
        else {
            continue;
        };
        let Ok(parsed) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") else {
            continue;
        };
        if parsed < cutoff {
            let _ = fs::remove_file(entry.path());
        }
    }
}
