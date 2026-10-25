//! Elasticsearch 代理：把前端动作翻译成 ES 请求（reqwest blocking + SChannel TLS）。
//!
//! 与 server.py 的 route_es / route_search 行为对齐：
//!   - 凭据只存在 Rust 侧，浏览器永远拿不到
//!   - 错误信息汉化，返回 (status, message) 由 api.rs 组装成 {"error": ...}
//!   - _cat/indices 失败时退回 _alias；detail 的 settings/aliases 失败降级为 {}

use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::{Method};
use serde_json::{json, Value};

const ES_TIMEOUT_SECS: u64 = 15;

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
}

impl ApiError {
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self { status: 400, message: msg.into() }
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self { status: 404, message: msg.into() }
    }
    pub fn bad_gateway(msg: impl Into<String>) -> Self {
        Self { status: 502, message: msg.into() }
    }
    pub fn gateway_timeout(msg: impl Into<String>) -> Self {
        Self { status: 504, message: msg.into() }
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self { status: 500, message: msg.into() }
    }
}

pub type EsResult = Result<Option<Value>, ApiError>;

// ---------------------------------------------------------------------------
// HTTP 客户端缓存：insecure 决定是否校验证书，分两种 client 复用连接池
// ---------------------------------------------------------------------------
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::OnceLock;

fn client_cache() -> &'static Mutex<HashMap<bool, Client>> {
    static CACHE: OnceLock<Mutex<HashMap<bool, Client>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn client(insecure: bool) -> Result<Client, ApiError> {
    let mut guard = client_cache().lock().unwrap();
    if let Some(c) = guard.get(&insecure) {
        return Ok(c.clone());
    }
    let c = Client::builder()
        .timeout(Duration::from_secs(ES_TIMEOUT_SECS))
        // 桌面版直连用户配置的 ES：不走系统代理（absolute-form 请求
        // 会打不开内网集群的 REST handler），与 Python urllib 行为一致
        .no_proxy()
        .danger_accept_invalid_certs(insecure)
        .build()
        .map_err(|e| ApiError::internal(format!("创建 HTTP 客户端失败：{e}")))?;
    guard.insert(insecure, c.clone());
    Ok(c)
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
fn str_field(src: &Value, key: &str) -> String {
    src.get(key).and_then(|v| v.as_str()).unwrap_or("").trim().to_string()
}

fn bool_field(src: &Value, key: &str) -> bool {
    src.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// 索引名合法性：不含 / ? #（与 server.py 的 SAFE_INDEX_RE 一致）
pub fn check_index_name(index: &str) -> Result<(), ApiError> {
    if index.is_empty() || index.contains(['/', '?', '#']) {
        return Err(ApiError::bad_request("非法索引名"));
    }
    Ok(())
}

/// 别名合法性：小写字母/数字开头，只含小写字母、数字与 _ - .
/// （与 server.py 的 SAFE_ALIAS_RE 一致）
pub fn check_alias_name(alias: &str) -> Result<(), ApiError> {
    let first_ok = alias
        .chars()
        .next()
        .map(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .unwrap_or(false);
    let rest_ok = alias
        .chars()
        .skip(1)
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-' | '.'));
    if !first_ok || !rest_ok {
        return Err(ApiError::bad_request(
            "非法别名：只能用小写字母 / 数字 / _ - .，且须以字母或数字开头",
        ));
    }
    Ok(())
}

/// 文档 ID 合法性：URL 路径安全子集，长度 1-512（与 server.py 的 SAFE_DOC_ID_RE 一致）
pub fn check_doc_id(doc_id: &str) -> Result<(), ApiError> {
    let ok = !doc_id.is_empty()
        && doc_id.len() <= 512
        && doc_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '@' | ':' | '+'));
    if !ok {
        return Err(ApiError::bad_request(
            "非法文档 ID：只能用字母 / 数字 / _ - . @ : +，长度 1-512",
        ));
    }
    Ok(())
}

// 路径段 percent 编码字符集（对应 Python urllib.parse.quote 的 safe 参数）：
// 协议层传来的路径段已被解码，拼回 ES URL 前需要重新编码。
// 索引/多索引保留 * , - . _ ~；文档 ID 与别名只保留 - . _ ~。
const ENC_PATH: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'*')
    .remove(b',')
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');
const ENC_DOC_ID: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// 索引名编码（Python: quote(index, safe="*,-._")）
fn enc_index(index: &str) -> String {
    percent_encoding::utf8_percent_encode(index, ENC_PATH).to_string()
}

fn parse_error_detail(raw: &str) -> String {
    if let Ok(j) = serde_json::from_str::<Value>(raw) {
        if let Some(err) = j.get("error") {
            if let Some(o) = err.as_object() {
                let d = o
                    .get("reason")
                    .or_else(|| o.get("type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !d.is_empty() {
                    return d.to_string();
                }
            } else if let Some(s) = err.as_str() {
                return s.to_string();
            }
        }
    }
    raw.chars().take(200).collect()
}

fn map_reqwest_err(e: reqwest::Error, base: &str) -> ApiError {
    if e.is_timeout() {
        return ApiError::gateway_timeout(format!("连接 Elasticsearch 超时（{ES_TIMEOUT_SECS}s）"));
    }
    let s = e.to_string().to_lowercase();
    if e.is_connect() || s.contains("tcp connect") || s.contains("connection refused") {
        return ApiError::bad_gateway(format!(
            "连接被拒绝：{base} 没有服务在监听，请确认 ES 地址与端口"
        ));
    }
    ApiError::bad_gateway(format!("无法连接 Elasticsearch：{e}。请检查地址、网络连通性与 HTTPS 证书。"))
}

// ---------------------------------------------------------------------------
// 单次 ES 请求
// ---------------------------------------------------------------------------
pub fn es_request(src: &Value, path: &str, method: &str, body: Option<&Value>) -> EsResult {
    let base = str_field(src, "url");
    let base = base.trim_end_matches('/');
    if base.is_empty() {
        return Err(ApiError::bad_request("数据源未配置地址"));
    }
    let url = format!("{base}{path}");

    let m = Method::from_bytes(method.to_ascii_uppercase().as_bytes()).unwrap_or(Method::GET);
    let client = client(bool_field(src, "insecure"))?;
    let mut req = client.request(m, &url);

    match str_field(src, "authType").as_str() {
        "basic" => {
            req = req.basic_auth(str_field(src, "username"), Some(str_field(src, "password")));
        }
        "apikey" => {
            let k = str_field(src, "apiKey");
            if !k.is_empty() {
                req = req.header("Authorization", format!("ApiKey {k}"));
            }
        }
        "bearer" => {
            let t = str_field(src, "token");
            if !t.is_empty() {
                req = req.header("Authorization", format!("Bearer {t}"));
            }
        }
        _ => {}
    }
    if let Some(b) = body {
        req = req.header("Content-Type", "application/json").json(b);
    }

    let resp = req.send().map_err(|e| map_reqwest_err(e, base))?;
    let status = resp.status();
    let text = resp
        .text()
        .map_err(|e| ApiError::bad_gateway(format!("读取 Elasticsearch 响应失败：{e}")))?;

    if !status.is_success() {
        let detail = parse_error_detail(&text);
        let code = status.as_u16();
        let reason = status.canonical_reason().unwrap_or("请求失败");
        return Err(ApiError {
            status: code,
            message: format!("Elasticsearch 返回 {code}：{}{}", if detail.is_empty() { reason.to_string() } else { detail }, ""),
        });
    }
    if text.trim().is_empty() {
        return Ok(None);
    }
    Ok(serde_json::from_str(&text).ok())
}

// ---------------------------------------------------------------------------
// 动作路由（与 server.py route_es 对齐）
// ---------------------------------------------------------------------------

/// 整数钳制（对应 Python 的 _clamp_int）
fn clamp_int(v: Option<&Value>, lo: i64, hi: i64, default: i64) -> i64 {
    let n = v
        .and_then(|x| x.as_i64())
        .or_else(|| v.and_then(|x| x.as_f64()).map(|f| f.trunc() as i64));
    match n {
        Some(n) => n.clamp(lo, hi),
        None => default,
    }
}

/// 写操作后立即 refresh，让数据表格下一秒就能查到新文档（ES 默认近实时）。
/// refresh 失败不阻塞主操作（集群可能禁用了 _refresh）。
fn es_refresh(src: &Value, enc: &str) {
    let _ = es_request(src, &format!("/{enc}/_refresh"), "POST", None);
}

pub fn route_es(
    src: &Value,
    action: &str,
    index: Option<&str>,
    query: Option<&str>,
    body: Option<&Value>,
    alias: Option<&str>,
    doc_id: Option<&str>,
) -> EsResult {
    match action {
        "test" => es_request(src, "/", "GET", None),

        "indices" => match es_request(
            src,
            "/_cat/indices?format=json&bytes=b&h=index,health,status,pri,rep,docs.count,store.size",
            "GET",
            None,
        ) {
            Ok(v) => Ok(v),
            Err(e) => {
                // 关闭了 _cat 或老版本：退回 _alias 获取索引名
                if e.status >= 500 {
                    return Err(e);
                }
                let alias_map = es_request(src, "/_alias", "GET", None).map_err(|e2| {
                    ApiError::bad_gateway(format!(
                        "获取索引列表失败（_cat/indices：{}；_alias：{}）",
                        e.message, e2.message
                    ))
                })?;
                match alias_map {
                    Some(Value::Object(m)) => Ok(Some(json!(m.keys().map(|k| json!({"index": k})).collect::<Vec<_>>()))),
                    _ => Ok(Some(json!([]))),
                }
            }
        },

        "detail" => {
            let enc = enc_index(index.unwrap_or_default());
            let mapping = es_request(src, &format!("/{enc}/_mapping"), "GET", None)?;
            let settings = es_request(src, &format!("/{enc}/_settings?include_defaults=false"), "GET", None)
                .unwrap_or(None);
            let aliases = es_request(src, &format!("/{enc}/_alias"), "GET", None).unwrap_or(None);
            Ok(Some(json!({
                "mapping": mapping,
                "settings": settings.unwrap_or(json!({})),
                "aliases": aliases.unwrap_or(json!({})),
            })))
        }

        "sample" => {
            let enc = enc_index(index.unwrap_or_default());
            let mut size = 10usize;
            if let Some(q) = query {
                for pair in q.split('&') {
                    let mut it = pair.splitn(2, '=');
                    if it.next() == Some("size") {
                        if let Some(v) = it.next() {
                            if let Ok(n) = v.parse::<usize>() {
                                size = n.clamp(1, 50);
                            }
                        }
                    }
                }
            }
            es_request(
                src,
                &format!("/{enc}/_search?size={size}&track_total_hits=true"),
                "GET",
                None,
            )
        }

        "delete" => {
            if bool_field(src, "readonly") {
                return Err(ApiError {
                    status: 403,
                    message: "该数据源处于只读模式，禁止删除索引".into(),
                });
            }
            let enc = enc_index(index.unwrap_or_default());
            es_request(src, &format!("/{enc}"), "DELETE", None)
        }

        "create" => {
            if bool_field(src, "readonly") {
                return Err(ApiError {
                    status: 403,
                    message: "该数据源处于只读模式，禁止创建索引".into(),
                });
            }
            let enc = enc_index(index.unwrap_or_default());
            es_request(src, &format!("/{enc}"), "PUT", body)
        }

        "put-mapping" => {
            if bool_field(src, "readonly") {
                return Err(ApiError {
                    status: 403,
                    message: "该数据源处于只读模式，禁止修改字段".into(),
                });
            }
            let ok = body
                .and_then(|b| b.as_object())
                .map(|m| !m.is_empty())
                .unwrap_or(false);
            if !ok {
                return Err(ApiError::bad_request("字段定义不能为空"));
            }
            let enc = enc_index(index.unwrap_or_default());
            es_request(src, &format!("/{enc}/_mapping"), "PUT", body)
        }

        "alias-add" => {
            if bool_field(src, "readonly") {
                return Err(ApiError {
                    status: 403,
                    message: "该数据源处于只读模式，禁止添加别名".into(),
                });
            }
            let a = alias.unwrap_or_default();
            check_alias_name(a)?;
            let b = match body {
                Some(b) if b.is_object() => b.clone(),
                _ => json!({}),
            };
            let enc = enc_index(index.unwrap_or_default());
            es_request(
                src,
                &format!("/{enc}/_alias/{}", percent_encoding::utf8_percent_encode(a, ENC_DOC_ID)),
                "PUT",
                Some(&b),
            )
        }

        "alias-remove" => {
            if bool_field(src, "readonly") {
                return Err(ApiError {
                    status: 403,
                    message: "该数据源处于只读模式，禁止删除别名".into(),
                });
            }
            let a = alias.unwrap_or_default();
            check_alias_name(a)?;
            let enc = enc_index(index.unwrap_or_default());
            es_request(
                src,
                &format!("/{enc}/_alias/{}", percent_encoding::utf8_percent_encode(a, ENC_DOC_ID)),
                "DELETE",
                None,
            )
        }

        // ---------- 文档 CRUD（数据表格） ----------
        "doc-query" => {
            let v = body.cloned().unwrap_or_else(|| json!({}));
            let size = clamp_int(v.get("size"), 1, 100, 20);
            let frm = clamp_int(v.get("from"), 0, 10000, 0);
            let mut payload = serde_json::Map::new();
            if let Some(q) = v.get("query").filter(|q| q.is_object()) {
                payload.insert("query".into(), q.clone());
            }
            if let Some(s) = v.get("sort").filter(|s| s.is_array()) {
                payload.insert("sort".into(), s.clone());
            }
            let enc = enc_index(index.unwrap_or_default());
            es_request(
                src,
                &format!("/{enc}/_search?track_total_hits=true&size={size}&from={frm}"),
                "POST",
                Some(&Value::Object(payload)),
            )
        }

        "doc-create" | "doc-replace" | "doc-delete" => {
            if bool_field(src, "readonly") {
                return Err(ApiError {
                    status: 403,
                    message: "该数据源处于只读模式，禁止写入文档".into(),
                });
            }
            let enc = enc_index(index.unwrap_or_default());
            if action == "doc-delete" {
                let did = doc_id.unwrap_or_default();
                check_doc_id(did)?;
                let res = es_request(
                    src,
                    &format!("/{enc}/_doc/{}", percent_encoding::utf8_percent_encode(did, ENC_DOC_ID)),
                    "DELETE",
                    None,
                );
                es_refresh(src, &enc);
                return res;
            }
            let doc = body
                .and_then(|b| b.get("doc"))
                .filter(|d| d.is_object())
                .filter(|d| !d.as_object().map(|m| m.is_empty()).unwrap_or(true));
            let doc = match doc {
                Some(d) => d,
                None => return Err(ApiError::bad_request("文档内容不能为空（至少包含一个字段）")),
            };
            if action == "doc-create" {
                let id_raw = body
                    .and_then(|b| b.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                let res = if id_raw.is_empty() {
                    es_request(src, &format!("/{enc}/_doc"), "POST", Some(doc))
                } else {
                    let did = id_raw;
                    check_doc_id(did)?;
                    es_request(
                        src,
                        &format!("/{enc}/_doc/{}", percent_encoding::utf8_percent_encode(did, ENC_DOC_ID)),
                        "PUT",
                        Some(doc),
                    )
                };
                es_refresh(src, &enc);
                res
            } else {
                let did = doc_id.unwrap_or_default();
                check_doc_id(did)?;
                let res = es_request(
                    src,
                    &format!("/{enc}/_doc/{}", percent_encoding::utf8_percent_encode(did, ENC_DOC_ID)),
                    "PUT",
                    Some(doc),
                );
                es_refresh(src, &enc);
                res
            }
        }

        other => Err(ApiError::not_found(format!("未知操作：{other}"))),
    }
}

// ---------------------------------------------------------------------------
// 任意 _search 查询体
// ---------------------------------------------------------------------------
pub fn route_search(src: &Value, payload: &Value) -> EsResult {
    let raw_index = payload.get("index").and_then(|v| v.as_str()).unwrap_or("").trim();
    if raw_index.is_empty() {
        return Err(ApiError::bad_request("请指定索引（支持逗号分隔或 * 通配）"));
    }
    let parts: Vec<&str> = raw_index.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
    if parts.is_empty() || parts.len() > 20 {
        return Err(ApiError::bad_request("索引数量不合法（最多 20 个）"));
    }
    for p in &parts {
        check_index_name(p)?;
    }
    let enc = parts.iter().map(|p| enc_index(p)).collect::<Vec<_>>().join(",");

    let body = payload.get("body").ok_or_else(|| ApiError::bad_request("查询体必须是 JSON 对象"))?;
    if !body.is_object() {
        return Err(ApiError::bad_request("查询体必须是 JSON 对象"));
    }
    es_request(src, &format!("/{enc}/_search"), "POST", Some(body))
}

// ---------------------------------------------------------------------------
// 测试连接（保存前验证，不落库）
// ---------------------------------------------------------------------------
pub fn test_with_merged_secrets(payload: &Value, existing: Option<&Value>) -> EsResult {
    let mut src = payload.clone();
    if let (Value::Object(ref mut m), Some(e)) = (&mut src, existing) {
        let sid = m.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
        if !sid.is_empty() {
            for k in ["password", "apiKey", "token"] {
                let empty = m.get(k).and_then(|v| v.as_str()).map(|s| s.trim().is_empty()).unwrap_or(true);
                if empty {
                    if let Some(v) = e.get(k) {
                        m.insert(k.into(), v.clone());
                    }
                }
            }
        }
    }
    es_request(&src, "/", "GET", None)
}
