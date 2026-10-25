//! ES DSL Studio 桌面版（Tauri v2）
//!
//! 与 Python 版 server.py 的对应关系：
//!   - 静态资源：server.py 的 _serve_static   → proto.rs（esdsl:// 自定义协议 + asset resolver）
//!   - /api 路由：server.py 的 _dispatch      → api.rs
//!   - ES 代理  ：server.py 的 es_request     → es.rs（reqwest blocking + rustls TLS，跨平台免 OpenSSL）
//!   - 数据源库 ：server.py 的 sources.json   → store.rs（~/.es-dsl-studio/sources.json）
//!
//! 前端 fetch('/api/...') 全部走 esdsl://localhost，无需改动 web/ 下任何代码。

mod api;
mod es;
mod proto;
mod selftest;
mod store;

use tauri::Manager;

/// 调试桥：JS 里 `__TAURI_INTERNALS__.invoke('probe_result', obj)` 把结果送回这里。
#[tauri::command]
fn probe_result(payload: serde_json::Value) {
    println!("PROBE {}", serde_json::to_string(&payload).unwrap_or_default());
    use std::io::Write;
    let _ = std::io::stdout().flush();
    std::process::exit(0);
}

// ---- 调试桥截图：历史实现为 Windows WebView2 CapturePreview ----
// 曾按平台区分：Windows 用 webview2-com/windows crate 调 CapturePreview，
// 其他平台为同签名桩。该调试桥仅服务于 --eval 截图自动化（前端零引用），
// 但 Windows 专属依赖多次拖垮跨平台发布构建，且截图验证已改用外部
// screencapture 完成，故统一收敛为跨平台桩：调用返回明确错误提示。
mod capture {
    #[tauri::command]
    pub fn capture_preview_start(_app: tauri::AppHandle) -> Result<String, String> {
        Err("页面截图调试桥已下线（跨平台发布构建不需要 WebView2 依赖），请改用外部截图工具".into())
    }

    #[tauri::command]
    pub fn capture_preview_poll() -> u64 {
        0
    }

    #[tauri::command]
    pub fn capture_preview_save(_path: String) -> Result<usize, String> {
        Err("页面截图调试桥已下线（跨平台发布构建不需要 WebView2 依赖），请改用外部截图工具".into())
    }
}

/// tauri::generate_context!() 在 macOS 会嵌入 Info.plist（生成 #[no_mangle] 静态符号），
/// 同一个 crate 里多次展开会报 "symbol `_EMBED_INFO_PLIST` is already defined"。
/// 因此只在这里展开一次，run() 与 run_eval() 共用。
fn app_context() -> tauri::Context {
    tauri::generate_context!()
}

pub fn run() {
    tauri::Builder::default()
        .register_uri_scheme_protocol("esdsl", proto::handler)
        .setup(|_app| {
            migrate_if_needed();
            Ok(())
        })
        .run(app_context())
        .expect("error while running es-dsl-studio");
}

/// 调试桥：启动窗口后执行一段 JS 并回传结果（无头自动化验证用）。
/// 约定：JS 结尾 `__TAURI_INTERNALS__.invoke('probe_result', obj)` 回传，
/// Rust 收到后打印 `PROBE <json>` 并退出。
///
/// 注意：必须等页面（esdsl://）加载完再 eval——setup 里同步 eval 会打进
/// 空白的 about:blank 上下文，页面一导航脚本就丢了。
pub fn run_eval(js: String) {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            probe_result,
            capture::capture_preview_start,
            capture::capture_preview_poll,
            capture::capture_preview_save
        ])
        .register_uri_scheme_protocol("esdsl", proto::handler)
        .setup(move |app| {
            migrate_if_needed();
            if let Some(win) = app.get_webview_window("main") {
                // esdsl:// 本地资源加载很快，稍等片刻再注入
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(4000));
                    if let Err(e) = win.eval(&js) {
                        eprintln!("[esdsl] eval 注入失败：{e}");
                    }
                });
            }
            // 兜底超时：JS 一直没回传就退出（ESDSL_EVAL_TIMEOUT_MS 可调，截图等场景可设长一点）
            let timeout_ms: u64 = std::env::var("ESDSL_EVAL_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(30_000);
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(timeout_ms));
                eprintln!("[esdsl] eval 超时：页面未回传 PROBE 结果");
                std::process::exit(3);
            });
            Ok(())
        })
        .run(app_context())
        .expect("error while running es-dsl-studio (eval mode)");
}

/// 供 main.rs 的 --selftest 使用
pub fn selftest_main() -> i32 {
    selftest::run()
}

fn migrate_if_needed() {
    // 便携/历史场景：exe 同级/上级目录或项目目录里遗留的 data/sources.json 首次导入
    if let Err(e) = store::Store::migrate_legacy(&store::default_dir()) {
        eprintln!("[esdsl] 迁移历史数据源失败：{e}");
    }
}
