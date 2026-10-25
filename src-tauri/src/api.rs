//! /api/* 路由分发 —— 与 server.py 的 _dispatch 对齐。
//!
//! 路径来自 esdsl:// 自定义协议，形态：
//!   GET    /api/health
//!   GET    /api/sources                    列表（剥离凭据）
//!   POST   /api/sources                    新增/更新
//!   DELETE /api/sources/<sid>              删除
//!   POST   /api/test                       保存前测试连接（不落库）
//!   POST   /api/sources/<sid>/test         测试已存数据源
//!   POST   /api/sources/<sid>/search       执行 _search
//!   GET    /api/sources/<sid>/indices      索引列表
//!   DELETE /api/sources/<sid>/indices/<i>  删除索引
//!   PUT    /api/sources/<sid>/indices/<i>  创建索引
//!   GET    /api/sources/<sid>/indices/<i>/detail
//!   GET    /api/sources/<sid>/indices/<i>/sample
//!   PUT    /api/sources/<sid>/indices/<i>/mapping      更新字段映射
//!   PUT    /api/sources/<sid>/indices/<i>/aliases/<a>  添加别名
//!   DELETE /api/sources/<sid>/indices/<i>/aliases/<a>  移除别名
//!   POST   /api/sources/<sid>/docs/<i>      数据表格查询（筛选/排序/分页）
//!   PUT    /api/sources/<sid>/docs/<i>      新增文档
//!   PUT    /api/sources/<sid>/docs/<i>/<d>  全量替换文档
//!   DELETE /api/sources/<sid>/docs/<i>/<d>  删除文档

use std::borrow::Cow;

use serde_json::{json, Value};
use tauri::http::{Response, StatusCode};

use crate::es;
use crate::store::Store;

pub use crate::es::ApiError;

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// WebView2 下 fetch 自定义协议受 CORS 约束，所有 /api 响应都放开来源。
const CORS: (&str, &str) = ("Access-Control-Allow-Origin", "*");
const CORS_HEADERS: (&str, &str) = ("Access-Control-Allow-Headers", "Content-Type, X-ESDSL-Token, Authorization");
const CORS_METHODS: (&str, &str) = ("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");

pub fn handle(store: &Store, method: &str, path: &str, query: &str, body: &[u8]) -> Response<Cow<'static, [u8]>> {
    // 预检（fetch 带 Content-Type: application/json 时会先 OPTIONS）
    if method == "OPTIONS" {
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(CORS.0, CORS.1)
            .header(CORS_HEADERS.0, CORS_HEADERS.1)
            .header(CORS_METHODS.0, CORS_METHODS.1)
            .body(Cow::Borrowed(&[] as &[u8]))
            .expect("build options response");
    }
    match route(store, method, path, query, body) {
        Ok(v) => json_response(200, &v),
        Err(e) => json_response(e.status, &json!({ "error": e.message })),
    }
}

fn route(store: &Store, method: &str, path: &str, query: &str, body: &[u8]) -> Result<Value, ApiError> {
    let segments: Vec<String> = path
        .split('/')
        .filter(|s| !s.is_empty())
        .map(percent_encoding::percent_decode_str)
        .map(|d| d.decode_utf8_lossy().to_string())
        .collect();

    if segments.first().map(String::as_str) != Some("api") {
        return Err(ApiError::not_found("接口不存在"));
    }

    // /api/health —— 无鉴权（桌面版本机运行，无 TOKEN 概念）
    if segments.len() == 2 && segments[1] == "health" {
        return Ok(json!({
            "ok": true,
            "service": "es-dsl-studio",
            "mode": "desktop",
            "authRequired": false,
            "version": VERSION,
        }));
    }

    // /api/test —— 保存前验证
    if segments.len() == 2 && segments[1] == "test" {
        if method != "POST" {
            return Err(ApiError::bad_request("Method Not Allowed"));
        }
        let payload = parse_body(body)?;
        let existing = payload
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(|sid| store.load().into_iter().find(|s| s.get("id").and_then(|v| v.as_str()) == Some(sid)));
        return es::test_with_merged_secrets(&payload, existing.as_ref()).map(|v| v.unwrap_or(json!({})));
    }

    if segments.len() < 2 || segments[1] != "sources" {
        return Err(ApiError::not_found("接口不存在"));
    }

    // /api/sources
    if segments.len() == 2 {
        return match method {
            "GET" => Ok(json!(store.load().iter().map(Store::public).collect::<Vec<_>>())),
            "POST" => store.upsert(&parse_body(body)?),
            _ => Err(ApiError::bad_request("Method Not Allowed")),
        };
    }

    let sid = segments[2].clone();

    // /api/sources/<sid>  DELETE
    if segments.len() == 3 {
        return match method {
            "DELETE" => store.remove(&sid),
            _ => Err(ApiError::bad_request("Method Not Allowed")),
        };
    }

    let sources = store.load();
    let src = Store::find(&sources, &sid)?;

    // /api/sources/<sid>/search
    if segments.len() == 4 && segments[3] == "search" {
        if method != "POST" {
            return Err(ApiError::bad_request("Method Not Allowed"));
        }
        return es::route_search(src, &parse_body(body)?).map(|v| v.unwrap_or(json!({})));
    }

    // /api/sources/<sid>/test
    if segments.len() == 4 && segments[3] == "test" {
        if method != "POST" {
            return Err(ApiError::bad_request("Method Not Allowed"));
        }
        return es::route_es(src, "test", None, None, None, None, None).map(|v| v.unwrap_or(json!({})));
    }

    // /api/sources/<sid>/indices
    if segments.len() == 4 && segments[3] == "indices" {
        return match method {
            "GET" => es::route_es(src, "indices", None, None, None, None, None).map(|v| v.unwrap_or(json!([]))),
            _ => Err(ApiError::bad_request("Method Not Allowed")),
        };
    }

    // 文档 CRUD：/api/sources/<sid>/docs/<index>[/<doc_id>]（数据表格）
    if segments.len() >= 5 && segments[3] == "docs" {
        let index = segments[4].clone();
        es::check_index_name(&index)?;
        return match (segments.len(), method) {
            (5, "POST") => es::route_es(src, "doc-query", Some(&index), None, Some(&parse_body(body)?), None, None)
                .map(|v| v.unwrap_or(json!({}))),
            (5, "PUT") => es::route_es(src, "doc-create", Some(&index), None, Some(&parse_body(body)?), None, None)
                .map(|v| v.unwrap_or(json!({}))),
            (6, "PUT") => {
                let doc_id = segments[5].clone();
                es::check_doc_id(&doc_id)?;
                es::route_es(src, "doc-replace", Some(&index), None, Some(&parse_body(body)?), None, Some(&doc_id))
                    .map(|v| v.unwrap_or(json!({})))
            }
            (6, "DELETE") => {
                let doc_id = segments[5].clone();
                es::check_doc_id(&doc_id)?;
                es::route_es(src, "doc-delete", Some(&index), None, None, None, Some(&doc_id))
                    .map(|v| v.unwrap_or(json!({})))
            }
            _ => Err(ApiError::not_found("接口或路径参数不合法")),
        };
    }

    // /api/sources/<sid>/indices/<index>[/detail|sample|mapping|aliases/<alias>]
    if segments.len() >= 5 && segments[3] == "indices" {
        let index = segments[4].clone();
        es::check_index_name(&index)?;
        return match (segments.len(), method) {
            (5, "DELETE") => es::route_es(src, "delete", Some(&index), None, None, None, None)
                .map(|v| v.unwrap_or(json!({}))),
            (5, "PUT") => es::route_es(src, "create", Some(&index), None, Some(&parse_body(body)?), None, None)
                .map(|v| v.unwrap_or(json!({}))),
            (6, "GET") if segments[5] == "detail" => {
                es::route_es(src, "detail", Some(&index), None, None, None, None).map(|v| v.unwrap_or(json!({})))
            }
            (6, "GET") if segments[5] == "sample" => {
                es::route_es(src, "sample", Some(&index), Some(query), None, None, None).map(|v| v.unwrap_or(json!({})))
            }
            (6, "PUT") if segments[5] == "mapping" => {
                es::route_es(src, "put-mapping", Some(&index), None, Some(&parse_body(body)?), None, None)
                    .map(|v| v.unwrap_or(json!({})))
            }
            (7, "PUT") if segments[5] == "aliases" => {
                let alias = segments[6].clone();
                es::check_alias_name(&alias)?;
                es::route_es(src, "alias-add", Some(&index), None, Some(&parse_body(body)?), Some(&alias), None)
                    .map(|v| v.unwrap_or(json!({})))
            }
            (7, "DELETE") if segments[5] == "aliases" => {
                let alias = segments[6].clone();
                es::check_alias_name(&alias)?;
                es::route_es(src, "alias-remove", Some(&index), None, None, None, Some(&alias))
                    .map(|v| v.unwrap_or(json!({})))
            }
            _ => Err(ApiError::not_found("接口或路径参数不合法")),
        };
    }

    Err(ApiError::not_found("接口不存在"))
}

fn parse_body(body: &[u8]) -> Result<Value, ApiError> {
    if body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(body).map_err(|_| ApiError::bad_request("请求体不是合法 JSON"))
}

fn json_response(status: u16, obj: &Value) -> Response<Cow<'static, [u8]>> {
    let body = serde_json::to_vec(obj)
        .unwrap_or_else(|_| serde_json::to_vec(&json!({"error": "序列化失败"})).unwrap_or_default());
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header("Content-Type", "application/json; charset=utf-8")
        .header(CORS.0, CORS.1)
        .header("Cache-Control", "no-store")
        .body(Cow::Owned(body))
        .expect("build json response")
}
