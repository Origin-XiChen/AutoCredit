fn main() {
    let setup = std::path::Path::new("resources/setup-embedded.exe");
    if !setup.exists() {
        panic!(
            "缺少 resources/setup-embedded.exe，请先运行 npm run installer:prepare 复制主程序安装包"
        );
    }
    tauri_build::build()
}
