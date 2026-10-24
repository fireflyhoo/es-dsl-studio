//! 数据源（多集群）存储：<data_dir>/sources.json
//!
//! 与 server.py 保持一致：
//!   - 凭据字段（password/apiKey/token）只落盘，不下发前端（hasSecret 标记）
//!   - upsert 时密钥留空表示沿用原值
//!   - 原子写入（tmp + rename）
//!
//! 桌面版 data_dir = app_data_dir（%APPDATA%\com.esdsl.studio）；
//! selftest 模式可直接传任意目录，不依赖 Tauri Runtime。

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::es;

pub const SECRET_FIELDS: [&str; 3] = ["password", "apiKey", "token"];

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn file(&self) -> PathBuf {
        self.dir.join("sources.json")
    }

    pub fn load(&self) -> Vec<Value> {
        match fs::read(self.file()) {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    }

    pub fn save(&self, sources: &[Value]) -> Result<(), String> {
        fs::create_dir_all(&self.dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
        let p = self.file();
        let tmp = p.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(sources).map_err(|e| e.to_string())?)
            .map_err(|e| format!("写入数据源文件失败：{e}"))?;
        fs::rename(&tmp, &p).map_err(|e| format!("替换数据源文件失败：{e}"))?;
        Ok(())
    }

    /// 下发给前端的视图：剥离全部凭据，只留 hasSecret 标记。
    pub fn public(src: &Value) -> Value {
        let mut out = src.clone();
        if let Value::Object(ref mut m) = out {
            for k in SECRET_FIELDS {
                m.remove(k);
            }
            let has = SECRET_FIELDS.iter().any(|k| {
                src.get(k)
                    .and_then(|v| v.as_str())
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false)
            });
            m.insert("hasSecret".into(), json!(has));
        }
        out
    }

    pub fn find<'a>(sources: &'a [Value], sid: &str) -> Result<&'a Value, es::ApiError> {
        sources
            .iter()
            .find(|s| s.get("id").and_then(|v| v.as_str()) == Some(sid))
            .ok_or_else(|| es::ApiError::not_found(format!("数据源不存在：{sid}")))
    }

    /// 新增 / 更新一个数据源（密钥留空沿用原值）。
    pub fn upsert(&self, payload: &Value) -> Result<Value, es::ApiError> {
        let obj = payload
            .as_object()
            .ok_or_else(|| es::ApiError::bad_request("请求体必须是 JSON 对象"))?;

        let name = obj.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let url = obj.get("url").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if name.is_empty() {
            return Err(es::ApiError::bad_request("数据源名称不能为空"));
        }
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(es::ApiError::bad_request("地址需要以 http:// 或 https:// 开头"));
        }

        let mut sources = self.load();
        let sid = obj.get("id").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let existing = if sid.is_empty() {
            None
        } else {
            sources.iter().find(|s| s.get("id").and_then(|v| v.as_str()) == Some(sid.as_str()))
        };

        let mut clean = serde_json::Map::new();
        clean.insert(
            "id".into(),
            json!(existing
                .and_then(|s| s.get("id"))
                .cloned()
                .unwrap_or_else(|| json!(format!("ds_{}", &random_hex(10))))),
        );
        clean.insert("name".into(), json!(name));
        clean.insert("url".into(), json!(url.trim_end_matches('/')));
        clean.insert(
            "authType".into(),
            json!(obj.get("authType").and_then(|v| v.as_str()).unwrap_or("none")),
        );
        clean.insert(
            "username".into(),
            json!(obj.get("username").and_then(|v| v.as_str()).unwrap_or("").trim()),
        );
        clean.insert(
            "insecure".into(),
            json!(obj.get("insecure").and_then(|v| v.as_bool()).unwrap_or(false)),
        );
        clean.insert(
            "readonly".into(),
            json!(obj.get("readonly").and_then(|v| v.as_bool()).unwrap_or(false)),
        );
        clean.insert("updatedAt".into(), json!(now_ms()));

        for k in SECRET_FIELDS {
            let val = obj.get(k).and_then(|v| v.as_str()).map(|s| s.trim()).unwrap_or("");
            if !val.is_empty() {
                clean.insert(k.into(), json!(val));
            } else if let Some(e) = existing {
                if let Some(v) = e.get(k) {
                    clean.insert(k.into(), v.clone());
                }
            }
        }

        let clean = Value::Object(clean);
        match existing.and_then(|s| s.get("id").and_then(|v| v.as_str())) {
            Some(id) => {
                sources = sources
                    .iter()
                    .map(|s| {
                        if s.get("id").and_then(|v| v.as_str()) == Some(id) { clean.clone() } else { s.clone() }
                    })
                    .collect();
            }
            None => sources.push(clean.clone()),
        }
        self.save(&sources).map_err(es::ApiError::internal)?;
        Ok(Self::public(&clean))
    }

    pub fn remove(&self, sid: &str) -> Result<Value, es::ApiError> {
        let sources = self.load();
        let rest: Vec<Value> = sources
            .iter()
            .filter(|s| s.get("id").and_then(|v| v.as_str()) != Some(sid))
            .cloned()
            .collect();
        if rest.len() == sources.len() {
            return Err(es::ApiError::not_found(format!("数据源不存在：{sid}")));
        }
        self.save(&rest).map_err(es::ApiError::internal)?;
        Ok(json!({ "ok": true }))
    }

    /// 便携场景迁移：exe 同级或上级目录存在 data/sources.json 且数据目录还没有时导入。
    pub fn migrate_legacy(dir: &Path) -> Result<(), String> {
        let dest = dir.join("sources.json");
        if dest.exists() {
            return Ok(());
        }
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            let mut d = exe.parent().map(Path::to_path_buf);
            // 覆盖 开发(target/debug) 与 便携(target/release) 场景，向上找 5 级
            for _ in 0..5 {
                if let Some(cur) = d.take() {
                    candidates.push(cur.join("data").join("sources.json"));
                    d = cur.parent().map(Path::to_path_buf);
                }
            }
        }
        for src in candidates {
            if src.is_file() {
                if let Ok(bytes) = fs::read(&src) {
                    if serde_json::from_slice::<Value>(&bytes).is_ok() {
                        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                        fs::copy(&src, &dest).map_err(|e| e.to_string())?;
                        eprintln!("[esdsl] 已从 {} 导入历史数据源", src.display());
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 随机十六进制串（与 server.py 的 ds_ + hex[:10] 观感一致）。
fn random_hex(n: usize) -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::with_capacity(n);
    while out.len() < n {
        let h = RandomState::new().build_hasher().finish();
        out.push_str(&format!("{h:x}"));
    }
    out.truncate(n);
    out
}
