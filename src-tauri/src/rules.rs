use std::{collections::BTreeSet, path::Path};

pub const BEGIN: &str = "// <clash-app-bypass:managed:v1>";
pub const END: &str = "// </clash-app-bypass:managed:v1>";
const WRAPPER: &str = include_str!("../../shared/managed-wrapper.js");

pub fn make_block(paths: &[String], mode: &str, proxy_group: &str) -> Result<String, String> {
    make_block_with_websites(paths, &[], mode, proxy_group)
}

pub fn make_block_with_websites(paths: &[String], websites: &[String], mode: &str, proxy_group: &str) -> Result<String, String> {
    if mode != "proxy" && mode != "subscription" { return Err("其他流量模式无效".into()); }
    if mode == "proxy" && (proxy_group.trim().is_empty() || proxy_group.chars().any(|c| matches!(c, ',' | '\n' | '\r')) || ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"].contains(&proxy_group.to_uppercase().as_str())) {
        return Err("请选择有效的代理组，不能选择 DIRECT 或 REJECT".into());
    }
    let mut rules = BTreeSet::new();
    for path in paths {
        if path.chars().any(|c| matches!(c, ',' | '\n' | '\r')) || !Path::new(path).is_absolute() || !path.to_lowercase().ends_with(".exe") {
            return Err(format!("程序路径不能生成有效规则：{path}"));
        }
        rules.insert(format!("PROCESS-PATH,{path},DIRECT"));
    }
    let mut ordered: Vec<String> = rules.into_iter().collect();
    for domain in crate::websites::validate_saved(websites)? {
        ordered.push(format!("DOMAIN-SUFFIX,{domain},DIRECT"));
    }
    let json = serde_json::to_string(&ordered).map_err(|e| e.to_string())?;
    let routing = serde_json::json!({ "mode": mode, "proxyGroup": proxy_group });
    Ok(format!("{BEGIN}\n{}\n{END}", WRAPPER.replace("__VERGE_DIRECT_RULES__", &json).replace("__VERGE_DIRECT_ROUTING__", &routing.to_string())))
}

pub fn split_managed(source: &str) -> Result<(String, Option<String>), String> {
    let begins: Vec<_> = source.match_indices(BEGIN).map(|(i, _)| i).collect();
    let ends: Vec<_> = source.match_indices(END).map(|(i, _)| i).collect();
    if begins.is_empty() && ends.is_empty() { return Ok((source.into(), None)); }
    if begins.len() != 1 || ends.len() != 1 || begins[0] >= ends[0] { return Err("本工具规则标记不完整或重复，请先检查原脚本".into()); }
    let end = ends[0] + END.len();
    // A generated section is always appended. Never remove a marker inside arbitrary source.
    if !source[end..].trim().is_empty() { return Err("规则段后出现其他脚本，请先检查是否被外部修改".into()); }
    Ok((source[..begins[0]].into(), Some(source[begins[0]..end].into())))
}

pub fn compose(original: &str, block: &str) -> Result<String, String> {
    let (base, _) = split_managed(original)?;
    let declarations = regex::Regex::new(r"(?m)\b(?:const|let|var)\s+main\s*=").unwrap();
    let main_fn = regex::Regex::new(r"(?m)\bfunction\s+main\s*\(").unwrap();
    if declarations.is_match(&base) || !main_fn.is_match(&base) {
        return Err("原扩展脚本必须使用 function main(...) 入口。第一版不自动改写其他入口形式".into());
    }
    Ok(format!("{base}\n{block}\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn validates_routing_and_keeps_proxy_mode_without_apps() {
        assert!(make_block(&[], "proxy", "GLOBAL").unwrap().contains("GLOBAL"));
        assert!(make_block(&[], "proxy", "DIRECT").is_err());
        assert!(make_block(&[], "proxy", "bad,group").is_err());
        assert!(make_block(&[], "unknown", "GLOBAL").is_err());
        assert!(make_block(&[], "subscription", "").is_ok());
    }
    #[test] fn removes_only_owned_tail() {
        let block = format!("{BEGIN}\nhello\n{END}");
        let input = format!("function main(c) {{ return c; }}\n{block}\n");
        let (base, found) = split_managed(&input).unwrap();
        assert!(base.contains("return c")); assert_eq!(found.unwrap(), block);
    }
    #[test] fn rejects_broken_and_embedded_markers() {
        assert!(split_managed(BEGIN).is_err());
        assert!(split_managed(&format!("{BEGIN}\n{END}\nfunction other() {{}} ")).is_err());
    }
    #[test] fn refuses_immutable_main() { assert!(compose("const main = c => c;", "block").is_err()); }
    #[test] fn website_rules_follow_app_rules_and_keep_distinct_private_tenants() {
        let block = make_block_with_websites(&[r"C:\Apps\app.exe".into()], &["bob.github.io".into(), "example.com".into(), "alice.github.io".into(), "example.com".into()], "proxy", "GLOBAL").unwrap();
        let (direct, _) = crate::live::block_rules(&block).unwrap();
        assert_eq!(direct, vec![r"PROCESS-PATH,C:\Apps\app.exe,DIRECT", "DOMAIN-SUFFIX,alice.github.io,DIRECT", "DOMAIN-SUFFIX,bob.github.io,DIRECT", "DOMAIN-SUFFIX,example.com,DIRECT"]);
        assert!(make_block_with_websites(&[], &["github.io".into()], "proxy", "GLOBAL").is_err());
        assert!(make_block_with_websites(&[], &["news.example.com".into()], "subscription", "").is_err());
    }
}
