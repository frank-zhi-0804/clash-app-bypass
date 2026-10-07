use std::{collections::BTreeSet, path::Path};

pub const BEGIN: &str = "// <clash-app-bypass:managed:v1>";
pub const END: &str = "// </clash-app-bypass:managed:v1>";
const WRAPPER: &str = include_str!("../../shared/managed-wrapper.js");

pub fn make_block(paths: &[String]) -> Result<String, String> {
    let mut rules = BTreeSet::new();
    for path in paths {
        if path.chars().any(|c| matches!(c, ',' | '\n' | '\r')) || !Path::new(path).is_absolute() || !path.to_lowercase().ends_with(".exe") {
            return Err(format!("程序路径不能生成有效规则：{path}"));
        }
        rules.insert(format!("PROCESS-PATH,{path},DIRECT"));
    }
    let json = serde_json::to_string(&rules).map_err(|e| e.to_string())?;
    Ok(format!("{BEGIN}\n{}\n{END}", WRAPPER.replace("__VERGE_DIRECT_RULES__", &json)))
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
}
