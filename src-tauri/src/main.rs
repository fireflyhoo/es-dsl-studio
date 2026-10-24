#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // 自检模式：不弹窗口，直接验证后端链路（CI / 发布前用）
    if args.iter().any(|a| a == "--selftest" || a == "--self-test") {
        std::process::exit(es_dsl_studio_lib::selftest_main());
    }

    // 调试桥：启动窗口后执行一段 JS，结果经 probe_result command 回传后退出。
    // 例：es-dsl-studio.exe --eval "await __TAURI_INTERNALS__.invoke('probe_result', 1+1)"
    if let Some(i) = args.iter().position(|a| a == "--eval") {
        if let Some(js) = args.get(i + 1) {
            es_dsl_studio_lib::run_eval(js.clone());
            return;
        }
        eprintln!("--eval 需要一段 JS 参数");
        std::process::exit(2);
    }

    es_dsl_studio_lib::run()
}
