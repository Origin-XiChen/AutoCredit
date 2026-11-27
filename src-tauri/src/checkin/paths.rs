use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

/// 展开 %VAR%、~ 和资源管理器复制路径时带上的引号。
pub fn expand_user_path(input: &str) -> String {
    let mut value = input.trim().to_string();
    if (value.starts_with('"') && value.ends_with('"'))
        || (value.starts_with('\'') && value.ends_with('\''))
    {
        value = value[1..value.len() - 1].trim().to_string();
    }

    let mut expanded = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '%' {
            let mut name = String::new();
            let mut closed = false;
            while let Some(next) = chars.next() {
                if next == '%' {
                    closed = true;
                    break;
                }
                name.push(next);
            }
            if closed {
                match std::env::var(&name) {
                    Ok(replacement) => expanded.push_str(&replacement),
                    Err(_) => {
                        expanded.push('%');
                        expanded.push_str(&name);
                        expanded.push('%');
                    }
                }
            } else {
                expanded.push('%');
                expanded.push_str(&name);
            }
        } else {
            expanded.push(ch);
        }
    }

    if expanded == "~" {
        return home_dir().to_string_lossy().to_string();
    }
    if let Some(rest) = expanded.strip_prefix("~/").or_else(|| expanded.strip_prefix("~\\")) {
        return home_dir().join(rest).to_string_lossy().to_string();
    }
    expanded
}

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

pub fn matching_directories(root: &Path, pattern: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|entry| pattern(&entry.file_name().to_string_lossy()))
        .map(|entry| entry.path())
        .collect()
}

pub fn unique_paths(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for path in paths {
        let key = path.to_string_lossy().to_lowercase();
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        result.push(path);
    }
    result
}
