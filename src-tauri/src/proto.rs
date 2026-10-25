//! esdsl:// 自定义协议处理器：
//!   /api/*  → api::handle（ES 代理 + 数据源 CRUD）
//!   其他     → 打包在 exe 内的前端静态资源（web/）
//!
//! 前端 fetch('/api/...') 因此零改动，origin 即 esdsl://localhost。
//! 注意：Tauri v2 的协议处理器按值接收 (UriSchemeContext, Request)。

use std::borrow::Cow;

use tauri::http::{Request, Response, StatusCode};

use crate::api;
use crate::store::{self, Store};

pub fn handler<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    req: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();

    if path.starts_with("/api/") {
        // OPTIONS 预检直接放行
        if req.method().as_str() == "OPTIONS" {
            return api::handle(&empty_store(), "OPTIONS", &path, &query, &[]);
        }
        return api::handle(&Store::new(store::default_dir()), req.method().as_str(), &path, &query, req.body());
    }

    // 目录访问归一到 index.html；前导 "/" 去掉后交给 asset resolver
    let rel = path.trim_start_matches('/').to_string();
    let asset_path = if rel.is_empty() { "index.html".to_string() } else { rel };
    // 去掉可能的查询串残留
    let asset_path = asset_path.split('?').next().unwrap_or(&asset_path).to_string();
    // 上跳路径 / 隐藏文件一律 404
    if asset_path.split('/').any(|seg| seg == ".." || seg.starts_with('.')) {
        return not_found();
    }

    match ctx.app_handle().asset_resolver().get(asset_path) {
        Some(asset) => Response::builder()
            .header("Content-Type", asset.mime_type)
            .header("Cache-Control", "no-cache")
            .header("Access-Control-Allow-Origin", "*")
            .body(Cow::Owned(asset.bytes))
            .unwrap_or_else(|_| not_found()),
        None => not_found(),
    }
}

/// 预检请求不需要存储，占位即可。
fn empty_store() -> Store {
    Store::new(std::env::temp_dir().join("es-dsl-studio-none"))
}

fn not_found() -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(Cow::Borrowed(&[] as &[u8]))
        .expect("build 404")
}
