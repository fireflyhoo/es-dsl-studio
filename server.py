#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ES DSL Studio - 服务端

零第三方依赖，只用 Python 3 标准库。
职责：
  1. 托管前端静态文件（同一个端口，避免跨域）
  2. 代理 Elasticsearch 请求，凭据只存在服务端，不下发浏览器
  3. 数据集源（多集群）的增删改查与持久化

用法：
  python3 server.py                          # http://127.0.0.1:8080
  PORT=8080 python3 server.py                 # 指定端口（云环境一般注入 PORT）
  ESDSL_TOKEN=mysecret python3 server.py      # 开启访问令牌（对外提供服务时务必设置）

安全建议：
  - 默认只监听 127.0.0.1。设置了 PORT 环境变量（云/容器）时监听 0.0.0.0。
  - 一旦对外监听，强烈建议同时设置 ESDSL_TOKEN，否则任何能访问该端口的人都能
    用你配置的 ES 凭据读写集群。
  - 数据源保存在 ~/.es-dsl-studio/sources.json（ESDSL_HOME 可覆盖），
    含明文凭据，请勿提交到代码仓库。
"""

import base64
import json
import mimetypes
import os
import re
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# 配置统一放用户主目录：~/.es-dsl-studio/sources.json
# （与桌面版 store.rs 的 default_dir 保持一致；ESDSL_HOME 可覆盖，便于便携/多环境）
DATA_DIR = os.environ.get("ESDSL_HOME") or os.path.join(os.path.expanduser("~"), ".es-dsl-studio")
DATA_DIR = os.path.abspath(os.path.expanduser(DATA_DIR))
SOURCES_FILE = os.path.join(DATA_DIR, "sources.json")
# 便携版历史位置：项目目录下的 data/sources.json，首次启动时导入到 DATA_DIR
LEGACY_SOURCES_FILE = os.path.join(BASE_DIR, "data", "sources.json")
# 纯前端资源统一放在 web/ 下（桌面版 frontendDist 也指向它）；
# 兼容旧布局：web/ 不存在时退回项目根。
STATIC_DIR = os.path.join(BASE_DIR, "web") if os.path.isdir(os.path.join(BASE_DIR, "web")) else BASE_DIR

TOKEN = (os.environ.get("ESDSL_TOKEN") or "").strip()
PORT_ENV = os.environ.get("PORT")
HOST = "0.0.0.0" if PORT_ENV else "127.0.0.1"
PORT = int(PORT_ENV or 8080)

ES_TIMEOUT = int(os.environ.get("ESDSL_ES_TIMEOUT") or 15)

_lock = threading.Lock()

SECRET_FIELDS = ("password", "apiKey", "token")

# 静态文件白名单：只对外提供前端资源。
# 服务端代码（*.py）、数据源凭据（data/）、测试与临时目录一律不暴露，
# 否则把本服务开到 0.0.0.0 时 data/sources.json 里的密码可被直接下载。
STATIC_EXTS = {
    ".html", ".htm", ".css", ".js", ".mjs", ".map",
    ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
    ".woff", ".woff2", ".ttf", ".eot",
}
STATIC_DENY_DIRS = {"data", "test", "tests", "node_modules", "docs", "vendor"}


# --------------------------------------------------------------------------
# 错误
# --------------------------------------------------------------------------
class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# --------------------------------------------------------------------------
# 数据源存储
# --------------------------------------------------------------------------
def _ensure_data_dir():
    os.makedirs(DATA_DIR, exist_ok=True)
    _migrate_legacy()


def _migrate_legacy():
    """首次启动把项目目录 data/sources.json 导入 ~/.es-dsl-studio/（只做一次）。"""
    if os.path.exists(SOURCES_FILE) or not os.path.exists(LEGACY_SOURCES_FILE):
        return
    try:
        with open(LEGACY_SOURCES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, list):
            return
        tmp = SOURCES_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, SOURCES_FILE)
        print("[esdsl] 已把历史数据源从 {} 导入到 {}".format(LEGACY_SOURCES_FILE, SOURCES_FILE), file=sys.stderr)
    except (OSError, ValueError):
        pass


def load_sources():
    _ensure_data_dir()
    if not os.path.exists(SOURCES_FILE):
        return []
    try:
        with open(SOURCES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def save_sources(sources):
    _ensure_data_dir()
    tmp = SOURCES_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(sources, f, ensure_ascii=False, indent=2)
    os.replace(tmp, SOURCES_FILE)
    try:
        os.chmod(SOURCES_FILE, 0o600)
    except OSError:
        pass


def public_source(src):
    """下发给浏览器的视图：绝不包含任何凭据。"""
    out = {k: v for k, v in src.items() if k not in SECRET_FIELDS}
    out["hasSecret"] = any(bool(src.get(k)) for k in SECRET_FIELDS)
    return out


def find_source(sid):
    for s in load_sources():
        if s.get("id") == sid:
            return s
    raise ApiError(404, "数据源不存在：" + sid)


def upsert_source(payload):
    if not isinstance(payload, dict):
        raise ApiError(400, "请求体必须是 JSON 对象")
    name = (payload.get("name") or "").strip()
    url = (payload.get("url") or "").strip()
    if not name:
        raise ApiError(400, "数据源名称不能为空")
    if not re.match(r"^https?://", url, re.I):
        raise ApiError(400, "地址需要以 http:// 或 https:// 开头")

    with _lock:
        sources = load_sources()
        sid = (payload.get("id") or "").strip()
        existing = next((s for s in sources if s.get("id") == sid), None) if sid else None

        clean = {
            "id": existing["id"] if existing else ("ds_" + uuid.uuid4().hex[:10]),
            "name": name,
            "url": url.rstrip("/"),
            "authType": payload.get("authType") or "none",
            "username": (payload.get("username") or "").strip(),
            "insecure": bool(payload.get("insecure")),
            "readonly": bool(payload.get("readonly")),
            "updatedAt": int(time.time() * 1000),
        }
        # 凭据：留空表示沿用原值
        for k in SECRET_FIELDS:
            val = payload.get(k)
            if isinstance(val, str) and val.strip():
                clean[k] = val.strip()
            elif existing and existing.get(k):
                clean[k] = existing[k]

        if existing:
            sources = [clean if s.get("id") == existing["id"] else s for s in sources]
        else:
            sources.append(clean)
        save_sources(sources)
        return public_source(clean)


def delete_source(sid):
    with _lock:
        sources = load_sources()
        rest = [s for s in sources if s.get("id") != sid]
        if len(rest) == len(sources):
            raise ApiError(404, "数据源不存在：" + sid)
        save_sources(rest)
    return {"ok": True}


# --------------------------------------------------------------------------
# Elasticsearch 代理
# --------------------------------------------------------------------------
def es_request(src, path, method="GET", body=None):
    base = (src.get("url") or "").rstrip("/")
    if not base:
        raise ApiError(400, "数据源未配置地址")
    url = base + path

    headers = {"Accept": "application/json"}
    auth = src.get("authType") or "none"
    if auth == "basic":
        raw = ("%s:%s" % (src.get("username", ""), src.get("password", ""))).encode("utf-8")
        headers["Authorization"] = "Basic " + base64.b64encode(raw).decode("ascii")
    elif auth == "apikey" and src.get("apiKey"):
        headers["Authorization"] = "ApiKey " + str(src["apiKey"]).strip()
    elif auth == "bearer" and src.get("token"):
        headers["Authorization"] = "Bearer " + str(src["token"]).strip()

    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    ctx = None
    if base.lower().startswith("https"):
        ctx = ssl.create_default_context()
        if src.get("insecure"):
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE

    try:
        with urllib.request.urlopen(req, timeout=ES_TIMEOUT, context=ctx) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        detail = ""
        try:
            j = json.loads(raw)
            err = j.get("error") if isinstance(j, dict) else None
            if isinstance(err, dict):
                # ES 7+ 的 4xx：error.reason 常是无信息量的 "all shards failed"，
                # 真正原因在 error.root_cause[0].reason
                rc = err.get("root_cause")
                if isinstance(rc, list) and rc and isinstance(rc[0], dict) and rc[0].get("reason"):
                    detail = rc[0]["reason"]
                else:
                    detail = err.get("reason") or err.get("type") or ""
            elif isinstance(err, str):
                detail = err
        except ValueError:
            detail = raw[:200]
        raise ApiError(e.code, "Elasticsearch 返回 %s：%s" % (e.code, detail or e.reason or "请求失败"))
    except urllib.error.URLError as e:
        reason = e.reason
        if isinstance(reason, ConnectionRefusedError):
            raise ApiError(502, "连接被拒绝：%s 没有服务在监听，请确认 ES 地址与端口" % base)
        raise ApiError(502, "无法连接 Elasticsearch：%s。请检查地址、网络连通性与 HTTPS 证书。" % (reason,))
    except ConnectionRefusedError:
        raise ApiError(502, "连接被拒绝：%s 没有服务在监听，请确认 ES 地址与端口" % base)
    except socket.timeout:
        raise ApiError(504, "连接 Elasticsearch 超时（%ss）" % ES_TIMEOUT)


SAFE_INDEX_RE = re.compile(r"^[^/?#]+$")


def check_index_name(index):
    if not index or not SAFE_INDEX_RE.match(index):
        raise ApiError(400, "非法索引名")
    return index


SAFE_ALIAS_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")


def check_alias_name(alias):
    """别名命名规则与索引一致：小写开头，可含数字、_、-、.，且不能与索引名冲突词相同。"""
    if not alias or not SAFE_ALIAS_RE.match(alias):
        raise ApiError(400, "非法别名：只能用小写字母 / 数字 / _ - .，且须以字母或数字开头")
    return alias


# 文档 ID：ES 允许较宽的字符集，这里收紧到 URL 路径安全子集，避免注入 / 路径穿越
SAFE_DOC_ID_RE = re.compile(r"^[A-Za-z0-9_\-\.@:+]{1,512}$")


def check_doc_id(doc_id):
    if not doc_id or not SAFE_DOC_ID_RE.match(doc_id):
        raise ApiError(400, "非法文档 ID：只能用字母 / 数字 / _ - . @ : +，长度 1-512")
    return doc_id


def es_refresh(src, enc):
    """写操作后立即 refresh，让数据表格下一秒就能查到新文档（ES 默认近实时）。"""
    try:
        es_request(src, "/%s/_refresh" % enc, method="POST")
    except ApiError:
        pass  # refresh 失败不阻塞主操作（集群可能禁用了 _refresh）


def _clamp_int(val, lo, hi, default):
    try:
        n = int(val)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def route_es(src, action, index=None, query=None, body=None, alias=None, doc_id=None):
    """把前端动作翻译成 ES 请求。"""
    enc = urllib.parse.quote(index, safe="*,-._") if index else ""

    if action == "test":
        return es_request(src, "/")

    if action == "indices":
        cols = "index,health,status,pri,rep,docs.count,store.size"
        try:
            return es_request(src, "/_cat/indices?format=json&bytes=b&h=" + cols)
        except ApiError as e:
            # 关闭了 _cat 或老版本：退回 _alias 获取索引名
            if e.status >= 500:
                raise
            alias_map = es_request(src, "/_alias")
            if isinstance(alias_map, dict):
                return [{"index": k} for k in alias_map.keys()]
            return []

    if action == "detail":
        mapping = es_request(src, "/%s/_mapping" % enc)
        try:
            settings = es_request(src, "/%s/_settings?include_defaults=false" % enc)
        except ApiError:
            settings = {}
        try:
            aliases = es_request(src, "/%s/_alias" % enc)
        except ApiError:
            aliases = {}
        return {"mapping": mapping, "settings": settings, "aliases": aliases}

    if action == "sample":
        size = 10
        if query and query.get("size"):
            try:
                size = max(1, min(50, int(query["size"][0])))
            except (ValueError, TypeError):
                size = 10
        return es_request(src, "/%s/_search?size=%d&track_total_hits=true" % (enc, size))

    if action == "delete":
        if src.get("readonly"):
            raise ApiError(403, "该数据源处于只读模式，禁止删除索引")
        return es_request(src, "/%s" % enc, method="DELETE")

    if action == "create":
        if src.get("readonly"):
            raise ApiError(403, "该数据源处于只读模式，禁止创建索引")
        return es_request(src, "/%s" % enc, method="PUT", body=body)

    if action == "put-mapping":
        if src.get("readonly"):
            raise ApiError(403, "该数据源处于只读模式，禁止修改字段")
        if not isinstance(body, dict) or not body:
            raise ApiError(400, "字段定义不能为空")
        return es_request(src, "/%s/_mapping" % enc, method="PUT", body=body)

    if action == "alias-add":
        if src.get("readonly"):
            raise ApiError(403, "该数据源处于只读模式，禁止添加别名")
        if not isinstance(body, dict):
            body = {}
        aenc = urllib.parse.quote(alias, safe="-._")
        return es_request(src, "/%s/_alias/%s" % (enc, aenc), method="PUT", body=body)

    if action == "alias-remove":
        if src.get("readonly"):
            raise ApiError(403, "该数据源处于只读模式，禁止删除别名")
        aenc = urllib.parse.quote(alias, safe="-._")
        return es_request(src, "/%s/_alias/%s" % (enc, aenc), method="DELETE")

    # ---------- 文档 CRUD（数据表格） ----------
    if action == "doc-query":
        body = body if isinstance(body, dict) else {}
        size = _clamp_int(body.get("size"), 1, 100, 20)
        frm = _clamp_int(body.get("from"), 0, 10000, 0)
        payload = {}
        if isinstance(body.get("query"), dict):
            payload["query"] = body["query"]
        if isinstance(body.get("sort"), list):
            payload["sort"] = body["sort"]
        return es_request(
            src,
            "/%s/_search?track_total_hits=true&size=%d&from=%d" % (enc, size, frm),
            method="POST",
            body=payload,
        )

    if action in ("doc-create", "doc-replace", "doc-delete"):
        if src.get("readonly"):
            raise ApiError(403, "该数据源处于只读模式，禁止写入文档")
        doc = body.get("doc") if isinstance(body, dict) else None

        if action == "doc-delete":
            did = check_doc_id(doc_id)
            res = es_request(src, "/%s/_doc/%s" % (enc, urllib.parse.quote(did, safe="")), method="DELETE")
            es_refresh(src, enc)
            return res

        if not isinstance(doc, dict) or not doc:
            raise ApiError(400, "文档内容不能为空（至少包含一个字段）")

        if action == "doc-create":
            did = (body.get("id") or "").strip() if isinstance(body, dict) else ""
            if did:
                did = check_doc_id(did)
                res = es_request(src, "/%s/_doc/%s" % (enc, urllib.parse.quote(did, safe="")), method="PUT", body=doc)
            else:
                res = es_request(src, "/%s/_doc" % enc, method="POST", body=doc)
            es_refresh(src, enc)
            return res

        did = check_doc_id(doc_id)
        res = es_request(src, "/%s/_doc/%s" % (enc, urllib.parse.quote(did, safe="")), method="PUT", body=doc)
        es_refresh(src, enc)
        return res

    raise ApiError(404, "未知操作：" + str(action))


def route_search(src, payload):
    """执行任意 _search 查询体。索引可逗号分隔或带通配符。"""
    payload = payload if isinstance(payload, dict) else {}
    raw_index = str(payload.get("index") or "").strip()
    if not raw_index:
        raise ApiError(400, "请指定索引（支持逗号分隔或 * 通配）")

    parts = [p.strip() for p in raw_index.split(",") if p.strip()]
    if not parts or len(parts) > 20:
        raise ApiError(400, "索引数量不合法（最多 20 个）")
    for p in parts:
        if not SAFE_INDEX_RE.match(p):
            raise ApiError(400, "非法索引名：" + p)
    enc = ",".join(urllib.parse.quote(p, safe="*,-._") for p in parts)

    body = payload.get("body")
    if not isinstance(body, dict):
        raise ApiError(400, "查询体必须是 JSON 对象")

    return es_request(src, "/%s/_search" % enc, method="POST", body=body)


# --------------------------------------------------------------------------
# HTTP 处理
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "ESDSLStudio/1.0"

    # ---------- 基础工具 ----------
    def _json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _err(self, e):
        if isinstance(e, ApiError):
            self._json(e.status, {"error": e.message})
        else:  # noqa: BLE001 - 兜底，避免把堆栈暴露给前端
            self._json(500, {"error": "服务端异常：%s" % e})

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            raise ApiError(400, "请求体不是合法 JSON")

    def _auth_ok(self):
        if not TOKEN:
            return True
        given = (self.headers.get("X-ESDSL-Token") or "").strip()
        if given == TOKEN:
            return True
        auth = self.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer ") and auth[7:].strip() == TOKEN:
            return True
        return False

    def log_message(self, fmt, *args):  # 精简日志
        sys.stdout.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    # ---------- 路由 ----------
    def _dispatch(self, method):
        parsed = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)

        if not path.startswith("/api/"):
            if method != "GET":
                self._json(405, {"error": "Method Not Allowed"})
                return
            self._serve_static(path)
            return

        if path == "/api/health":
            self._json(200, {
                "ok": True,
                "service": "es-dsl-studio",
                "authRequired": bool(TOKEN),
                "version": self.server_version,
            })
            return

        try:
            if not self._auth_ok():
                raise ApiError(401, "需要访问令牌（ESDSL_TOKEN）")

            # 测试连接：不落库，允许在保存前验证
            if path == "/api/test":
                if method != "POST":
                    raise ApiError(405, "Method Not Allowed")
                payload = self._read_json()
                src = dict(payload) if isinstance(payload, dict) else {}
                sid = (src.get("id") or "").strip()
                if sid:
                    try:
                        existing = find_source(sid)
                        for k in SECRET_FIELDS:
                            if not src.get(k) and existing.get(k):
                                src[k] = existing[k]
                    except ApiError:
                        pass
                self._json(200, route_es(src, "test"))
                return

            segments = [s for s in path.split("/") if s]  # api, sources, <id>, ...
            if segments[:2] != ["api", "sources"]:
                raise ApiError(404, "接口不存在")

            # /api/sources
            if len(segments) == 2:
                if method == "GET":
                    self._json(200, [public_source(s) for s in load_sources()])
                    return
                if method == "POST":
                    self._json(200, upsert_source(self._read_json()))
                    return
                raise ApiError(405, "Method Not Allowed")

            sid = segments[2]

            # /api/sources/<id>  -> DELETE
            if len(segments) == 3:
                if method == "DELETE":
                    self._json(200, delete_source(sid))
                    return
                raise ApiError(405, "Method Not Allowed")

            action = segments[3]
            src = find_source(sid)

            # 文档 CRUD：/api/sources/<id>/docs/<index>[/<doc_id>]
            if action == "docs":
                if len(segments) < 5:
                    raise ApiError(404, "接口或路径参数不合法")
                index = check_index_name(segments[4])
                if len(segments) == 5:
                    if method == "POST":
                        self._json(200, route_es(src, "doc-query", index, body=self._read_json()))
                        return
                    if method == "PUT":
                        self._json(200, route_es(src, "doc-create", index, body=self._read_json()))
                        return
                    raise ApiError(405, "Method Not Allowed")
                if len(segments) == 6:
                    doc_id = check_doc_id(segments[5])
                    if method == "PUT":
                        self._json(200, route_es(src, "doc-replace", index, body=self._read_json(), doc_id=doc_id))
                        return
                    if method == "DELETE":
                        self._json(200, route_es(src, "doc-delete", index, doc_id=doc_id))
                        return
                    raise ApiError(405, "Method Not Allowed")
                raise ApiError(404, "接口或路径参数不合法")

            if action == "search":
                if method != "POST":
                    raise ApiError(405, "Method Not Allowed")
                self._json(200, route_search(src, self._read_json()))
                return

            if action == "test" and method == "POST":
                self._json(200, route_es(src, "test"))
                return

            if action == "indices":
                if len(segments) == 4 and method == "GET":
                    self._json(200, route_es(src, "indices"))
                    return
                if len(segments) >= 5:
                    index = segments[4]
                    check_index_name(index)
                    if len(segments) == 5 and method == "DELETE":
                        self._json(200, route_es(src, "delete", index))
                        return
                    if len(segments) == 5 and method == "PUT":
                        self._json(200, route_es(src, "create", index, body=self._read_json()))
                        return
                    if len(segments) == 6:
                        sub = segments[5]
                        if sub == "detail" and method == "GET":
                            self._json(200, route_es(src, "detail", index))
                            return
                        if sub == "sample" and method == "GET":
                            self._json(200, route_es(src, "sample", index, query))
                            return
                        if sub == "mapping" and method == "PUT":
                            self._json(200, route_es(src, "put-mapping", index, body=self._read_json()))
                            return
                    if len(segments) == 7 and segments[5] == "aliases":
                        alias = check_alias_name(segments[6])
                        if method == "PUT":
                            self._json(200, route_es(src, "alias-add", index, body=self._read_json(), alias=alias))
                            return
                        if method == "DELETE":
                            self._json(200, route_es(src, "alias-remove", index, alias=alias))
                            return
                # 索引名里带 "/" 时路径段数会错位，按参数不合法处理更贴切
                raise ApiError(404, "接口或路径参数不合法")

            raise ApiError(404, "接口不存在")
        except ApiError as e:
            self._err(e)
        except Exception as e:  # noqa: BLE001
            self._err(e)

    # ---------- 静态文件 ----------
    def _serve_static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        rel = path.lstrip("/")
        parts = [p for p in rel.split("/") if p not in ("", ".")]
        # 隐藏文件/目录（.git/.verify/.env…）、上跳路径、非白名单目录一律 404
        if not parts or any(p.startswith(".") or ".." in p for p in parts):
            self._json(404, {"error": "Not Found"})
            return
        if parts[0].lower() in STATIC_DENY_DIRS:
            self._json(404, {"error": "Not Found"})
            return
        if os.path.splitext(parts[-1])[1].lower() not in STATIC_EXTS:
            self._json(404, {"error": "Not Found"})
            return

        target = os.path.normpath(os.path.join(STATIC_DIR, *parts))
        if not target.startswith(STATIC_DIR + os.sep):
            self._json(403, {"error": "Forbidden"})
            return
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.isfile(target):
            self._json(404, {"error": "Not Found"})
            return

        ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        with open(target, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "GET, POST, PUT, DELETE, OPTIONS")
        self.end_headers()


def main():
    _ensure_data_dir()
    port = PORT
    try:
        httpd = ThreadingHTTPServer((HOST, port), Handler)
    except OSError as e:
        sys.stderr.write("端口 %s 启动失败：%s\n" % (port, e))
        sys.exit(1)

    lines = [
        "ES DSL Studio",
        "  服务地址   http://%s:%d" % ("127.0.0.1" if HOST == "0.0.0.0" else HOST, port),
        "  数据源文件 %s" % SOURCES_FILE,
        "  访问令牌   %s" % ("已开启" if TOKEN else "未设置（仅建议本机使用）"),
    ]
    if HOST == "0.0.0.0" and not TOKEN:
        lines.append("  注意：正在监听所有网卡且未设置 ESDSL_TOKEN，同网段任何人都可使用本服务访问你配置的集群。")
    lines.append("  Ctrl+C 退出")
    # 重定向到日志文件时 stdout 是块缓冲，不 flush 就看不到启动信息
    sys.stdout.write("\n".join(lines) + "\n")
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        sys.stdout.write("\n已停止\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
