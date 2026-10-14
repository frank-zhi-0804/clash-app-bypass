use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::{Arc, Mutex}, time::{Duration, Instant}};

const MAX_BATCH: usize = 32;
const MAX_CACHE_ITEMS: usize = 512;
const MAX_CACHE_BYTES: usize = 16 * 1024 * 1024;
const MAX_PNG_BYTES: usize = 128 * 1024;
const ICON_TTL: Duration = Duration::from_secs(600);
const FAILURE_TTL: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconRequest {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub shortcut_path: Option<String>,
}
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct IconKey { path: String, shortcut: Option<String> }
impl IconRequest {
    fn key(&self) -> IconKey {
        IconKey { path: self.path.replace('/', "\\").to_lowercase(), shortcut: self.shortcut_path.as_ref().map(|p| p.replace('/', "\\").to_lowercase()) }
    }
    fn valid(&self) -> bool { !self.id.is_empty() && self.id.len() <= 2048 && local_drive_path(&self.path) }
}
// The helper validates drive type and ancestors before any filesystem access.
fn local_drive_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3 && bytes.len() <= 32767 && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/')
        && !path.chars().any(char::is_control) && !path[2..].contains(':')
}
struct CacheEntry { icon: Option<String>, saved: Instant, sequence: u64 }
#[derive(Default)]
struct CacheInner { entries: HashMap<IconKey, CacheEntry>, generation: u64, sequence: u64 }
#[derive(Clone, Default)]
pub struct IconCache { inner: Arc<Mutex<CacheInner>> }
impl CacheInner {
    fn clear(&mut self) { self.entries.clear(); self.generation = self.generation.wrapping_add(1); }
    fn prune(&mut self) { self.prune_at(Instant::now()); }
    fn prune_at(&mut self, now: Instant) {
        self.entries.retain(|_, entry| now.saturating_duration_since(entry.saved) < if entry.icon.is_some() { ICON_TTL } else { FAILURE_TTL });
    }
    fn insert(&mut self, key: IconKey, icon: Option<String>) {
        self.sequence = self.sequence.wrapping_add(1);
        self.entries.insert(key, CacheEntry { icon, saved: Instant::now(), sequence: self.sequence });
        loop {
            let size: usize = self.entries.values().map(|v| v.icon.as_ref().map_or(0, String::len)).sum();
            if self.entries.len() <= MAX_CACHE_ITEMS && size <= MAX_CACHE_BYTES { break; }
            let oldest = self.entries.iter().min_by_key(|(_, v)| v.sequence).map(|(k, _)| k.clone());
            if let Some(key) = oldest { self.entries.remove(&key); } else { break; }
        }
    }
}
fn valid_png(icon: &str) -> bool {
    let Some(encoded) = icon.strip_prefix("data:image/png;base64,") else { return false; };
    if encoded.len() > ((MAX_PNG_BYTES + 2) / 3) * 4 { return false; }
    let Ok(bytes) = STANDARD.decode(encoded) else { return false; };
    bytes.len() >= 33 && bytes.len() <= MAX_PNG_BYTES && bytes[..16] == *b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR"
        && bytes[16..20] == [0, 0, 0, 64] && bytes[20..24] == [0, 0, 0, 64]
}

#[tauri::command]
pub async fn get_app_icons(requests: Vec<IconRequest>, refresh: Option<bool>, state: tauri::State<'_, IconCache>) -> HashMap<String, Option<String>> {
    let mut result: HashMap<String, Option<String>> = requests.iter().map(|r| (r.id.clone(), None)).collect();
    let cache = state.inner.clone();
    let (generation, missing) = {
        let mut inner = cache.lock().unwrap_or_else(|p| p.into_inner());
        if refresh.unwrap_or(false) { inner.clear(); }
        inner.prune();
        if requests.len() > MAX_BATCH { return result; }
        let mut missing = Vec::new();
        for request in requests {
            if !request.valid() { continue; }
            if let Some(entry) = inner.entries.get(&request.key()) { result.insert(request.id, entry.icon.clone()); }
            else { missing.push(request); }
        }
        (inner.generation, missing)
    };
    if missing.is_empty() { return result; }
    let worker_requests = missing.clone();
    let extracted = tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_string(&serde_json::json!({ "requests": worker_requests })).ok()
            .and_then(|input| super::powershell_input(include_str!("../scripts/app-icons.ps1"), None, Some(&input)).ok())
            .and_then(|output| serde_json::from_str::<HashMap<String, Option<String>>>(&output).ok()).unwrap_or_default()
    }).await.unwrap_or_default();
    let mut inner = cache.lock().unwrap_or_else(|p| p.into_inner());
    for request in missing {
        let icon = extracted.get(&request.id).cloned().flatten().filter(|value| valid_png(value));
        if inner.generation == generation { inner.insert(request.key(), icon.clone()); }
        result.insert(request.id, icon);
    }
    result
}
#[cfg(test)]
mod tests {
 use super::*;
 fn key(label: &str) -> IconKey { IconKey { path: format!(r"C:\apps\{label}.exe"), shortcut: None } }
 fn png_header(width: u32, height: u32) -> Vec<u8> {
  let mut bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
  bytes.extend_from_slice(&width.to_be_bytes()); bytes.extend_from_slice(&height.to_be_bytes());
  bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]); bytes
 }
 fn data_url(bytes: &[u8]) -> String { format!("data:image/png;base64,{}", STANDARD.encode(bytes)) }
 #[test]
 fn only_absolute_local_drive_paths_pass_input_boundary() {
  assert!(local_drive_path(r"C:\apps\Sample.exe")); assert!(local_drive_path("D:/Apps/App.exe"));
  for value in [r"\\server\share\App.exe", r"\\?\C:\App.exe", r"C:App.exe", "App.exe", "https://host/App.exe", r"C:\App.exe:stream.exe", "C:\\App\n.exe"] { assert!(!local_drive_path(value), "{value:?}"); }
  assert!(!local_drive_path(&format!("C:/{}", "x".repeat(32768))));
 }
 #[test]
 fn refresh_invalidates_even_an_empty_cache() {
  let mut cache = CacheInner::default(); cache.clear(); assert_eq!(cache.generation, 1);
  cache.insert(key("app"), None); cache.clear(); assert!(cache.entries.is_empty()); assert_eq!(cache.generation, 2);
 }
 #[test]
 fn prune_expires_success_and_failure_independently() {
  let mut cache = CacheInner::default(); let base = Instant::now();
  for (name, icon) in [("success-old", Some("png".into())), ("failure-old", None), ("success-fresh", Some("png".into())), ("failure-fresh", None)] { cache.insert(key(name), icon); }
  for name in ["success-old", "failure-old"] { cache.entries.get_mut(&key(name)).unwrap().saved = base; }
  for name in ["success-fresh", "failure-fresh"] { cache.entries.get_mut(&key(name)).unwrap().saved = base + ICON_TTL; }
  cache.prune_at(base + FAILURE_TTL + Duration::from_secs(1)); assert_eq!(cache.entries.len(), 3);
  assert!(!cache.entries.contains_key(&key("failure-old"))); assert!(cache.entries.contains_key(&key("success-old")));
  cache.prune_at(base + ICON_TTL + Duration::from_secs(1)); assert_eq!(cache.entries.len(), 2);
  assert!(cache.entries.contains_key(&key("success-fresh"))); assert!(cache.entries.contains_key(&key("failure-fresh")));
 }
 #[test]
 fn cache_evicts_oldest_at_item_limit() {
  let mut cache = CacheInner::default(); for index in 0..=MAX_CACHE_ITEMS { cache.insert(key(&index.to_string()), None); }
  assert_eq!(cache.entries.len(), MAX_CACHE_ITEMS); assert!(!cache.entries.contains_key(&key("0"))); assert!(cache.entries.contains_key(&key(&MAX_CACHE_ITEMS.to_string())));
 }
 #[test]
 fn cache_obeys_byte_limit_and_replacement_does_not_double_count() {
  let mut cache = CacheInner::default(); let payload = "x".repeat(MAX_CACHE_BYTES / 8);
  for index in 0..9 { cache.insert(key(&index.to_string()), Some(payload.clone())); }
  let size: usize = cache.entries.values().map(|v| v.icon.as_ref().map_or(0, String::len)).sum();
  assert!(size <= MAX_CACHE_BYTES); assert_eq!(cache.entries.len(), 8); assert!(!cache.entries.contains_key(&key("0")));
  cache.insert(key("8"), None); let size: usize = cache.entries.values().map(|v| v.icon.as_ref().map_or(0, String::len)).sum();
  assert_eq!(size, payload.len() * 7); assert_eq!(cache.entries.len(), 8);
 }
 #[test]
 fn png_contract_requires_bounded_64_square_png() {
  assert!(valid_png(&data_url(&png_header(64, 64))));
  assert!(!valid_png(&data_url(&png_header(32, 64)))); assert!(!valid_png(&data_url(&png_header(64, 128))));
  let mut wrong = png_header(64, 64); wrong[0] = 0; assert!(!valid_png(&data_url(&wrong)));
  let mut huge = png_header(64, 64); huge.resize(MAX_PNG_BYTES + 1, 0); assert!(!valid_png(&data_url(&huge)));
  assert!(!valid_png("data:image/png;base64,invalid!")); assert!(!valid_png("https://example.com/app.png")); assert!(!valid_png("data:image/svg+xml;base64,PHN2Zy8+"));
 }
}
