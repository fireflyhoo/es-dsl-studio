//! ES DSL Studio 桌面版（Tauri v2）
//!
//! 与 Python 版 server.py 的对应关系：
//!   - 静态资源：server.py 的 _serve_static   → proto.rs（esdsl:// 自定义协议 + asset resolver）
//!   - /api 路由：server.py 的 _dispatch      → api.rs
//!   - ES 代理  ：server.py 的 es_request     → es.rs（reqwest blocking + SChannel TLS）
//!   - 数据源库 ：server.py 的 sources.json   → store.rs（app_data_dir/sources.json）
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

// ---- 调试桥截图：WebView2 CapturePreview ----
// PrintWindow/BitBlt 对 DirectComposition 渲染的 WebView2 拿不到正确帧
// （屏幕 150% 缩放下失真更明显），改用官方 CapturePreview 直接把页面渲成 PNG。
// 分三段式命令，避免阻塞主线程消息泵：
//   capture_preview_start  发起捕获（流存全局）
//   capture_preview_poll   轮询流字节数（>0 即捕获完成）
//   capture_preview_save   把流读出来落盘
struct SyncStream(std::sync::Mutex<Option<windows::Win32::System::Com::IStream>>);
// IStream 内部是 COM 指针（NonNull），默认 !Sync；这里手动担保跨线程访问安全
unsafe impl Sync for SyncStream {}
static PREVIEW_STREAM: SyncStream = SyncStream(std::sync::Mutex::new(None));

#[tauri::command]
fn capture_preview_start(app: tauri::AppHandle) -> Result<String, String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let result = std::sync::Arc::new(std::sync::Mutex::new(Ok("started".to_string())));
    let result_cb = result.clone();
    win.with_webview(move |w| {
        let r = (|| -> Result<String, String> {
            let controller = w.controller();
            let handler = webview2_com::CapturePreviewCompletedHandler::create(Box::new(
                |_r: windows::core::Result<()>| windows::core::Result::Ok(()),
            ));
            unsafe {
                let core = controller.CoreWebView2().map_err(|e| e.to_string())?;
                let stream = windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal(
                    windows::Win32::Foundation::HGLOBAL::default(),
                    true,
                )
                .map_err(|e| format!("CreateStreamOnHGlobal: {e}"))?;
                core.CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &stream,
                    &handler,
                )
                .map_err(|e| format!("CapturePreview: {e}"))?;
                *PREVIEW_STREAM.0.lock().unwrap() = Some(stream);
            }
            Ok("started".into())
        })();
        *result_cb.lock().unwrap() = r;
    })
    .map_err(|e| e.to_string())?;
    let r = result.lock().unwrap().clone();
    if let Err(ref e) = r {
        eprintln!("[esdsl] capture_preview_start: {e}");
    }
    r
}

#[tauri::command]
fn capture_preview_poll() -> u64 {
    let guard = PREVIEW_STREAM.0.lock().unwrap();
    match guard.as_ref() {
        Some(stream) => unsafe {
            let mut stat: windows::Win32::System::Com::STATSTG = std::mem::zeroed();
            if stream.Stat(&mut stat, windows::Win32::System::Com::STATFLAG_NONAME).is_ok() {
                stat.cbSize
            } else {
                0
            }
        },
        None => 0,
    }
}

#[tauri::command]
fn capture_preview_save(path: String) -> Result<usize, String> {
    let guard = PREVIEW_STREAM.0.lock().unwrap();
    let stream = guard.as_ref().ok_or_else(|| "capture not started".to_string())?;
    unsafe {
        stream
            .Seek(0, windows::Win32::System::Com::STREAM_SEEK_SET, None)
            .map_err(|e| e.to_string())?;
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = vec![0u8; 65536];
        loop {
            let mut read: u32 = 0;
            let hr = stream.Read(
                chunk.as_mut_ptr() as *mut _,
                chunk.len() as u32,
                Some(&mut read),
            );
            if hr.is_err() {
                return Err(format!("IStream::Read: {:?}", hr));
            }
            if read == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..read as usize]);
        }
        if buf.is_empty() {
            return Err("stream is empty".into());
        }
        std::fs::write(&path, &buf).map_err(|e| e.to_string())?;
        Ok(buf.len())
    }
}

pub fn run() {
    tauri::Builder::default()
        .register_uri_scheme_protocol("esdsl", proto::handler)
        .setup(|app| {
            migrate_if_needed(app);
            Ok(())
        })
        .run(tauri::generate_context!())
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
            capture_preview_start,
            capture_preview_poll,
            capture_preview_save
        ])
        .register_uri_scheme_protocol("esdsl", proto::handler)
        .setup(move |app| {
            migrate_if_needed(app);
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
        .run(tauri::generate_context!())
        .expect("error while running es-dsl-studio (eval mode)");
}

/// 供 main.rs 的 --selftest 使用
pub fn selftest_main() -> i32 {
    selftest::run()
}

fn migrate_if_needed<R: tauri::Runtime, M: Manager<R>>(app: &M) {
    // 便携场景：exe 同级/上级目录里遗留的 data/sources.json 首次导入
    if let Ok(dir) = app.path().app_data_dir() {
        if let Err(e) = store::Store::migrate_legacy(&dir) {
            eprintln!("[esdsl] 迁移历史数据源失败：{e}");
        }
    }
}
