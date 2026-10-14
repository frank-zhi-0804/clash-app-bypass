#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod rules;
mod live;
mod websites;
mod messages;
use messages::UiMessage;
use base64::{engine::general_purpose::STANDARD, Engine};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Write, path::{Path, PathBuf}, process::{Command, Stdio}, sync::{Arc, Mutex}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tauri::Manager;

type Result<T> = std::result::Result<T, UiMessage>;
struct OperationLock(Arc<Mutex<()>>);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppEntry { id: String, name: String, path: String, running: bool, processes: Vec<String>, #[serde(default)] suggested_processes: Vec<String>, #[serde(default)] source: String, #[serde(default)] warnings: Vec<String>, #[serde(default, skip_serializing_if = "Option::is_none")] source_message: Option<UiMessage>, #[serde(default, skip_serializing_if = "Option::is_none")] warning_messages: Option<Vec<UiMessage>>, #[serde(default)] path_missing: bool }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppliedState { #[serde(default)] revision: u32, fingerprint: String, pending_restart: bool, has_rules: bool }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings { #[serde(default, deserialize_with = "deserialize_language", skip_serializing_if = "Option::is_none")] language: Option<String>, #[serde(default)] selected: Vec<AppEntry>, #[serde(default)] websites: Vec<String>, #[serde(default)] config_dir: String, #[serde(default)] dark: bool, #[serde(default = "default_mode")] other_traffic: String, #[serde(default = "default_group")] proxy_group: String, #[serde(default)] applied: Option<AppliedState> }
fn normalize_language(value: Option<String>) -> Option<String> { value.map(|language| if language == "en" { "en".into() } else { "zh-CN".into() }) }
fn deserialize_language<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Option<String>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    if value.is_null() { return Ok(None); }
    Ok(Some(if value.as_str() == Some("en") { "en".into() } else { "zh-CN".into() }))
}
fn materialize_legacy_metadata(mut entry: AppEntry) -> AppEntry {
    if let Some(message) = &entry.source_message { entry.source = message.legacy_text(); }
    if let Some(messages) = &entry.warning_messages { entry.warnings = messages.iter().map(UiMessage::legacy_text).collect(); }
    entry
}
fn add_warning(entry: &mut AppEntry, message: UiMessage) {
    // Fresh scan metadata is authoritative. Preserve legacy warnings only when no
    // descriptors are available, rather than guessing keys from old prose.
    entry.warnings.push(message.legacy_text());
    if let Some(messages) = &mut entry.warning_messages { messages.push(message); }
}
fn script_failure(output: &[u8], errors: &[u8]) -> UiMessage {
    match String::from_utf8_lossy(output).trim() {
        "SCAN_BATCH_JSON" => UiMessage::new("scanner.batchJson"),
        "SCAN_BATCH_LIMIT" => UiMessage::new("scanner.batchLimit"),
        "SCAN_BATCH_STRING" => UiMessage::new("scanner.batchString"),
        _ => UiMessage::detail("script.failed", String::from_utf8_lossy(errors).trim()),
    }
}
fn default_mode() -> String { "proxy".into() }
fn default_group() -> String { "GLOBAL".into() }
impl Default for Settings {
    fn default() -> Self { Self { language: None, selected: vec![], websites: vec![], config_dir: String::new(), dark: false, other_traffic: default_mode(), proxy_group: default_group(), applied: None } }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Integration { config_dir: String, found: bool, running: bool, managed: bool, message: UiMessage, proxy_groups: Vec<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationResult { message: UiMessage, rule_count: usize, pending_restart: bool }
#[derive(Serialize, Deserialize)]
struct LiveJournal { script_path: PathBuf, runtime_path: PathBuf, old_script: String, new_script: String, old_runtime: String, new_runtime: String }
fn pipe_controller(config: &serde_yaml::Value) -> Result<String> {
    let pipe = config.get("external-controller-pipe").and_then(|v| v.as_str()).ok_or(UiMessage::new("live.pipeMissing"))?;
    let prefix = r"\\.\pipe\";
    if !pipe.starts_with(prefix) || pipe.len() <= prefix.len() || pipe[prefix.len()..].chars().any(|c| !c.is_ascii_alphanumeric() && !matches!(c, '-' | '_' | '.')) {
        return Err(UiMessage::new("live.pipeOnly"));
    }
    Ok(pipe.into())
}
fn live_api(packet: &serde_json::Value) -> Result<serde_json::Value> {
    powershell_input(include_str!("../scripts/live-api.ps1"), None, Some(&packet.to_string()))
        .and_then(|output| match output.trim() {
            "LIVE_CONFLICT" => Err(UiMessage::new("live.conflict")),
            "LIVE_UNSUPPORTED" => Err(UiMessage::new("live.unsupported")),
            "LIVE_INVALID" => Err(UiMessage::new("live.invalid")),
            "LIVE_TRANSPORT" => Err(UiMessage::new("live.transport")),
            _ => {
                let value: serde_json::Value = serde_json::from_str(&output).map_err(|_| UiMessage::new("live.unverified"))?;
                if value.get("verified").and_then(|v| v.as_bool()) == Some(true) { Ok(value) } else { Err(UiMessage::new("live.unverified")) }
            },
        }).map_err(|e| if e.key.starts_with("backend:script.") { UiMessage::new("live.transport") } else { e })
}
#[derive(Default, Serialize, Deserialize)]
struct Manifest { #[serde(default)] issued_blocks: BTreeMap<String, Vec<String>> }

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir().map_err(UiMessage::technical)?;
    fs::create_dir_all(&dir).map_err(UiMessage::technical)?; Ok(dir)
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(UiMessage::technical)?.as_nanos();
    let temp = path.with_extension(format!("vd-{}-{stamp}.tmp", std::process::id()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(UiMessage::technical)?;
        file.write_all(bytes).and_then(|_| file.sync_all()).map_err(UiMessage::technical)?;
        drop(file); fs::rename(&temp, path).map_err(UiMessage::technical)
    })();
    if result.is_err() { let _ = fs::remove_file(&temp); } result
}
fn read_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> Result<T> {
    if !path.exists() { return Ok(T::default()); }
    let data = fs::read(path).map_err(UiMessage::technical)?;
    serde_json::from_slice(&data).map_err(|e| UiMessage::detail("data.read", e).with("path", path.display().to_string()))
}
fn write_json<T: Serialize>(path: &Path, data: &T) -> Result<()> { atomic_write(path, &serde_json::to_vec_pretty(data).map_err(UiMessage::technical)?) }

fn powershell(script: &str, inspect: Option<&str>) -> Result<String> {
    powershell_input(script, inspect, None)
}
fn powershell_input(script: &str, inspect: Option<&str>, input: Option<&str>) -> Result<String> {
    #[cfg(not(windows))] { let _ = (script, inspect, input); return Err(UiMessage::new("platform.windowsOnly")); }
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let shell = PathBuf::from(std::env::var("WINDIR").map_err(|_| UiMessage::new("platform.windowsDirectory"))?).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = Command::new(shell);
        command.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &STANDARD.encode(bytes)])
            .creation_flags(0x08000000).stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
        command.env_remove("VERGE_DIRECT_INSPECT");
        command.env_remove("VERGE_DIRECT_INSPECT_BATCH");
        if let Some(path) = inspect {
            if path.starts_with('[') { command.env("VERGE_DIRECT_INSPECT_BATCH", path); }
            else { command.env("VERGE_DIRECT_INSPECT", path); }
        }
        let mut child = command.spawn().map_err(|e| UiMessage::detail("script.start", e))?;
        if let Some(input) = input {
            child.stdin.take().ok_or(UiMessage::new("script.input"))?.write_all(input.as_bytes()).map_err(|_| UiMessage::new("script.input"))?;
        }
        // Drain pipes concurrently to avoid a full stdout pipe deadlocking large scans.
        let stdout = child.stdout.take().ok_or(UiMessage::new("script.stdout"))?;
        let stderr = child.stderr.take().ok_or(UiMessage::new("script.stderr"))?;
        let out = std::thread::spawn(move || { use std::io::Read; let mut bytes = Vec::new(); let mut stream = stdout; stream.read_to_end(&mut bytes).map(|_| bytes) });
        let err = std::thread::spawn(move || { use std::io::Read; let mut bytes = Vec::new(); let mut stream = stderr; stream.read_to_end(&mut bytes).map(|_| bytes) });
        let started = Instant::now();
        let status = loop {
            match child.try_wait().map_err(UiMessage::technical)? { Some(s) => break s, None => {
                if started.elapsed() > Duration::from_secs(75) { let _ = child.kill(); let _ = child.wait(); return Err(UiMessage::new("script.timeout")); }
                std::thread::sleep(Duration::from_millis(50));
            }}
        };
        let output = out.join().map_err(|_| UiMessage::new("script.thread"))?.map_err(UiMessage::technical)?;
        let errors = err.join().map_err(|_| UiMessage::new("script.thread"))?.map_err(UiMessage::technical)?;
        if !status.success() { return Err(script_failure(&output, &errors)); }
        Ok(String::from_utf8_lossy(&output).trim_start_matches('\u{feff}').trim().into())
    }
}
fn scan(inspect: Option<&str>) -> Result<Vec<AppEntry>> {
    if let Some(path) = inspect {
        let path = Path::new(path);
        if !path.is_absolute() || !path.is_file() || path.extension().and_then(|x| x.to_str()).map(|x| !x.eq_ignore_ascii_case("exe")).unwrap_or(true) { return Err(UiMessage::new("scanner.exeRequired")); }
    }
    let output = powershell(include_str!("../scripts/scan.ps1"), inspect)?;
    serde_json::from_str::<Vec<AppEntry>>(&output).map(|entries| entries.into_iter().map(materialize_legacy_metadata).collect()).map_err(|e| UiMessage::detail("scanner.parse", e))
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
    if removed > 0 { add_warning(&mut live, UiMessage::new("scanner.helpersRemoved").with("count", removed as u64)); }
    live
}

fn refresh_entries(apps: Vec<AppEntry>) -> Result<Vec<AppEntry>> {
    let paths: Vec<&str> = apps.iter().filter(|entry| Path::new(&entry.path).is_file()).map(|entry| entry.path.as_str()).collect();
    let mut refreshed = BTreeMap::new();
    for batch in paths.chunks(64) {
        let inspect = serde_json::to_string(batch).map_err(UiMessage::technical)?;
        let output = powershell(include_str!("../scripts/scan.ps1"), Some(&inspect))?;
        let live: Vec<AppEntry> = serde_json::from_str(&output).map_err(|e| UiMessage::detail("scanner.refreshParse", e))?;
        refreshed.extend(live.into_iter().map(materialize_legacy_metadata).map(|entry| (entry.path.to_lowercase(), entry)));
    }
    apps.into_iter().map(|previous| {
        if !Path::new(&previous.path).is_file() {
            let mut missing = previous;
            missing.path_missing = true;
            missing.running = false;
            missing.warning_messages = Some(vec![UiMessage::new("scanner.mainMissing")]);
            missing = materialize_legacy_metadata(missing);
            return Ok(missing);
        }
        let live = refreshed.get(&previous.path.to_lowercase()).cloned().ok_or(UiMessage::new("scanner.selectedUnknown"))?;
        Ok(reconcile_entry(&previous, live))
    }).collect()
}
fn clash_running() -> Result<bool> {
    let output = powershell("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=@(Get-Process -Name 'clash-verge','verge-mihomo','verge-mihomo-alpha' -ErrorAction SilentlyContinue); if($p.Count -gt 0){'true'}else{'false'}", None)?;
    Ok(output.trim() == "true")
}
fn config_dir(input: &str) -> Result<PathBuf> {
    let dir = if input.trim().is_empty() {
        PathBuf::from(std::env::var("APPDATA").map_err(|_| UiMessage::new("config.appData"))?).join("io.github.clash-verge-rev.clash-verge-rev")
    } else { PathBuf::from(input.trim()) };
    if !dir.is_absolute() || !dir.join("profiles.yaml").is_file() { return Err(UiMessage::new("config.profilesMissing")); }
    fs::canonicalize(&dir).map_err(|e| UiMessage::detail("config.access", e))
}
fn display_config_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        // Removing the extended UNC prefix must retain the leading network root.
        if rest.get(..4).map(|prefix| prefix.eq_ignore_ascii_case(r"UNC\")).unwrap_or(false) {
            return format!(r"\\{}", &rest[4..]);
        }
        let bytes = rest.as_bytes();
        if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/') {
            return rest.into();
        }
    }
    text.into_owned()
}
fn script_path(dir: &Path) -> Result<PathBuf> {
    let profiles: serde_yaml::Value = serde_yaml::from_slice(&fs::read(dir.join("profiles.yaml")).map_err(UiMessage::technical)?).map_err(UiMessage::technical)?;
    let items = profiles.get("items").and_then(|v| v.as_sequence()).ok_or(UiMessage::new("config.items"))?;
    let item = items.iter().find(|v| v.get("uid").and_then(|x| x.as_str()) == Some("Script")).ok_or(UiMessage::new("config.scriptMissing"))?;
    if item.get("type").and_then(|v| v.as_str()) != Some("script") { return Err(UiMessage::new("config.scriptType")); }
    let file = item.get("file").and_then(|v| v.as_str()).ok_or(UiMessage::new("config.scriptFilename"))?;
    if file.chars().any(|c| matches!(c, '/' | '\\')) || !file.ends_with(".js") { return Err(UiMessage::new("config.scriptPath")); }
    let path = fs::canonicalize(dir.join("profiles").join(file)).map_err(|e| UiMessage::detail("config.scriptRead", e))?;
    if !path.starts_with(dir) { return Err(UiMessage::new("config.scriptOutside")); }
    Ok(path)
}
fn original_script(path: &Path) -> Result<String> { fs::read_to_string(path).map_err(|e| UiMessage::detail("config.originalRead", e)) }
#[tauri::command]
async fn diagnose_routing(config_dir: String) -> Result<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = self::config_dir(&config_dir)?;
        let bytes = fs::read(dir.join("clash-verge.yaml")).map_err(|e| UiMessage::detail("diagnostic.runtimeRead", e))?;
        let config: serde_yaml::Value = serde_yaml::from_slice(&bytes).map_err(|e| UiMessage::detail("diagnostic.runtimeFormat", e))?;
        let pipe = config.get("external-controller-pipe").and_then(|v| v.as_str()).ok_or(UiMessage::new("diagnostic.pipeMissing"))?;
        let prefix = r"\\.\pipe\";
        if !pipe.starts_with(prefix) || pipe.len() <= prefix.len() || pipe[prefix.len()..].chars().any(|c| !c.is_ascii_alphanumeric() && !matches!(c, '-' | '_' | '.')) {
            return Err(UiMessage::new("diagnostic.pipeOnly"));
        }
        let script = format!("$controller = '{}'\n{}", pipe, include_str!("../scripts/diagnose.ps1"));
        let output = powershell(&script, None).map_err(|_| UiMessage::new("diagnostic.read"))?;
        match output.trim() {
            "DIAGNOSTIC_TIMEOUT" => Err(UiMessage::new("diagnostic.timeout")),
            "DIAGNOSTIC_TOO_LARGE" => Err(UiMessage::new("diagnostic.tooLarge")),
            "DIAGNOSTIC_RESPONSE" => Err(UiMessage::new("diagnostic.response")),
            "DIAGNOSTIC_TRANSPORT" => Err(UiMessage::new("diagnostic.read")),
            _ => serde_json::from_str(&output).map_err(|e| UiMessage::detail("diagnostic.parse", e)),
        }
    }).await.map_err(UiMessage::technical)?
}
fn verify_ownership(manifest: &Manifest, key: &str, current: &Option<String>) -> Result<()> {
    if let Some(block) = current {
        if !manifest.issued_blocks.get(key).map(|v| v.contains(block)).unwrap_or(false) { return Err(UiMessage::new("rules.ownership")); }
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
fn modify_rules(app: &tauri::AppHandle, apps: &[AppEntry], websites: &[String], input: &str, remove: bool, mode: &str, group: &str) -> Result<OperationResult> {
    let data = data_dir(app)?;
    let lock = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(data.join("operation.lock")).map_err(UiMessage::technical)?;
    lock.try_lock_exclusive().map_err(|_| UiMessage::new("rules.otherInstance"))?;
    let running = clash_running()?;
    let dir = config_dir(input)?; let path = script_path(&dir)?;
    let journal_path = data.join("pending-live.json");
    if journal_path.exists() {
        if running { return Err(UiMessage::new("recovery.interrupted")); }
        let journal: LiveJournal = serde_json::from_slice(&fs::read(&journal_path).map_err(UiMessage::technical)?).map_err(|e| UiMessage::detail("recovery.format", e))?;
        if journal.script_path != path || journal.runtime_path != dir.join("clash-verge.yaml") { return Err(UiMessage::new("recovery.otherConfig")); }
        for (file, old, new) in [(&journal.script_path, &journal.old_script, &journal.new_script), (&journal.runtime_path, &journal.old_runtime, &journal.new_runtime)] {
            let current = original_script(file)?;
            if current != *old && current != *new { return Err(UiMessage::new("recovery.externallyChanged")); }
        }
        atomic_write(&path, journal.old_script.as_bytes())?;
        atomic_write(&journal.runtime_path, journal.old_runtime.as_bytes())?;
        fs::remove_file(&journal_path).map_err(UiMessage::technical)?;
    }
    let source = original_script(&path)?;
    let (base, current) = rules::split_managed(&source)?;
    let manifest_path = data.join("ownership.json");
    let mut manifest: Manifest = read_json(&manifest_path)?;
    let key = path.to_string_lossy().to_lowercase(); verify_ownership(&manifest, &key, &current)?;
    let paths: Vec<String> = apps.iter().flat_map(|a| a.processes.clone()).collect();
    let sites = websites::validate_saved(websites)?;
    let remove = remove || (paths.is_empty() && sites.is_empty() && mode == "subscription");
    if remove && current.is_none() { return Ok(OperationResult { message: UiMessage::new("rules.nothingToRemove"), rule_count: 0, pending_restart: false }); }
    if !remove && mode == "proxy" && !proxy_groups(&dir).iter().any(|name| name == group) {
        return Err(UiMessage::new("rules.groupMissing"));
    }
    let block = if remove { None } else { Some(rules::make_block_with_websites(&paths, &sites, mode, group)?) };
    if !remove {
        for app in apps {
            if !Path::new(&app.path).is_file() { return Err(UiMessage::new("rules.mainMissing").with("path", app.path.clone())); }
        }
        // Revalidate every executable before generating rules; never silently apply stale paths.
        for path in &paths { if !Path::new(path).is_file() { return Err(UiMessage::new("rules.helperMissing").with("path", path.clone())); } }
    }
    let new_source = match &block { Some(b) => rules::compose(&source, b)?, None => base };
    let runtime_path = dir.join("clash-verge.yaml");
    let online = if running {
        let old_runtime = original_script(&runtime_path)?;
        let (new_runtime, previous_rules, next_rules) = live::plan(&old_runtime, current.as_deref(), block.as_deref())?;
        let general: serde_yaml::Value = serde_yaml::from_str(&old_runtime).map_err(|e| UiMessage::detail("live.runtimeFormat", e))?;
        let controller = pipe_controller(&general)?;
        let mut packet = serde_json::json!({"action":"preflight", "controller":controller, "general":general, "previousRules":previous_rules, "nextRules":next_rules, "payload":new_runtime});
        let preflight = live_api(&packet)?;
        let previous = preflight.get("previousRouting").ok_or(UiMessage::new("live.previousRouting"))?;
        packet["expectedRouting"] = previous.clone();
        let mut restore_general = general.clone();
        restore_general["mode"] = serde_yaml::Value::String(previous.get("mode").and_then(|v| v.as_str()).ok_or(UiMessage::new("live.previousMode"))?.into());
        restore_general["find-process-mode"] = serde_yaml::Value::String(previous.get("findProcessMode").and_then(|v| v.as_str()).ok_or(UiMessage::new("live.previousProcessMode"))?.into());
        packet["restorePayload"] = serde_json::json!(serde_yaml::to_string(&restore_general).map_err(|e| UiMessage::detail("recovery.prepare", e))?);
        packet["restoreGeneral"] = serde_json::to_value(&restore_general).map_err(|e| UiMessage::detail("recovery.prepare", e))?;
        Some((old_runtime, new_runtime, packet))
    } else { None };
    let backups = data.join("backups"); fs::create_dir_all(&backups).map_err(UiMessage::technical)?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(UiMessage::technical)?.as_nanos();
    atomic_write(&backups.join(format!("Script-{stamp}.js")), source.as_bytes())?;
    if let Some(block) = &block {
        let issued = manifest.issued_blocks.entry(key).or_default();
        if !issued.contains(block) { issued.push(block.clone()); }
        // Record ownership BEFORE replacement: a crash cannot orphan a newly written section.
        write_json(&manifest_path, &manifest)?;
    }
    // Optimistic concurrency guard against another editor or a newly restarted Clash instance.
    if clash_running()? != running || original_script(&path)? != source { return Err(UiMessage::new("rules.stateChanged")); }
    if let Some((old_runtime, new_runtime, mut packet)) = online {
        if original_script(&runtime_path)? != old_runtime { return Err(UiMessage::new("rules.runtimeChanged")); }
        let journal = LiveJournal { script_path: path.clone(), runtime_path: runtime_path.clone(), old_script: source.clone(), new_script: new_source.clone(), old_runtime: old_runtime.clone(), new_runtime: new_runtime.clone() };
        write_json(&journal_path, &journal)?;
        atomic_write(&backups.join(format!("Runtime-{stamp}.yaml")), old_runtime.as_bytes())?;
        packet["action"] = serde_json::json!("apply");
        let result = (|| {
            atomic_write(&path, new_source.as_bytes())?;
            atomic_write(&runtime_path, new_runtime.as_bytes())?;
            live_api(&packet)?;
            if original_script(&path)? != new_source || original_script(&runtime_path)? != new_runtime { return Err(UiMessage::new("rules.changedDuringApply")); }
            Ok::<(), UiMessage>(())
        })();
        if let Err(error) = result {
            let script_now = original_script(&path)?; let runtime_now = original_script(&runtime_path)?;
            if (script_now != source && script_now != new_source) || (runtime_now != old_runtime && runtime_now != new_runtime) { return Err(UiMessage::cause("recovery.external", error)); }
            atomic_write(&path, source.as_bytes())?;
            atomic_write(&runtime_path, old_runtime.as_bytes())?;
            let restore = serde_json::json!({"action":"restore", "controller":packet["controller"], "payload":packet["restorePayload"], "previousRules":packet["nextRules"], "nextRules":packet["previousRules"], "general":packet["restoreGeneral"], "previousGeneral":serde_yaml::from_str::<serde_yaml::Value>(&journal.new_runtime).map_err(|e| UiMessage::detail("recovery.configFormat", e))?});
            if live_api(&restore).is_err() { return Err(UiMessage::cause("recovery.unverified", error)); }
            fs::remove_file(&journal_path).map_err(UiMessage::technical)?;
            return Err(UiMessage::cause("recovery.restored", error));
        }
        fs::remove_file(&journal_path).map_err(UiMessage::technical)?;
    } else { atomic_write(&path, new_source.as_bytes())?; }
    let rule_count = if remove { 0 } else { paths.into_iter().collect::<std::collections::BTreeSet<_>>().len() + sites.len() };
    Ok(OperationResult { message: if running { UiMessage::new("rules.appliedOnline").with("count", rule_count as u64) } else { UiMessage::new("rules.savedOffline").with("count", rule_count as u64) }, rule_count, pending_restart: !running })
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<Settings> { read_json(&data_dir(&app)?.join("settings.json")) }
#[tauri::command]
fn save_settings(app: tauri::AppHandle, mut settings: Settings) -> Result<()> { settings.language = normalize_language(settings.language); settings.websites = websites::validate_saved(&settings.websites)?; write_json(&data_dir(&app)?.join("settings.json"), &settings) }
#[tauri::command]
fn normalize_website(input: String) -> Result<websites::NormalizedWebsite> { websites::normalize(&input) }
#[tauri::command]
async fn scan_apps() -> Result<Vec<AppEntry>> { tauri::async_runtime::spawn_blocking(|| scan(None)).await.map_err(UiMessage::technical)? }
#[tauri::command]
async fn inspect_app(path: String) -> Result<AppEntry> { tauri::async_runtime::spawn_blocking(move || scan(Some(&path))?.into_iter().next().ok_or(UiMessage::new("scanner.appUnknown"))).await.map_err(UiMessage::technical)? }
#[tauri::command]
async fn refresh_selected(apps: Vec<AppEntry>) -> Result<Vec<AppEntry>> { tauri::async_runtime::spawn_blocking(move || refresh_entries(apps)).await.map_err(UiMessage::technical)? }
#[tauri::command]
async fn inspect_integration(config_dir: String) -> Result<Integration> {
    tauri::async_runtime::spawn_blocking(move || {
        let running = clash_running()?;
        match self::config_dir(&config_dir).and_then(|dir| script_path(&dir).map(|path| (dir, path))) {
            Ok((dir, path)) => { let (_, block) = rules::split_managed(&original_script(&path)?)?;
                Ok(Integration { proxy_groups: proxy_groups(&dir), config_dir: display_config_path(&dir), found: true, running, managed: block.is_some(), message: if running { UiMessage::new("integration.online") } else { UiMessage::new("integration.offline") } })
            }
            Err(e) => Ok(Integration { config_dir, found: false, running, managed: false, message: e, proxy_groups: vec!["GLOBAL".into()] })
        }
    }).await.map_err(UiMessage::technical)?
}
#[tauri::command]
async fn apply_rules(app: tauri::AppHandle, state: tauri::State<'_, OperationLock>, apps: Vec<AppEntry>, websites: Option<Vec<String>>, config_dir: String, other_traffic: String, proxy_group: String) -> Result<OperationResult> {
    // A non-blocking guard avoids overlapping requests within one process.
    let lock = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.try_lock().map_err(|_| UiMessage::new("operation.busy"))?;
        modify_rules(&app, &apps, &websites.unwrap_or_default(), &config_dir, false, &other_traffic, &proxy_group)
    }).await.map_err(UiMessage::technical)?
}
#[tauri::command]
async fn remove_rules(app: tauri::AppHandle, state: tauri::State<'_, OperationLock>, config_dir: String) -> Result<OperationResult> {
    let lock = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.try_lock().map_err(|_| UiMessage::new("operation.busy"))?;
        modify_rules(&app, &[], &[], &config_dir, true, "subscription", "")
    }).await.map_err(UiMessage::technical)?
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| { if let Some(w) = app.get_webview_window("main") { let _ = w.set_focus(); } }))
        .plugin(tauri_plugin_dialog::init())
        .manage(OperationLock(Arc::new(Mutex::new(()))))
        .invoke_handler(tauri::generate_handler![load_settings, save_settings, normalize_website, scan_apps, inspect_app, refresh_selected, inspect_integration, apply_rules, remove_rules, diagnose_routing])
        .run(tauri::generate_context!()).expect("Unable to start Clash App Bypass");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn displayed_config_paths_preserve_absolute_windows_roots() {
        for (source, expected) in [
            (r"\\?\C:\Users\name\配置", r"C:\Users\name\配置"),
            (r"\\?\UNC\server\share\配置", r"\\server\share\配置"),
            (r"\\?\unc\server\share", r"\\server\share"),
            (r"\\server\share\配置", r"\\server\share\配置"),
            (r"C:\Users\name\配置", r"C:\Users\name\配置"),
            (r"\\?\Volume{0123}\配置", r"\\?\Volume{0123}\配置"),
            (r"\\?\配置", r"\\?\配置"),
        ] {
            assert_eq!(display_config_path(Path::new(source)), expected);
        }
    }
    #[test]
    fn refresh_prunes_missing_helpers_and_preserves_existing_ones() {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("clash-app-bypass-refresh-{stamp}"));
        fs::create_dir(&dir).unwrap();
        let main = dir.join("main.exe"); let helper = dir.join("helper.exe"); let fresh = dir.join("fresh.exe");
        for path in [&main, &helper, &fresh] { fs::write(path, b"fixture").unwrap(); }
        let old = AppEntry { id: "app".into(), name: "Friendly name".into(), path: main.to_string_lossy().into(), running: false,
            processes: vec![main.to_string_lossy().into(), helper.to_string_lossy().into(), dir.join("removed.exe").to_string_lossy().into()],
            suggested_processes: vec![], source: "test".into(), warnings: vec![], source_message: None, warning_messages: Some(vec![]), path_missing: false };
        let live = AppEntry { processes: vec![main.to_string_lossy().into(), fresh.to_string_lossy().into()], name: "Filename".into(), ..old.clone() };
        let updated = reconcile_entry(&old, live);
        assert_eq!(updated.processes.len(), 3);
        assert!(updated.processes.contains(&helper.to_string_lossy().into_owned()));
        assert!(updated.processes.contains(&fresh.to_string_lossy().into_owned()));
        assert_eq!(updated.name, "Friendly name");
        assert!(updated.warning_messages.as_ref().unwrap().iter().any(|warning| warning.key == "backend:scanner.helpersRemoved" && warning.values["count"] == 1));
        fs::remove_file(&main).unwrap();
        let missing = refresh_entries(vec![updated]).unwrap();
        assert!(missing[0].path_missing);
        assert!(!missing[0].running);
        assert_eq!(missing[0].warning_messages.as_ref().unwrap()[0].key, "backend:scanner.mainMissing");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn defaults_and_old_settings_use_proxy_mode() {
        let empty = Settings::default();
        assert_eq!(empty.other_traffic, "proxy");
        assert_eq!(empty.proxy_group, "GLOBAL");
        let old: Settings = serde_json::from_str(r#"{"selected":[],"configDir":"","dark":false}"#).unwrap();
        assert!(old.websites.is_empty());
        assert_eq!(old.other_traffic, "proxy");
        assert_eq!(old.proxy_group, "GLOBAL");
    }

    #[test]
    fn language_is_optional_safe_and_does_not_change_routing_data() {
        let old: Settings = serde_json::from_str(r#"{"selected":[],"websites":["example.com"],"otherTraffic":"subscription","proxyGroup":"User Group","applied":{"revision":3,"fingerprint":"working","pendingRestart":false,"hasRules":true}}"#).unwrap();
        assert_eq!(old.language, None);
        let before = serde_json::to_value(&old).unwrap();
        let mut changed = old.clone(); changed.language = Some("en".into());
        let mut after = serde_json::to_value(&changed).unwrap();
        assert_eq!(after["language"], "en");
        after.as_object_mut().unwrap().remove("language");
        assert_eq!(before, after);
        for value in [serde_json::json!("fr"), serde_json::json!("EN"), serde_json::json!(42), serde_json::json!([]), serde_json::json!({})] {
            let data = serde_json::json!({"language":value});
            let settings: Settings = serde_json::from_value(data).unwrap();
            assert_eq!(settings.language.as_deref(), Some("zh-CN"));
            assert_eq!(settings.other_traffic, "proxy");
        }
        let empty: Settings = serde_json::from_value(serde_json::json!({"language":null})).unwrap();
        assert_eq!(empty.language, None);
        assert_eq!(normalize_language(Some("unknown".into())).as_deref(), Some("zh-CN"));
        assert_eq!(normalize_language(Some("en".into())).as_deref(), Some("en"));
    }
    #[test]
    fn metadata_sidecars_are_readable_by_old_settings_shape() {
        let old_json = serde_json::json!({"id":"user", "name":"User supplied name", "path":r"C:\User\app.exe", "running":false, "processes":[r"C:\User\app.exe"], "source":"user label", "warnings":["user warning"]});
        let old: AppEntry = serde_json::from_value(old_json.clone()).unwrap();
        assert!(old.source_message.is_none()); assert!(old.warning_messages.is_none());
        assert_eq!(serde_json::to_value(&old).unwrap()["warnings"], old_json["warnings"]);
        let entry = materialize_legacy_metadata(AppEntry { source_message: Some(UiMessage::new("scanner.source.manual")), warning_messages: Some(vec![UiMessage::new("scanner.associationHelp")]), ..old });
        let value = serde_json::to_value(&entry).unwrap();
        #[derive(Deserialize)] struct LegacyEntry { source: String, warnings: Vec<String>, name: String, path: String, processes: Vec<String> }
        let legacy: LegacyEntry = serde_json::from_value(value).unwrap();
        assert_eq!(legacy.source, entry.source);
        assert_eq!(legacy.warnings, entry.warnings);
        assert_eq!(legacy.name, "User supplied name");
        assert_eq!(legacy.path, r"C:\User\app.exe");
        assert_eq!(legacy.processes, vec![r"C:\User\app.exe"]);
    }
    #[test]
    fn script_failure_reads_only_explicit_stable_codes() {
        let known = script_failure(b"SCAN_BATCH_LIMIT", b"script text or private details");
        assert_eq!(known.key, "backend:scanner.batchLimit");
        assert!(known.values.is_empty());
        let native = script_failure(b"", b"access denied");
        assert_eq!(native.key, "backend:script.failed");
        assert_eq!(native.values["detail"], "access denied");
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
