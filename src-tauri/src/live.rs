use crate::messages::UiMessage;
use serde::{Deserialize, Serialize};
use serde_yaml::Value;

#[derive(Clone, Deserialize, Serialize)]
pub struct ManagedRouting { pub mode: String, #[serde(rename = "proxyGroup")] pub proxy_group: String }
pub fn block_rules(block: &str) -> Result<(Vec<String>, ManagedRouting), UiMessage> {
    let assignment = |name: &str| -> Result<String, UiMessage> {
        let prefix = format!("    const {name} = ");
        block.lines().find_map(|line| line.strip_prefix(&prefix).and_then(|v| v.strip_suffix(';')).map(String::from))
            .ok_or(UiMessage::new("live.oldBlock"))
    };
    Ok((serde_json::from_str(&assignment("directRules")?).map_err(|e| UiMessage::detail("live.oldRulesFormat", e))?,
        serde_json::from_str(&assignment("routing")?).map_err(|e| UiMessage::detail("live.oldRoutingFormat", e))?))
}
pub fn plan(original: &str, previous: Option<&str>, next: Option<&str>) -> Result<(String, Vec<String>, Vec<String>), UiMessage> {
    let mut config: Value = serde_yaml::from_str(original).map_err(|e| UiMessage::detail("live.runtimeFormat", e))?;
    let old: Vec<String> = config.get("rules").and_then(Value::as_sequence).ok_or(UiMessage::new("live.rulesMissing"))?
        .iter().map(|v| v.as_str().map(String::from).ok_or(UiMessage::new("live.rulesFormat"))).collect::<Result<_, _>>()?;
    let mut base = old.clone();
    if let Some(block) = previous {
        let (owned, routing) = block_rules(block)?;
        if routing.mode == "proxy" {
            let mut expected = owned; expected.push(format!("MATCH,{}", routing.proxy_group));
            if old != expected { return Err(UiMessage::new("live.externalRules")); }
            if next.map(block_rules).transpose()?.map(|(_, r)| r.mode != "proxy").unwrap_or(true) {
                return Err(UiMessage::new("live.subscriptionRestart"));
            }
        } else {
            if !old.starts_with(&owned) { return Err(UiMessage::new("live.sectionMismatch")); }
            base = old[owned.len()..].to_vec();
        }
    }
    let rules = if let Some(block) = next {
        let (mut direct, routing) = block_rules(block)?;
        if routing.mode == "proxy" { direct.push(format!("MATCH,{}", routing.proxy_group)); }
        // Keep subscription rules even when they equal a managed rule. The owned
        // prefix can then be removed without deleting an original subscription rule.
        else { direct.extend(base); }
        direct
    } else { base };
    config["rules"] = serde_yaml::to_value(&rules).map_err(UiMessage::technical)?;
    config["find-process-mode"] = Value::String("always".into());
    config["mode"] = Value::String("rule".into());
    Ok((serde_yaml::to_string(&config).map_err(UiMessage::technical)?, old, rules))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::{make_block, make_block_with_websites};
    #[test] fn preserves_network_fields_and_refuses_external_changes() {
        let old = make_block(&[], "proxy", "GLOBAL").unwrap();
        let next = make_block(&[r"C:\Apps\app.exe".into()], "proxy", "GLOBAL").unwrap();
        let source = "mixed-port: 7897\ntun: {enable: true}\nrules: ['MATCH,GLOBAL']\n";
        let (payload, _, expected) = plan(source, Some(&old), Some(&next)).unwrap();
        let parsed: Value = serde_yaml::from_str(&payload).unwrap();
        assert_eq!(parsed["mixed-port"].as_u64(), Some(7897));
        assert_eq!(parsed["tun"]["enable"].as_bool(), Some(true));
        assert_eq!(expected.len(), 2);
        assert!(plan("rules: ['MATCH,DIRECT']", Some(&old), Some(&next)).is_err());
        assert!(plan(source, Some(&old), None).is_err());
    }
    #[test] fn subscription_update_and_removal_preserve_unowned_rules() {
        let old = make_block(&[], "subscription", "").unwrap();
        let next = make_block(&[r"C:\Apps\app.exe".into()], "subscription", "").unwrap();
        let (payload, _, _) = plan("rules: ['DOMAIN,example.com,DIRECT', 'MATCH,Proxy']", Some(&old), Some(&next)).unwrap();
        let (_, _, removed) = plan(&payload, Some(&next), None).unwrap();
        assert_eq!(removed, vec!["DOMAIN,example.com,DIRECT", "MATCH,Proxy"]);
    }
    #[test] fn subscription_rule_identical_to_managed_rule_survives_removal() {
        let next = make_block(&[r"C:\Apps\app.exe".into()], "subscription", "").unwrap();
        let original = r#"rules: ['PROCESS-PATH,C:\Apps\app.exe,DIRECT', 'MATCH,Proxy']"#;
        let (payload, before, inserted) = plan(original, None, Some(&next)).unwrap();
        assert_eq!(inserted.len(), before.len() + 1);
        assert_eq!(inserted[0], inserted[1]);
        let (_, _, removed) = plan(&payload, Some(&next), None).unwrap();
        assert_eq!(removed, before);
    }
    #[test] fn website_only_subscription_rules_preserve_original_duplicates_on_update_and_undo() {
        let old = make_block_with_websites(&[], &["example.com".into()], "subscription", "").unwrap();
        let next = make_block_with_websites(&[], &["alice.github.io".into()], "subscription", "").unwrap();
        let source = "rules: ['DOMAIN-SUFFIX,example.com,DIRECT', 'MATCH,Proxy']";
        let (payload, original, inserted) = plan(source, None, Some(&old)).unwrap();
        assert_eq!(inserted, vec!["DOMAIN-SUFFIX,example.com,DIRECT", "DOMAIN-SUFFIX,example.com,DIRECT", "MATCH,Proxy"]);
        let (updated, _, changed) = plan(&payload, Some(&old), Some(&next)).unwrap();
        assert_eq!(changed, vec!["DOMAIN-SUFFIX,alice.github.io,DIRECT", "DOMAIN-SUFFIX,example.com,DIRECT", "MATCH,Proxy"]);
        let (_, _, removed) = plan(&updated, Some(&next), None).unwrap();
        assert_eq!(removed, original);
    }
    #[test] fn old_app_only_blocks_upgrade_with_websites_before_proxy_fallback() {
        let previous = make_block(&[], "proxy", "GLOBAL").unwrap();
        let next = make_block_with_websites(&[r"C:\Apps\app.exe".into()], &["example.com".into()], "proxy", "GLOBAL").unwrap();
        let (_, _, written) = plan("rules: ['MATCH,GLOBAL']", Some(&previous), Some(&next)).unwrap();
        assert_eq!(written, vec![r"PROCESS-PATH,C:\Apps\app.exe,DIRECT", "DOMAIN-SUFFIX,example.com,DIRECT", "MATCH,GLOBAL"]);
    }
}
