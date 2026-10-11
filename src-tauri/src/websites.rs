use std::collections::BTreeSet;
use serde::Serialize;
use url::{Host, Url};

#[derive(Debug, PartialEq, Serialize)]
pub struct NormalizedWebsite {
    pub host: String,
    pub domain: String,
}

pub fn normalize(input: &str) -> Result<NormalizedWebsite, String> {
    let input = input.trim();
    if input.is_empty() || input.chars().count() > 8192 {
        return Err("请输入网站域名或不超过 8192 字符的网址".into());
    }
    if input.chars().any(|c| c.is_control() || c.is_whitespace() || c == '\\') {
        return Err("网址不能包含空白、反斜杠或控制字符".into());
    }
    let explicit_scheme = input.split_once("://").map(|(scheme, _)| {
        let mut bytes = scheme.bytes();
        bytes.next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false)
            && bytes.all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'-' | b'.'))
    }).unwrap_or(false);
    let address = if input.starts_with("//") {
        format!("https:{input}")
    } else if explicit_scheme {
        input.to_string()
    } else {
        if input.starts_with('/') { return Err("请输入完整网址或网站域名".into()); }
        format!("https://{input}")
    };
    let parsed = Url::parse(&address).map_err(|_| "无法识别网址，请检查域名格式")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只支持 HTTP 或 HTTPS 网站".into());
    }
    let authority = address.split_once("://").map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or("")).unwrap_or("");
    if authority.is_empty() { return Err("请输入完整网址或网站域名".into()); }
    if !parsed.username().is_empty() || parsed.password().is_some() || authority.contains('@') {
        return Err("请移除网址中的用户名或密码后再添加".into());
    }
    let host = match parsed.host() {
        Some(Host::Domain(host)) => host.strip_suffix('.').unwrap_or(host).to_string(),
        _ => return Err("请使用网站域名，不能使用 IP 地址".into()),
    };
    if host.len() > 253 || host.split('.').any(|label| {
        label.is_empty() || label.len() > 63 || label.starts_with('-') || label.ends_with('-')
            || !label.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    }) {
        return Err("网站域名格式无效".into());
    }
    // The static PSL includes ICANN and PRIVATE entries. A hosting provider's
    // suffix is a tenant boundary, never a site-wide bypass target.
    let registered = psl::domain(host.as_bytes()).ok_or("请添加具体网站，不能添加公共域名后缀")?;
    if !registered.suffix().is_known() {
        return Err("无法确认此网站的公共后缀，请使用有效的互联网网站域名".into());
    }
    let domain = std::str::from_utf8(registered.trim().as_bytes()).map_err(|_| "网站域名格式无效")?.to_string();
    Ok(NormalizedWebsite { host, domain })
}

pub fn validate_saved(websites: &[String]) -> Result<Vec<String>, String> {
    if websites.len() > 200 { return Err("最多可添加 200 个网站".into()); }
    let mut domains = BTreeSet::new();
    for value in websites {
        let normalized = normalize(value)?;
        // Saved settings and direct apply calls must not expand a manually edited
        // subdomain or URL. Only the explicit normalization command expands input.
        if normalized.host != *value || normalized.domain != *value {
            return Err("网站清单必须是已整理的主域名，请通过添加网站重新整理".into());
        }
        domains.insert(value.clone());
    }
    Ok(domains.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn urls_domains_ports_and_idna_share_the_same_registered_scope() {
        for (input, host, domain) in [
            ("https://News.Example.COM/articles?q=one#two", "news.example.com", "example.com"),
            ("news.example.com:8443/articles", "news.example.com", "example.com"),
            ("news.example.com/search?next=https://other.com/path", "news.example.com", "example.com"),
            ("//news.example.com/articles", "news.example.com", "example.com"),
            ("https://news.example.com/a%20b?q=c%20d", "news.example.com", "example.com"),
            ("  WWW.Example.COM.  ", "www.example.com", "example.com"),
            ("https://a.b.example.co.uk/", "a.b.example.co.uk", "example.co.uk"),
            ("https://www.食狮.中国/文章", "www.xn--85x722f.xn--fiqs8s", "xn--85x722f.xn--fiqs8s"),
        ] {
            assert_eq!(normalize(input).unwrap(), NormalizedWebsite { host: host.into(), domain: domain.into() });
        }
    }
    #[test]
    fn private_suffixes_wildcards_and_exceptions_preserve_tenant_boundaries() {
        for (input, domain) in [
            ("https://docs.alice.github.io/page", "alice.github.io"),
            ("https://api.project.appspot.com/", "project.appspot.com"),
            ("https://a.b.ck/", "a.b.ck"),
            ("https://www.ck/", "www.ck"),
            ("https://www.city.kawasaki.jp/", "city.kawasaki.jp"),
        ] {
            assert_eq!(normalize(input).unwrap().domain, domain);
        }
        for suffix in ["com", "co.uk", "github.io", "appspot.com", "b.ck", "foo.kawasaki.jp"] {
            assert!(normalize(suffix).is_err(), "accepted public suffix: {suffix}");
        }
    }
    #[test]
    fn rejects_local_addresses_credentials_invalid_labels_and_rule_injection() {
        for input in [
            "", "localhost", "app.localhost", "example.invalid", "127.0.0.1", "127.1", "2130706433", "0x7f000001", "0177.0.0.1", "[::1]",
            "https://user:pass@example.com/", "https://@example.com/", "https:///@example.com/", "user@example.com", "ftp://example.com/", "mailto:user@example.com",
            "https://example.com/a b", "https://example.com/?q=a b", "example.com,DIRECT", "example.com\nMATCH,DIRECT", "exa\tmple.com", "https://example.com\\@other.com/", "*.example.com", "-bad.example.com", "bad-.example.com", "bad_name.example.com", "example..com", "example.com..", "/example.com",
        ] {
            assert!(normalize(input).is_err(), "accepted invalid website: {input:?}");
        }
        assert!(normalize(&format!("{}.com", "a".repeat(64))).is_err());
        assert!(normalize(&format!("https://example.com/{}", "a".repeat(8192))).is_err());
    }
    #[test]
    fn saved_roots_are_canonical_deduplicated_and_never_expanded_again() {
        assert_eq!(validate_saved(&["example.com".into(), "alice.github.io".into(), "example.com".into()]).unwrap(), vec!["alice.github.io", "example.com"]);
        for edited in ["news.example.com", "EXAMPLE.COM", "example.com.", "https://example.com/", "github.io"] {
            assert!(validate_saved(&[edited.into()]).is_err());
        }
        assert!(validate_saved(&vec!["example.com".into(); 201]).is_err());
    }
}
