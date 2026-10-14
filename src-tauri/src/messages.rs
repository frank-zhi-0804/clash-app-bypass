use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, fmt, sync::OnceLock};

/// Stable language-independent IPC payload. Render in the frontend's current locale.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UiMessage {
    pub key: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub values: BTreeMap<String, Value>,
}
impl UiMessage {
    pub fn new(key: &str) -> Self { Self { key: format!("backend:{key}"), values: BTreeMap::new() } }
    pub fn with(mut self, name: &str, value: impl Into<Value>) -> Self { self.values.insert(name.into(), value.into()); self }
    pub fn detail(key: &str, detail: impl fmt::Display) -> Self { Self::new(key).with("detail", detail.to_string()) }
    pub fn technical(detail: impl fmt::Display) -> Self { Self::detail("technical", detail) }
    pub fn cause(key: &str, cause: Self) -> Self { Self::new(key).with("cause", serde_json::json!(cause)) }

    /// Only for legacy source/warnings fields: old binaries must still read settings.
    /// Visible UI always prefers descriptors; this never guesses a key from prose.
    pub fn legacy_text(&self) -> String {
        static CATALOG: OnceLock<BTreeMap<String, String>> = OnceLock::new();
        let catalog = CATALOG.get_or_init(|| serde_json::from_str(include_str!("../../src/locales/backend.zh-CN.json")).expect("valid bundled backend catalog"));
        let name = self.key.strip_prefix("backend:").unwrap_or(&self.key);
        let mut text = catalog.get(name).cloned().unwrap_or_else(|| self.key.clone());
        for (key, value) in &self.values {
            let replacement = value.as_str().map(String::from).unwrap_or_else(|| value.to_string());
            text = text.replace(&format!("{{{{{key}}}}}"), &replacement);
        }
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn descriptors_preserve_typed_values_and_nested_causes() {
        let cause = UiMessage::detail("technical", "access denied (os error 5)");
        let error = UiMessage::cause("recovery.restored", cause.clone());
        let json = serde_json::to_value(error).unwrap();
        assert_eq!(json["key"], "backend:recovery.restored");
        assert_eq!(json["values"]["cause"], serde_json::to_value(cause).unwrap());
        let count = UiMessage::new("scanner.helpersRemoved").with("count", 2_u64);
        assert_eq!(count.values["count"], 2);
        assert!(count.legacy_text().contains("2 个失效"));
    }
    #[test]
    fn backend_catalogs_have_identical_keys_and_interpolation_parameters() {
        let zh: BTreeMap<String, String> = serde_json::from_str(include_str!("../../src/locales/backend.zh-CN.json")).unwrap();
        let en: BTreeMap<String, String> = serde_json::from_str(include_str!("../../src/locales/backend.en.json")).unwrap();
        assert_eq!(zh.keys().collect::<Vec<_>>(), en.keys().collect::<Vec<_>>());
        let params = regex::Regex::new(r"\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}").unwrap();
        for (key, chinese) in &zh {
            let collect = |text: &str| params.captures_iter(text).map(|c| c[1].to_string()).collect::<std::collections::BTreeSet<_>>();
            assert_eq!(collect(chinese), collect(&en[key]), "parameter mismatch for {key}");
        }
    }
    #[test]
    fn every_runtime_backend_message_has_a_bundled_translation() {
        let catalog: BTreeMap<String, String> = serde_json::from_str(include_str!("../../src/locales/backend.zh-CN.json")).unwrap();
        let rust_keys = regex::Regex::new(r#"UiMessage::(?:new|detail|cause)\("([^"]+)""#).unwrap();
        for source in [include_str!("main.rs"), include_str!("rules.rs"), include_str!("live.rs"), include_str!("websites.rs")] {
            for found in rust_keys.captures_iter(source) { assert!(catalog.contains_key(&found[1]), "missing backend key {}", &found[1]); }
        }
        let script_keys = regex::Regex::new(r#"'(scanner\.[^']+)'"#).unwrap();
        for found in script_keys.captures_iter(include_str!("../scripts/scan.ps1")) {
            assert!(catalog.contains_key(&found[1]), "missing scanner key {}", &found[1]);
        }
    }

}
