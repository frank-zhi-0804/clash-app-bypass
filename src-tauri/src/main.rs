#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod rules;
mod live;
use base64::{engine::general_purpose::STANDARD, Engine};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Write, path::{Path, PathBuf}, process::{Command, Stdio}, sync::{Arc, Mutex}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tauri::Manager;

type Result<T> = std::result::Result<T, String>;
struct OperationLock(Arc<Mutex<()>>);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppEntry { id: String, name: String, path: String, running: bool, processes: Vec<String>, #[serde(default)] suggested_processes: Vec<String>, source: String, warnings: Vec<String>, #[serde(default)] path_missing: bool }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppliedState { #[serde(default)] revision: u32, fingerprint: String, pending_restart: bool, has_rules: bool }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings { #[serde(default)] selected: Vec<AppEntry>, #[serde(default)] config_dir: String, #[serde(default)] dark: bool, #[serde(default = "default_mode")] other_traffic: String, #[serde(default = "default_group")] proxy_group: String, #[serde(default)] applied: Option<AppliedState> }
fn default_mode() -> String { "proxy".into() }
fn default_group() -> String { "GLOBAL".into() }
impl Default for Settings {
    fn default() -> Self { Self { selected: vec![], config_dir: String::new(), dark: false, other_traffic: default_mode(), proxy_group: default_group(), applied: None } }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Integration { config_dir: String, found: bool, running: bool, managed: bool, message: String, proxy_groups: Vec<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationResult { message: String, rule_count: usize, pending_restart: bool }
#[derive(Serialize, Deserialize)]
struct LiveJournal { script_path: PathBuf, runtime_path: PathBuf, old_script: String, new_script: String, old_runtime: String, new_runtime: String }
fn pipe_controller(config: &serde_yaml::Value) -> Result<String> {
    let pipe = config.get("external-controller-pipe").and_then(|v| v.as_str()).ok_or("未找到本机在线接口，请退出 Clash 后应用")?;
    let prefix = r"\\.\pipe\";
    if !pipe.starts_with(prefix) || pipe.len() <= prefix.len() || pipe[prefix.len()..].chars().any(|c| !c.is_ascii_alphanumeric() && !matches!(c, '-' | '_' | '.')) {
        return Err("在线接口必须是本机命名管道".into());
    }
    Ok(pipe.into())
}
fn live_api(packet: &serde_json::Value) -> Result<serde_json::Value> {
    powershell_input(include_str!("../scripts/live-api.ps1"), None, Some(&packet.to_string()))
        .and_then(|output| match output.trim() {
            "LIVE_CONFLICT" => Err("运行规则或网络设置已变化，已停止覆盖；请刷新 Clash 配置后重试".into()),
            "LIVE_UNSUPPORTED" => Err("当前规则结构不支持在线核对，请完全退出 Clash 后应用".into()),
            "LIVE_INVALID" => Err("在线操作参数无效，已停止修改".into()),
            "LIVE_TRANSPORT" => Err("无法连接或加载 Clash 在线接口，请检查 Clash 后重试".into()),
            _ => {
                let value: serde_json::Value = serde_json::from_str(&output).map_err(|_| "在线操作未返回验证结果，已停止修改")?;
                if value.get("verified").and_then(|v| v.as_bool()) == Some(true) { Ok(value) } else { Err("在线操作未返回验证结果，已停止修改".into()) }
            },
        }).map_err(|e: String| if e.starts_with("Windows 扫描失败") { "无法连接 Clash 在线接口，请检查 Clash 后重试".into() } else { e })
}
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
    powershell_input(script, inspect, None)
}
fn powershell_input(script: &str, inspect: Option<&str>, input: Option<&str>) -> Result<String> {
    #[cfg(not(windows))] { let _ = (script, inspect, input); return Err("第一版仅支持 Windows".into()); }
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let shell = PathBuf::from(std::env::var("WINDIR").map_err(|_| "无法找到 Windows 目录")?).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = Command::new(shell);
        command.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &STANDARD.encode(bytes)])
            .creation_flags(0x08000000).stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
        command.env_remove("VERGE_DIRECT_INSPECT");
        command.env_remove("VERGE_DIRECT_INSPECT_BATCH");
        if let Some(path) = inspect {
            if path.starts_with('[') { command.env("VERGE_DIRECT_INSPECT_BATCH", path); }
            else { command.env("VERGE_DIRECT_INSPECT", path); }
        }
        let mut child = command.spawn().map_err(|e| format!("无法启动 Windows 扫描：{e}"))?;
        if let Some(input) = input {
            child.stdin.take().ok_or("无法传入本机配置")?.write_all(input.as_bytes()).map_err(|_| "无法传入本机配置")?;
        }
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

fn reconcile_entry(previous: &AppEntry, mut live: AppEntry) -> AppEntry {
    let removed = previous.processes.iter().filter(|path| !Path::new(path).is_file()).count();
    let mut paths: BTreeMap<String, String> = live.processes.iter().map(|path| (path.to_lowercase(), path.clone())).collect();
    for path in &previous.processes {
        if Path::new(path).is_file() { paths.entry(path.to_lowercase()).or_insert_with(|| path.clone()); }
    }
    paths.entry(live.path.to_lowercase()).or_insert_with(|| live.path.clone());
    live.processes = paths.into_values().collect();
    live.suggested_processes.retain(|path| !live.processes.iter().any(|p| p.eq_ignore_ascii_case(path)));
    live.name = previous.name.clone();
    live.path_missing = false;
    if removed > 0 { live.warnings.push(format!("已清理 {removed} 个失效的辅助程序路径，当前选择需重新应用")); }
    live
}

fn refresh_entries(apps: Vec<AppEntry>) -> Result<Vec<AppEntry>> {
    let paths: Vec<&str> = apps.iter().filter(|entry| Path::new(&entry.path).is_file()).map(|entry| entry.path.as_str()).collect();
    let mut refreshed = BTreeMap::new();
    for batch in paths.chunks(64) {
        let inspect = serde_json::to_string(batch).map_err(|e| e.to_string())?;
        let output = powershell(include_str!("../scripts/scan.ps1"), Some(&inspect))?;
        let live: Vec<AppEntry> = serde_json::from_str(&output).map_err(|e| format!("无法解析刷新结果：{e}"))?;
        refreshed.extend(live.into_iter().map(|entry| (entry.path.to_lowercase(), entry)));
    }
    apps.into_iter().map(|previous| {
        if !Path::new(&previous.path).is_file() {
            let mut missing = previous;
            missing.path_missing = true;
            missing.running = false;
            missing.warnings = vec!["主程序路径已失效。请取消选择，再添加新的程序文件".into()];
            return Ok(missing);
        }
        let live = refreshed.get(&previous.path.to_lowercase()).cloned().ok_or("无法识别所选程序，请重新添加")?;
        Ok(reconcile_entry(&previous, live))
    }).collect()
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
#[tauri::command]
async fn diagnose_routing(config_dir: String) -> Result<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = self::config_dir(&config_dir)?;
        let bytes = fs::read(dir.join("clash-verge.yaml")).map_err(|_| "无法读取 Clash 运行配置，请先启动 Clash")?;
        let config: serde_yaml::Value = serde_yaml::from_slice(&bytes).map_err(|_| "Clash 运行配置格式异常")?;
        let pipe = config.get("external-controller-pipe").and_then(|v| v.as_str()).ok_or("未找到本机命名管道诊断接口；暂时无法验证实际连接")?;
        let prefix = r"\\.\pipe\";
        if !pipe.starts_with(prefix) || pipe.len() <= prefix.len() || pipe[prefix.len()..].chars().any(|c| !c.is_ascii_alphanumeric() && !matches!(c, '-' | '_' | '.')) {
            return Err("诊断接口必须是本机命名管道，未修改 Clash 配置".into());
        }
        let script = format!("$controller = '{}'\n{}", pipe, include_str!("../scripts/diagnose.ps1"));
        let output = powershell(&script, None).map_err(|_| "无法读取 Clash 实际连接，请确认 Clash 已启动且允许访问本机诊断接口".to_string())?;
        serde_json::from_str(&output).map_err(|_| "无法解析 Clash 连接诊断结果".into())
    }).await.map_err(|e| e.to_string())?
}
fn verify_ownership(manifest: &Manifest, key: &str, current: &Option<String>) -> Result<()> {
    if let Some(block) = current {
        if !manifest.issued_blocks.get(key).map(|v| v.contains(block)).unwrap_or(false) { return Err("本工具规则段被外部修改或缺少本机记录，已停止写入。请从备份检查恢复".into()); }
    } Ok(())
}
fn proxy_groups(dir: &Path) -> Vec<String> {
    let mut groups = vec!["GLOBAL".to_string()];
    if let Ok(bytes) = fs::read(dir.join("clash-verge.yaml")) {
        if let Ok(config) = serde_yaml::from_slice::<serde_yaml::Value>(&bytes) {
            if let Some(items) = config.get("proxy-groups").and_then(|v| v.as_sequence()) {
                for item in items {
                    if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                        if !groups.iter().any(|g| g == name) { groups.push(name.to_string()); }
                    }
                }
            }
        }
    }
    groups
}
fn modify_rules(app: &tauri::AppHandle, apps: &[AppEntry], input: &str, remove: bool, mode: &str, group: &str) -> Result<OperationResult> {
    let data = data_dir(app)?;
    let lock = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(data.join("operation.lock")).map_err(|e| e.to_string())?;
    lock.try_lock_exclusive().map_err(|_| "另一个直连助手正在修改规则，请稍后重试")?;
    let running = clash_running()?;
    let dir = config_dir(input)?; let path = script_path(&dir)?;
    let journal_path = data.join("pending-live.json");
    if journal_path.exists() {
        if running { return Err("上次在线操作中断，请完全退出 Clash 后应用一次以恢复".into()); }
        let journal: LiveJournal = serde_json::from_slice(&fs::read(&journal_path).map_err(|e| e.to_string())?).map_err(|_| "恢复记录格式异常")?;
        if journal.script_path != path || journal.runtime_path != dir.join("clash-verge.yaml") { return Err("恢复记录对应另一份配置，请先检查".into()); }
        for (file, old, new) in [(&journal.script_path, &journal.old_script, &journal.new_script), (&journal.runtime_path, &journal.old_runtime, &journal.new_runtime)] {
            let current = original_script(file)?;
            if current != *old && current != *new { return Err("恢复文件已被其他程序修改，已保留现场".into()); }
        }
        atomic_write(&path, journal.old_script.as_bytes())?;
        atomic_write(&journal.runtime_path, journal.old_runtime.as_bytes())?;
        fs::remove_file(&journal_path).map_err(|e| e.to_string())?;
    }
    let source = original_script(&path)?;
    let (base, current) = rules::split_managed(&source)?;
    let manifest_path = data.join("ownership.json");
    let mut manifest: Manifest = read_json(&manifest_path)?;
    let key = path.to_string_lossy().to_lowercase(); verify_ownership(&manifest, &key, &current)?;
    let paths: Vec<String> = apps.iter().flat_map(|a| a.processes.clone()).collect();
    let remove = remove || (paths.is_empty() && mode == "subscription");
    if remove && current.is_none() { return Ok(OperationResult { message: "当前没有本工具规则，无需撤销".into(), rule_count: 0, pending_restart: false }); }
    if !remove && mode == "proxy" && !proxy_groups(&dir).iter().any(|name| name == group) {
        return Err("所选代理组已不存在，请刷新订阅后重新检测并选择代理组".into());
    }
    let block = if remove { None } else { Some(rules::make_block(&paths, mode, group)?) };
    if !remove {
        for app in apps {
            if !Path::new(&app.path).is_file() { return Err(format!("主程序路径已失效，请取消选择并重新添加：{}", app.path)); }
        }
        // Revalidate every executable before generating rules; never silently apply stale paths.
        for path in &paths { if !Path::new(path).is_file() { return Err(format!("程序路径已失效，请重新扫描或取消选择：{path}")); } }
    }
    let new_source = match &block { Some(b) => rules::compose(&source, b)?, None => base };
    let runtime_path = dir.join("clash-verge.yaml");
    let online = if running {
        let old_runtime = original_script(&runtime_path)?;
        let (new_runtime, previous_rules, next_rules) = live::plan(&old_runtime, current.as_deref(), block.as_deref())?;
        let general: serde_yaml::Value = serde_yaml::from_str(&old_runtime).map_err(|_| "运行配置格式异常")?;
        let controller = pipe_controller(&general)?;
        let mut packet = serde_json::json!({"action":"preflight", "controller":controller, "general":general, "previousRules":previous_rules, "nextRules":next_rules, "payload":new_runtime});
        let preflight = live_api(&packet)?;
        let previous = preflight.get("previousRouting").ok_or("在线预检未返回原路由状态")?;
        let mut restore_general = general.clone();
        restore_general["mode"] = serde_yaml::Value::String(previous.get("mode").and_then(|v| v.as_str()).ok_or("原路由模式无法核对")?.into());
        restore_general["find-process-mode"] = serde_yaml::Value::String(previous.get("findProcessMode").and_then(|v| v.as_str()).ok_or("原进程识别状态无法核对")?.into());
        packet["restorePayload"] = serde_json::json!(serde_yaml::to_string(&restore_general).map_err(|_| "无法准备恢复配置")?);
        packet["restoreGeneral"] = serde_json::to_value(&restore_general).map_err(|_| "无法准备恢复配置")?;
        Some((old_runtime, new_runtime, packet))
    } else { None };
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
    if clash_running()? != running || original_script(&path)? != source { return Err("Clash 状态或脚本在操作期间变化，已停止应用，请重试".into()); }
    if let Some((old_runtime, new_runtime, mut packet)) = online {
        if original_script(&runtime_path)? != old_runtime { return Err("运行配置已被其他程序修改，请重试".into()); }
        let journal = LiveJournal { script_path: path.clone(), runtime_path: runtime_path.clone(), old_script: source.clone(), new_script: new_source.clone(), old_runtime: old_runtime.clone(), new_runtime: new_runtime.clone() };
        write_json(&journal_path, &journal)?;
        atomic_write(&backups.join(format!("Runtime-{stamp}.yaml")), old_runtime.as_bytes())?;
        packet["action"] = serde_json::json!("apply");
        let result = (|| {
            atomic_write(&path, new_source.as_bytes())?;
            atomic_write(&runtime_path, new_runtime.as_bytes())?;
            live_api(&packet)?;
            if original_script(&path)? != new_source || original_script(&runtime_path)? != new_runtime { return Err("其他程序在应用期间更新了配置".into()); }
            Ok::<(), String>(())
        })();
        if let Err(error) = result {
            let script_now = original_script(&path)?; let runtime_now = original_script(&runtime_path)?;
            if (script_now != source && script_now != new_source) || (runtime_now != old_runtime && runtime_now != new_runtime) { return Err(format!("{error}；发现外部修改，未覆盖配置，请先退出 Clash 检查恢复记录")); }
            atomic_write(&path, source.as_bytes())?;
            atomic_write(&runtime_path, old_runtime.as_bytes())?;
            let restore = serde_json::json!({"action":"restore", "controller":packet["controller"], "payload":packet["restorePayload"], "previousRules":packet["nextRules"], "nextRules":packet["previousRules"], "general":packet["restoreGeneral"], "previousGeneral":serde_yaml::from_str::<serde_yaml::Value>(&journal.new_runtime).map_err(|_| "恢复配置格式异常")?});
            if live_api(&restore).is_err() { return Err(format!("{error}；文件已恢复，内核状态无法确认，请退出 Clash 后重试")); }
            fs::remove_file(&journal_path).map_err(|e| e.to_string())?;
            return Err(format!("{error}；已恢复原配置和规则"));
        }
        fs::remove_file(&journal_path).map_err(|e| e.to_string())?;
    } else { atomic_write(&path, new_source.as_bytes())?; }
    let rule_count = if remove { 0 } else { paths.into_iter().collect::<std::collections::BTreeSet<_>>().len() };
    Ok(OperationResult { message: if running { format!("已保存并在线应用 {rule_count} 条规则，新连接已可使用规则模式；无需退出 Clash") } else { format!("已保存 {rule_count} 条规则，下次启动 Clash 后生效") }, rule_count, pending_restart: !running })
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
async fn refresh_selected(apps: Vec<AppEntry>) -> Result<Vec<AppEntry>> { tauri::async_runtime::spawn_blocking(move || refresh_entries(apps)).await.map_err(|e| e.to_string())? }
#[tauri::command]
async fn inspect_integration(config_dir: String) -> Result<Integration> {
    tauri::async_runtime::spawn_blocking(move || {
        let running = clash_running()?;
        match self::config_dir(&config_dir).and_then(|dir| script_path(&dir).map(|path| (dir, path))) {
            Ok((dir, path)) => { let (_, block) = rules::split_managed(&original_script(&path)?)?;
                Ok(Integration { proxy_groups: proxy_groups(&dir), config_dir: dir.to_string_lossy().trim_start_matches(r"\\?\").into(), found: true, running, managed: block.is_some(), message: if running { "已连接 Clash，支持自动保存和在线应用；旧连接不会被强制断开".into() } else { "已连接 Clash 配置目录，选择会自动保存规则，下次启动 Clash 后生效".into() } })
            }
            Err(e) => Ok(Integration { config_dir, found: false, running, managed: false, message: e, proxy_groups: vec!["GLOBAL".into()] })
        }
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn apply_rules(app: tauri::AppHandle, state: tauri::State<'_, OperationLock>, apps: Vec<AppEntry>, config_dir: String, other_traffic: String, proxy_group: String) -> Result<OperationResult> {
    // A non-blocking guard avoids overlapping requests within one process.
    let lock = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.try_lock().map_err(|_| "操作正在进行，请稍后重试")?;
        modify_rules(&app, &apps, &config_dir, false, &other_traffic, &proxy_group)
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn remove_rules(app: tauri::AppHandle, state: tauri::State<'_, OperationLock>, config_dir: String) -> Result<OperationResult> {
    let lock = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.try_lock().map_err(|_| "操作正在进行，请稍后重试")?;
        modify_rules(&app, &[], &config_dir, true, "subscription", "")
    }).await.map_err(|e| e.to_string())?
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| { if let Some(w) = app.get_webview_window("main") { let _ = w.set_focus(); } }))
        .plugin(tauri_plugin_dialog::init())
        .manage(OperationLock(Arc::new(Mutex::new(()))))
        .invoke_handler(tauri::generate_handler![load_settings, save_settings, scan_apps, inspect_app, refresh_selected, inspect_integration, apply_rules, remove_rules, diagnose_routing])
        .run(tauri::generate_context!()).expect("无法启动直连助手");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refresh_prunes_missing_helpers_and_preserves_existing_ones() {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("clash-app-bypass-refresh-{stamp}"));
        fs::create_dir(&dir).unwrap();
        let main = dir.join("main.exe"); let helper = dir.join("helper.exe"); let fresh = dir.join("fresh.exe");
        for path in [&main, &helper, &fresh] { fs::write(path, b"fixture").unwrap(); }
        let old = AppEntry { id: "app".into(), name: "Friendly name".into(), path: main.to_string_lossy().into(), running: false,
            processes: vec![main.to_string_lossy().into(), helper.to_string_lossy().into(), dir.join("removed.exe").to_string_lossy().into()],
            suggested_processes: vec![], source: "test".into(), warnings: vec![], path_missing: false };
        let live = AppEntry { processes: vec![main.to_string_lossy().into(), fresh.to_string_lossy().into()], name: "Filename".into(), ..old.clone() };
        let updated = reconcile_entry(&old, live);
        assert_eq!(updated.processes.len(), 3);
        assert!(updated.processes.contains(&helper.to_string_lossy().into_owned()));
        assert!(updated.processes.contains(&fresh.to_string_lossy().into_owned()));
        assert_eq!(updated.name, "Friendly name");
        assert!(updated.warnings.iter().any(|warning| warning.contains("1 个失效")));
        fs::remove_file(&main).unwrap();
        let missing = refresh_entries(vec![updated]).unwrap();
        assert!(missing[0].path_missing);
        assert!(!missing[0].running);
        assert!(missing[0].warnings[0].contains("主程序路径已失效"));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn defaults_and_old_settings_use_proxy_mode() {
        let empty = Settings::default();
        assert_eq!(empty.other_traffic, "proxy");
        assert_eq!(empty.proxy_group, "GLOBAL");
        let old: Settings = serde_json::from_str(r#"{"selected":[],"configDir":"","dark":false}"#).unwrap();
        assert_eq!(old.other_traffic, "proxy");
        assert_eq!(old.proxy_group, "GLOBAL");
    }
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
