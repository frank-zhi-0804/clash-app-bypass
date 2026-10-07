#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod rules;
use base64::{engine::general_purpose::STANDARD, Engine};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Write, path::{Path, PathBuf}, process::{Command, Stdio}, sync::Mutex, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tauri::Manager;

type Result<T> = std::result::Result<T, String>;
struct OperationLock(Mutex<()>);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppEntry { id: String, name: String, path: String, running: bool, processes: Vec<String>, source: String, warnings: Vec<String> }
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings { #[serde(default)] selected: Vec<AppEntry>, #[serde(default)] config_dir: String, #[serde(default)] dark: bool }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Integration { config_dir: String, found: bool, running: bool, managed: bool, message: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationResult { message: String, rule_count: usize }
#[derive(Default, Serialize, Deserialize)]
struct Manifest { #[serde(default)] issued_blocks: BTreeMap<String, Vec<String>> }

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?; Ok(dir)
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let temp = path.with_extension(format!("vd-{}-{stamp}.tmp", std::process::id()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e| e.to_string())?;
        file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
        drop(file); fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() { let _ = fs::remove_file(&temp); } result
}
fn read_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> Result<T> {
    if !path.exists() { return Ok(T::default()); }
    let data = fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&data).map_err(|e| format!("无法读取本工具数据 {}：{e}", path.display()))
}
fn write_json<T: Serialize>(path: &Path, data: &T) -> Result<()> { atomic_write(path, &serde_json::to_vec_pretty(data).map_err(|e| e.to_string())?) }

fn powershell(script: &str, inspect: Option<&str>) -> Result<String> {
    #[cfg(not(windows))] { let _ = (script, inspect); return Err("第一版仅支持 Windows".into()); }
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let shell = PathBuf::from(std::env::var("WINDIR").map_err(|_| "无法找到 Windows 目录")?).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = Command::new(shell);
        command.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &STANDARD.encode(bytes)])
            .creation_flags(0x08000000).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        command.env_remove("VERGE_DIRECT_INSPECT");
        if let Some(path) = inspect { command.env("VERGE_DIRECT_INSPECT", path); }
        let mut child = command.spawn().map_err(|e| format!("无法启动 Windows 扫描：{e}"))?;
        // Drain pipes concurrently to avoid a full stdout pipe deadlocking large scans.
        let stdout = child.stdout.take().ok_or("无法读取扫描输出")?;
        let stderr = child.stderr.take().ok_or("无法读取扫描错误")?;
        let out = std::thread::spawn(move || { use std::io::Read; let mut bytes = Vec::new(); let mut stream = stdout; stream.read_to_end(&mut bytes).map(|_| bytes) });
        let err = std::thread::spawn(move || { use std::io::Read; let mut bytes = Vec::new(); let mut stream = stderr; stream.read_to_end(&mut bytes).map(|_| bytes) });
        let started = Instant::now();
        let status = loop {
            match child.try_wait().map_err(|e| e.to_string())? { Some(s) => break s, None => {
                if started.elapsed() > Duration::from_secs(75) { let _ = child.kill(); let _ = child.wait(); return Err("扫描超时，请重试或手动添加软件".into()); }
                std::thread::sleep(Duration::from_millis(50));
            }}
        };
        let output = out.join().map_err(|_| "扫描线程异常")?.map_err(|e| e.to_string())?;
        let errors = err.join().map_err(|_| "扫描线程异常")?.map_err(|e| e.to_string())?;
        if !status.success() { return Err(format!("Windows 扫描失败：{}", String::from_utf8_lossy(&errors).trim())); }
        Ok(String::from_utf8_lossy(&output).trim_start_matches('\u{feff}').trim().into())
    }
}
fn scan(inspect: Option<&str>) -> Result<Vec<AppEntry>> {
    if let Some(path) = inspect {
        let path = Path::new(path);
        if !path.is_absolute() || !path.is_file() || path.extension().and_then(|x| x.to_str()).map(|x| !x.eq_ignore_ascii_case("exe")).unwrap_or(true) { return Err("请选择存在的 .exe 程序文件".into()); }
    }
    let output = powershell(include_str!("../scripts/scan.ps1"), inspect)?;
    serde_json::from_str(&output).map_err(|e| format!("无法解析扫描结果：{e}"))
}
fn clash_running() -> Result<bool> {
    let output = powershell("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=@(Get-Process -Name 'clash-verge','verge-mihomo','verge-mihomo-alpha' -ErrorAction SilentlyContinue); if($p.Count -gt 0){'true'}else{'false'}", None)?;
    Ok(output.trim() == "true")
}
fn config_dir(input: &str) -> Result<PathBuf> {
    let dir = if input.trim().is_empty() {
        PathBuf::from(std::env::var("APPDATA").map_err(|_| "无法检测 APPDATA")?).join("io.github.clash-verge-rev.clash-verge-rev")
    } else { PathBuf::from(input.trim()) };
    if !dir.is_absolute() || !dir.join("profiles.yaml").is_file() { return Err("未找到 profiles.yaml，请在设置中选择 Clash Verge Rev 配置目录".into()); }
    fs::canonicalize(&dir).map_err(|e| format!("无法访问 Clash 配置目录：{e}"))
}
fn script_path(dir: &Path) -> Result<PathBuf> {
    let profiles: serde_yaml::Value = serde_yaml::from_slice(&fs::read(dir.join("profiles.yaml")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let items = profiles.get("items").and_then(|v| v.as_sequence()).ok_or("profiles.yaml 没有有效的 items 清单")?;
    let item = items.iter().find(|v| v.get("uid").and_then(|x| x.as_str()) == Some("Script")).ok_or("找不到全局扩展脚本 Script，请先在 Clash 中创建全局扩展脚本")?;
    if item.get("type").and_then(|v| v.as_str()) != Some("script") { return Err("全局 Script 配置类型异常".into()); }
    let file = item.get("file").and_then(|v| v.as_str()).ok_or("全局脚本缺少文件名")?;
    if file.chars().any(|c| matches!(c, '/' | '\\')) || !file.ends_with(".js") { return Err("全局脚本文件路径不受支持".into()); }
    let path = fs::canonicalize(dir.join("profiles").join(file)).map_err(|e| format!("无法读取全局扩展脚本：{e}"))?;
    if !path.starts_with(dir) { return Err("全局脚本指向配置目录之外，第一版不支持此结构".into()); }
    Ok(path)
}
fn original_script(path: &Path) -> Result<String> { fs::read_to_string(path).map_err(|e| format!("无法读取原脚本：{e}")) }
fn verify_ownership(manifest: &Manifest, key: &str, current: &Option<String>) -> Result<()> {
    if let Some(block) = current {
        if !manifest.issued_blocks.get(key).map(|v| v.contains(block)).unwrap_or(false) { return Err("本工具规则段被外部修改或缺少本机记录，已停止写入。请从备份检查恢复".into()); }
    } Ok(())
}
fn modify_rules(app: &tauri::AppHandle, apps: &[AppEntry], input: &str, remove: bool) -> Result<OperationResult> {
    let data = data_dir(app)?;
    let lock = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(data.join("operation.lock")).map_err(|e| e.to_string())?;
    lock.try_lock_exclusive().map_err(|_| "另一个直连助手正在修改规则，请稍后重试")?;
    if clash_running()? { return Err("Clash Verge 或其内核仍在运行。请从系统托盘完全退出后重试".into()); }
    let dir = config_dir(input)?; let path = script_path(&dir)?;
    let source = original_script(&path)?;
    let (base, current) = rules::split_managed(&source)?;
    let manifest_path = data.join("ownership.json");
    let mut manifest: Manifest = read_json(&manifest_path)?;
    let key = path.to_string_lossy().to_lowercase(); verify_ownership(&manifest, &key, &current)?;
    let paths: Vec<String> = apps.iter().flat_map(|a| a.processes.clone()).collect();
    let remove = remove || paths.is_empty();
    if remove && current.is_none() { return Ok(OperationResult { message: "当前没有本工具规则，无需撤销".into(), rule_count: 0 }); }
    let block = if remove { None } else { Some(rules::make_block(&paths)?) };
    if !remove {
        // Revalidate every executable before generating rules; never silently apply stale paths.
        for path in &paths { if !Path::new(path).is_file() { return Err(format!("程序路径已失效，请重新扫描或取消选择：{path}")); } }
    }
    let new_source = match &block { Some(b) => rules::compose(&source, b)?, None => base };
    let backups = data.join("backups"); fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    atomic_write(&backups.join(format!("Script-{stamp}.js")), source.as_bytes())?;
    if let Some(block) = &block {
        let issued = manifest.issued_blocks.entry(key).or_default();
        if !issued.contains(block) { issued.push(block.clone()); }
        // Record ownership BEFORE replacement: a crash cannot orphan a newly written section.
        write_json(&manifest_path, &manifest)?;
    }
    // Optimistic concurrency guard against another editor or a newly restarted Clash instance.
    if clash_running()? || original_script(&path)? != source { return Err("Clash 已启动或脚本在操作期间被修改，已停止应用，请重试".into()); }
    atomic_write(&path, new_source.as_bytes())?;
    let rule_count = if remove { 0 } else { paths.into_iter().collect::<std::collections::BTreeSet<_>>().len() };
    Ok(OperationResult { message: if remove { "本工具规则已移除，请重新打开 Clash Verge".into() } else { format!("已写入 {rule_count} 条规则。请重新打开 Clash Verge，并使用规则模式；连接是否直连需在 Clash 中确认") }, rule_count })
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<Settings> { read_json(&data_dir(&app)?.join("settings.json")) }
#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<()> { write_json(&data_dir(&app)?.join("settings.json"), &settings) }
#[tauri::command]
async fn scan_apps() -> Result<Vec<AppEntry>> { tauri::async_runtime::spawn_blocking(|| scan(None)).await.map_err(|e| e.to_string())? }
#[tauri::command]
async fn inspect_app(path: String) -> Result<AppEntry> { tauri::async_runtime::spawn_blocking(move || scan(Some(&path))?.into_iter().next().ok_or("无法识别这个程序".into())).await.map_err(|e| e.to_string())? }
#[tauri::command]
async fn inspect_integration(config_dir: String) -> Result<Integration> {
    tauri::async_runtime::spawn_blocking(move || {
        let running = clash_running()?;
        match self::config_dir(&config_dir).and_then(|dir| script_path(&dir).map(|path| (dir, path))) {
            Ok((dir, path)) => { let (_, block) = rules::split_managed(&original_script(&path)?)?;
                Ok(Integration { config_dir: dir.to_string_lossy().trim_start_matches(r"\\?\").into(), found: true, running, managed: block.is_some(), message: if running { "已检测 Clash Verge。应用规则前请从托盘完全退出".into() } else { "已连接 Clash 配置目录。规则写入后需重新打开 Clash；后续订阅脚本可能覆盖全局规则，请检查实际连接".into() } })
            }
            Err(e) => Ok(Integration { config_dir, found: false, running, managed: false, message: e })
        }
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn apply_rules(app: tauri::AppHandle, state: tauri::State<'_, OperationLock>, apps: Vec<AppEntry>, config_dir: String) -> Result<OperationResult> {
    // A non-blocking guard avoids overlapping requests within one process.
    let guard = state.0.try_lock().map_err(|_| "操作正在进行，请稍后重试")?;
    let result = modify_rules(&app, &apps, &config_dir, false); drop(guard); result
}
#[tauri::command]
async fn remove_rules(app: tauri::AppHandle, state: tauri::State<'_, OperationLock>, config_dir: String) -> Result<OperationResult> {
    let guard = state.0.try_lock().map_err(|_| "操作正在进行，请稍后重试")?;
    let result = modify_rules(&app, &[], &config_dir, true); drop(guard); result
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| { if let Some(w) = app.get_webview_window("main") { let _ = w.set_focus(); } }))
        .plugin(tauri_plugin_dialog::init())
        .manage(OperationLock(Mutex::new(())))
        .invoke_handler(tauri::generate_handler![load_settings, save_settings, scan_apps, inspect_app, inspect_integration, apply_rules, remove_rules])
        .run(tauri::generate_context!()).expect("无法启动直连助手");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn external_edits_require_manual_review() {
        let mut manifest = Manifest::default();
        manifest.issued_blocks.insert("script".into(), vec!["owned".into()]);
        assert!(verify_ownership(&manifest, "script", &Some("owned".into())).is_ok());
        assert!(verify_ownership(&manifest, "script", &Some("edited".into())).is_err());
        assert!(verify_ownership(&manifest, "another-script", &Some("owned".into())).is_err());
        assert!(verify_ownership(&manifest, "script", &None).is_ok());
    }
    #[test]
    fn atomic_write_replaces_existing_file() {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("clash-app-bypass-test-{stamp}"));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("settings.json");
        atomic_write(&path, b"old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_file(&path).unwrap(); fs::remove_dir(&dir).unwrap();
    }
}
