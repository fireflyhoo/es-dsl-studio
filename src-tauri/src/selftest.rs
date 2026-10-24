//! 自检模式：不弹窗口，直接跑 /api 路由全链路 + 真实 ES 请求。
//!
//! 用法：es-dsl-studio.exe --selftest
//! 用途：CI / 发布前验证 Rust 后端（协议路由 → 数据源 → ES 代理）是否工作。
//! 注意：indices / search 会真实访问数据源里配置的 ES 集群。

use serde_json::{json, Value};

use crate::api;
use crate::es;
use crate::store::Store;

pub fn run() -> i32 {
    let dir = app_data_dir();
    let store = Store::new(&dir);
    println!("== ES DSL Studio 自检 ==  数据目录：{}", dir.display());

    let mut pass = 0usize;
    let mut fail = 0usize;

    macro_rules! check {
        ($name:expr, $body:expr) => {{
            match $body {
                Ok(v) => {
                    pass += 1;
                    println!("PASS {} | {}", $name, brief(&v));
                }
                Err(e) => {
                    fail += 1;
                    println!("FAIL {} | {}", $name, e.message);
                }
            }
        }};
    }

    // 通过 api::handle 走完整 HTTP 层（含路由解析）
    macro_rules! call {
        ($method:expr, $path:expr, $body:expr) => {{
            let resp = api::handle(&store, $method, $path, "", &serde_json::to_vec(&$body).unwrap_or_default());
            let (parts, body) = resp.into_parts();
            let text = String::from_utf8_lossy(&body).to_string();
            let status = parts.status.as_u16();
            let parsed: Result<Value, _> = serde_json::from_str(&text);
            match (status, parsed) {
                (200..=299, Ok(v)) => Ok(v),
                (s, Ok(v)) => Err(es::ApiError {
                    status: s,
                    message: v.get("error").and_then(|e| e.as_str()).unwrap_or("未知错误").to_string(),
                }),
                (s, Err(e)) => Err(es::ApiError { status: s, message: format!("响应解析失败：{e}") }),
            }        }};
    }

    // 1. 健康检查
    check!("GET /api/health", call!("GET", "/api/health", json!({})));

    // 2. 数据源列表（脱敏）
    let sources = call!("GET", "/api/sources", json!({}));
    let list = match &sources {
        Ok(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    };
    check!("GET /api/sources", sources.as_ref().map(|_| json!({"count": list.len()})).map_err(|e| e.clone()));
    check!("响应不含密码字段", {
        if list.iter().all(|s| s.get("password").is_none()) {
            Ok(json!({"ok": true}))
        } else {
            Err(es::ApiError::internal("响应中出现了 password 字段"))
        }
    });

    if list.is_empty() {
        println!("SKIP 索引/查询：没有配置数据源");
    }
    for src in &list {
        let sid = src.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        let label = format!("[{}] {}", sid, src.get("name").and_then(|v| v.as_str()).unwrap_or(""));

        // 3. 测试连接
        check!(format!("POST {label}/test"), call!("POST", &format!("/api/sources/{sid}/test"), json!({})));

        // 4. 索引列表
        let indices = call!("GET", &format!("/api/sources/{sid}/indices"), json!({}));
        check!(format!("GET {label}/indices"), indices.as_ref().map(|v| json!({"count": v.as_array().map(|a| a.len()).unwrap_or(0)})).map_err(|e| e.clone()));

        // 5. 对第一个索引跑一次真实查询
        if let Ok(Value::Array(rows)) = &indices {
            if let Some(first) = rows.first() {
                let idx = first.get("index").and_then(|v| v.as_str()).unwrap_or_default();
                let q = json!({
                    "index": idx,
                    "body": {"size": 1, "track_total_hits": true, "query": {"match_all": {}}}
                });
                check!(format!("POST {label}/search ({idx})"), call!("POST", &format!("/api/sources/{sid}/search"), q));

                // 6. detail
                check!(format!("GET {label}/indices/{idx}/detail"), call!("GET", &format!("/api/sources/{sid}/indices/{idx}/detail"), json!({})));

                // 7. 索引名校验（非法名必须 400）
                let bad = api::handle(&store, "GET", &format!("/api/sources/{sid}/indices/a%2Fb/sample"), "", &[]);
                let (parts, _) = bad.into_parts();
                if parts.status == 400 {
                    pass += 1;
                    println!("PASS 非法索引名被拒绝（400）");
                } else {
                    fail += 1;
                    println!("FAIL 非法索引名应返回 400，实际 {}", parts.status);
                }
            }
        }
    }

    println!("\n===== 自检结果：{pass} 通过 / {fail} 失败 =====");
    if fail == 0 { 0 } else { 1 }
}

/// 与 Tauri 的 app_data_dir 计算保持一致：%APPDATA%\<identifier>
fn app_data_dir() -> std::path::PathBuf {
    let base = std::env::var("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("com.esdsl.studio")
}

fn brief(v: &Value) -> String {
    let s = serde_json::to_string(v).unwrap_or_default();
    s.chars().take(160).collect()
}
