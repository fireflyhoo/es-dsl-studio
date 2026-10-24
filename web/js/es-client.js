/* ============================================================
 * ES DSL Studio - Elasticsearch 访问层
 *
 * 两种运行模式，自动探测：
 *   server —— 由 server.py 托管，请求走 /api/*，凭据只存在服务端（推荐）
 *   direct —— 直接双击 index.html 打开，浏览器直连 ES（需 ES 开启 CORS）
 *
 * 本文件不做任何 DOM 操作，纯逻辑，可在 Node 中测试。
 * ============================================================ */
(function (global) {
  'use strict';

  const TOKEN_KEY = 'esdsl.token.v1';
  const LOCAL_KEY = 'esdsl.sources.v1';
  const AUTH_TYPES = ['none', 'basic', 'apikey', 'bearer'];

  let mode = 'direct';
  let token = '';

  /* ---------------- 错误对象 ---------------- */
  function ESError(message, kind, status, payload) {
    const e = new Error(message);
    e.name = 'ESError';
    e.kind = kind || 'unknown';
    e.status = status;
    e.payload = payload;
    return e;
  }

  function isCorsLike(err) {
    return !!err && err.kind === 'network' && /failed to fetch|networkerror|load failed/i.test(err.message || '');
  }

  /* ---------------- 基础工具 ---------------- */
  function trimUrl(u) {
    return String(u == null ? '' : u).trim().replace(/\/+$/, '');
  }

  function joinUrl(base, path) {
    const b = trimUrl(base);
    if (!path) return b;
    return b + (path.charAt(0) === '/' ? path : '/' + path);
  }

  function encIndex(name) {
    return encodeURIComponent(String(name));
  }

  // 别名路径段：别名同样不允许 / ? # 等字符，统一编码保证路径安全
  function encAlias(name) {
    return encodeURIComponent(String(name));
  }

  function b64(text) {
    if (typeof Buffer !== 'undefined') return Buffer.from(String(text), 'utf8').toString('base64');
    const bytes = new TextEncoder().encode(String(text));
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function authHeaders(src) {
    const h = {};
    const type = src && src.authType;
    if (type === 'basic') {
      h.Authorization = 'Basic ' + b64((src.username || '') + ':' + (src.password || ''));
    } else if (type === 'apikey' && src.apiKey) {
      h.Authorization = 'ApiKey ' + String(src.apiKey).trim();
    } else if (type === 'bearer' && src.token) {
      h.Authorization = 'Bearer ' + String(src.token).trim();
    }
    return h;
  }

  /* ---------------- 格式化 ---------------- */
  function formatBytes(n) {
    if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '—';
    let v = Number(n);
    if (v < 1024) return v + ' B';
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
    const fixed = v >= 100 ? 0 : v >= 10 ? 1 : 2;
    return v.toFixed(fixed) + ' ' + units[i];
  }

  function formatCount(n) {
    if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '—';
    const v = Number(n);
    if (v < 10000) return v.toLocaleString('en-US');
    if (v < 100000000) return (v / 10000).toFixed(v < 100000 ? 2 : 1) + ' 万';
    return (v / 100000000).toFixed(2) + ' 亿';
  }

  function hostOf(url) {
    try {
      const u = new URL(trimUrl(url));
      return u.host + (u.pathname && u.pathname !== '/' ? u.pathname : '');
    } catch (e) {
      return trimUrl(url);
    }
  }

  /* ---------------- 字段类型着色分组（索引管理与字段联想共用） ---------------- */
  const TYPE_GROUP = {
    text: 'text', match_only_text: 'text',
    keyword: 'kw', constant_keyword: 'kw', wildcard: 'kw',
    long: 'num', integer: 'num', short: 'num', byte: 'num', double: 'num',
    float: 'num', half_float: 'num', scaled_float: 'num', unsigned_long: 'num',
    date: 'date', date_nanos: 'date',
    boolean: 'bool',
    object: 'obj', nested: 'obj', flattened: 'obj', join: 'obj',
    geo_point: 'geo', geo_shape: 'geo', point: 'geo', shape: 'geo',
    dense_vector: 'vec', sparse_vector: 'vec', rank_feature: 'vec', rank_features: 'vec',
    completion: 'sp', search_as_you_type: 'sp', token_count: 'sp', percolator: 'sp',
    ip: 'kw', version: 'kw', binary: 'kw',
  };
  function typeGroup(t) { return TYPE_GROUP[t] || 'other'; }

  /* ---------------- mapping 扁平化 ---------------- */
  // 输入 _mapping 响应里的 mappings 节点，输出按层级排序的字段列表
  function flattenMapping(mappings) {
    let props = null;
    if (mappings && typeof mappings === 'object') {
      if (mappings.properties) {
        props = mappings.properties;
      } else {
        // ES 6 及更早：{ _doc: { properties } } 或 { typeName: { properties } }
        for (const k of Object.keys(mappings)) {
          const v = mappings[k];
          if (v && typeof v === 'object' && !Array.isArray(v) && v.properties) {
            props = v.properties;
            break;
          }
        }
      }
    }

    const out = [];

    function walk(obj, prefix, depth) {
      for (const name of Object.keys(obj || {})) {
        const def = obj[name] || {};
        const path = prefix ? prefix + '.' + name : name;
        const type = def.type || (def.properties ? 'object' : def.enabled === false ? 'object' : '');

        out.push({
          path: path,
          name: name,
          depth: depth,
          type: type || '—',
          indexed: def.index !== false && def.enabled !== false,
          docValues: def.doc_values !== false,
          analyzer: def.analyzer || def.search_analyzer || '',
          format: def.format || '',
          isMultiField: false,
          isContainer: !!(def.properties),
        });

        if (def.fields && typeof def.fields === 'object') {
          for (const sub of Object.keys(def.fields)) {
            const sd = def.fields[sub] || {};
            out.push({
              path: path + '.' + sub,
              name: sub,
              depth: depth + 1,
              type: sd.type || '—',
              indexed: sd.index !== false,
              docValues: sd.doc_values !== false,
              analyzer: sd.analyzer || '',
              format: sd.format || '',
              isMultiField: true,
              isContainer: false,
            });
          }
        }

        if (def.properties && typeof def.properties === 'object') {
          walk(def.properties, path, depth + 1);
        }
      }
    }

    walk(props || {}, '', 0);
    return out;
  }

  function typeCounts(fields) {
    const map = {};
    // 多字段（title.keyword 这类）也是真实可检索的字段，计入总数，
    // 这样「全部类型（N）」的 N、字段表行数与各类型 chip 之和能对上。
    for (const f of fields || []) {
      map[f.type] = (map[f.type] || 0) + 1;
    }
    return Object.keys(map)
      .map((k) => ({ type: k, count: map[k] }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  }

  function filterFields(fields, keyword, type) {
    const kw = String(keyword || '').trim().toLowerCase();
    return (fields || []).filter((f) => {
      if (type && type !== 'all' && f.type !== type) return false;
      if (!kw) return true;
      return f.path.toLowerCase().indexOf(kw) !== -1 || f.type.toLowerCase().indexOf(kw) !== -1;
    });
  }

  /* ---------------- 索引列表归一化 ---------------- */
  function normalizeCatRows(rows) {
    if (!Array.isArray(rows)) return [];
    const num = (v) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? null : Number(v));
    return rows
      .filter((r) => r && r.index)
      .map((r) => ({
        index: String(r.index),
        health: r.health || '',
        status: r.status || '',
        shards: num(r.pri),
        replicas: num(r.rep),
        docs: num(r['docs.count']),
        sizeBytes: num(r['store.size']),
      }))
      .sort((a, b) => a.index.localeCompare(b.index));
  }

  /* ---------------- 服务端模式 ---------------- */
  async function api(path, opts) {
    opts = opts || {};
    const headers = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['X-ESDSL-Token'] = token;

    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const ms = opts.timeout || 0;
    const timer = ctrl && ms ? setTimeout(() => ctrl.abort(), ms) : null;

    let res;
    try {
      res = await fetch(path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ctrl ? ctrl.signal : undefined,
        cache: 'no-store',
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e && e.name === 'AbortError') throw ESError('请求超时（' + Math.round(ms / 1000) + 's），可在服务端用 ESDSL_ES_TIMEOUT 调整', 'timeout');
      throw ESError('无法连接本地服务：' + (e.message || e), 'network');
    }
    if (timer) clearTimeout(timer);

    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }

    if (res.status === 401) throw ESError('需要访问令牌', 'auth', 401);
    if (!res.ok) {
      const msg = (data && data.error) || res.statusText || ('HTTP ' + res.status);
      throw ESError(msg, 'http', res.status, data);
    }
    return data;
  }

  function serverTransport(src) {
    const base = '/api/sources/' + encodeURIComponent(src.id);
    return {
      mode: 'server',
      ping: () => api(base + '/test', { method: 'POST' }),
      list: () => api(base + '/indices').then(normalizeCatRows),
      detail: (index) => api(base + '/indices/' + encIndex(index) + '/detail'),
      sample: (index, size) => api(base + '/indices/' + encIndex(index) + '/sample?size=' + (size || 10)),
      remove: (index) => api(base + '/indices/' + encIndex(index), { method: 'DELETE' }),
      create: (index, body) => api(base + '/indices/' + encIndex(index), { method: 'PUT', body: body || {} }),
      putMapping: (index, body) => api(base + '/indices/' + encIndex(index) + '/mapping', { method: 'PUT', body: body }),
      addAlias: (index, alias, body) => api(base + '/indices/' + encIndex(index) + '/aliases/' + encAlias(alias), { method: 'PUT', body: body || {} }),
      removeAlias: (index, alias) => api(base + '/indices/' + encIndex(index) + '/aliases/' + encAlias(alias), { method: 'DELETE' }),
      search: (index, body, timeout) => api(
        base + '/search',
        { method: 'POST', body: { index: index, body: body }, timeout: timeout || 30000 }
      ),
    };
  }

  /* ---------------- 直连模式 ---------------- */
  async function directRequest(src, path, opts) {
    opts = opts || {};
    if (!trimUrl(src.url)) throw ESError('数据源未配置地址', 'config');

    const headers = Object.assign({ Accept: 'application/json' }, authHeaders(src));
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = opts.timeout || 15000;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;

    let res;
    try {
      res = await fetch(joinUrl(src.url, path), {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ctrl ? ctrl.signal : undefined,
        cache: 'no-store',
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e && e.name === 'AbortError') throw ESError('请求超时（' + timeout / 1000 + 's）', 'timeout');
      throw ESError(
        '无法直连 Elasticsearch：' + (e.message || e) +
        '。常见原因：① 地址或端口不对；② ES 未开启 CORS（http.cors.enabled: true 且 allow-origin 包含本页地址）；' +
        '③ HTTPS 证书不受信任。改用 server.py 启动服务可彻底避开这些问题。',
        'network'
      );
    }
    if (timer) clearTimeout(timer);

    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }

    if (!res.ok) {
      const errObj = data && data.error;
      const msg = (errObj && (errObj.reason || errObj.type)) || res.statusText || ('HTTP ' + res.status);
      throw ESError('Elasticsearch 返回 ' + res.status + '：' + msg, 'http', res.status, data);
    }
    return data;
  }

  function directTransport(src) {
    return {
      mode: 'direct',
      ping: () => directRequest(src, '/'),
      list: async () => {
        const cols = 'index,health,status,pri,rep,docs.count,store.size';
        try {
          return normalizeCatRows(await directRequest(src, '/_cat/indices?format=json&bytes=b&h=' + cols));
        } catch (e) {
          if (e.status && e.status >= 500) throw e;
          const aliasMap = await directRequest(src, '/_alias');
          return normalizeCatRows(Object.keys(aliasMap || {}).map((k) => ({ index: k })));
        }
      },
      detail: async (index) => {
        const enc = encIndex(index);
        const mapping = await directRequest(src, '/' + enc + '/_mapping');
        const settings = await directRequest(src, '/' + enc + '/_settings?include_defaults=false').catch(() => ({}));
        const aliases = await directRequest(src, '/' + enc + '/_alias').catch(() => ({}));
        return { mapping: mapping, settings: settings, aliases: aliases };
      },
      sample: (index, size) => directRequest(src, '/' + encIndex(index) + '/_search?size=' + (size || 10) + '&track_total_hits=true'),
      remove: (index) => directRequest(src, '/' + encIndex(index), { method: 'DELETE' }),
      create: (index, body) => directRequest(src, '/' + encIndex(index), { method: 'PUT', body: body || {} }),
      putMapping: (index, body) => directRequest(src, '/' + encIndex(index) + '/_mapping', { method: 'PUT', body: body }),
      addAlias: (index, alias, body) => directRequest(src, '/' + encIndex(index) + '/_alias/' + encAlias(alias), { method: 'PUT', body: body || {} }),
      removeAlias: (index, alias) => directRequest(src, '/' + encIndex(index) + '/_alias/' + encAlias(alias), { method: 'DELETE' }),
      search: (index, body, timeout) => {
        const parts = String(index).split(',').map((s) => encIndex(s.trim())).filter(Boolean);
        return directRequest(src, '/' + parts.join(',') + '/_search', {
          method: 'POST',
          body: body,
          timeout: timeout || 30000,
        });
      },
    };
  }

  /* ---------------- 详情解析 ---------------- */
  function parseDetail(resp, fallbackIndex) {
    resp = resp || {};
    const mapping = resp.mapping || {};
    const idxKey = Object.keys(mapping)[0] || fallbackIndex || '';
    const node = mapping[idxKey] || {};
    const mappings = node.mappings || {};
    const fields = flattenMapping(mappings);

    const settingsNode = (resp.settings || {})[idxKey] || {};
    const settings = settingsNode.settings || {};

    const aliasNode = (resp.aliases || {})[idxKey] || {};
    const aliases = aliasNode.aliases || {};

    return {
      index: idxKey,
      fields: fields,
      settings: settings,
      aliases: aliases,
      rawMapping: mappings,
    };
  }

  /* ---------------- 字段变更 DSL（批量编辑 / 跨环境同步用） ---------------- */

  // 按点分路径从原始 mapping 里取字段定义（深拷贝，改返回值不影响原对象）
  function fieldDefFromRaw(rawMapping, path) {
    const parts = String(path || '').split('.').filter(Boolean);
    if (!parts.length) return null;
    let node = rawMapping && rawMapping.properties ? rawMapping.properties : null;
    let def = null;
    for (let i = 0; i < parts.length; i++) {
      if (!node || typeof node !== 'object') return null;
      const key = parts[i];
      if (!Object.prototype.hasOwnProperty.call(node, key)) return null;
      def = node[key] || {};
      if (i < parts.length - 1) node = def.properties || null;
    }
    return def ? JSON.parse(JSON.stringify(def)) : null;
  }

  // [{path, def}] → _mapping 请求体；点分路径自动嵌套成 properties 结构
  function buildMappingBody(entries) {
    const root = {};
    for (const e of entries || []) {
      if (!e || !e.path || !e.def || typeof e.def !== 'object') continue;
      const parts = String(e.path).split('.').filter(Boolean);
      if (!parts.length) continue;
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i];
        if (!node[k] || typeof node[k] !== 'object' || Array.isArray(node[k])) node[k] = {};
        if (!node[k].properties || typeof node[k].properties !== 'object') node[k].properties = {};
        node = node[k].properties;
      }
      node[parts[parts.length - 1]] = e.def;
    }
    return { properties: root };
  }

  // 批量编辑器的一行表单 → 字段定义；meta 列按类型落到 analyzer / format / normalizer
  function rowToDef(row) {
    const name = String((row && row.name) || '').trim();
    if (!name) return { ok: false, error: '请填写字段名' };
    if (!/^[A-Za-z_][A-Za-z0-9_.\-]*$/.test(name)) {
      return { ok: false, error: '字段名只能包含字母、数字、_、-、.，且不能以数字开头' };
    }
    const type = String((row && row.type) || '').trim();
    if (!type) return { ok: false, error: '请选择字段类型' };
    const def = { type: type };
    const meta = String((row && row.meta) || '').trim();
    if (meta) {
      if (type === 'text') def.analyzer = meta;
      else if (type === 'date') def.format = meta;
      else if (type === 'keyword') def.normalizer = meta;
    }
    const rawProps = String((row && row.props) || '').trim();
    if (rawProps) {
      let props;
      try { props = JSON.parse(rawProps); }
      catch (e) { return { ok: false, error: '属性 JSON 解析失败：' + e.message }; }
      if (!props || typeof props !== 'object' || Array.isArray(props)) {
        return { ok: false, error: '属性必须是一个 JSON 对象' };
      }
      Object.assign(def, props);
    }
    return { ok: true, def: def };
  }

  function indexSettingsSummary(settings) {
    const idx = (settings && settings.index) || {};
    const first = (v) => (Array.isArray(v) ? v[0] : v);
    return {
      shards: first(idx.number_of_shards) || '—',
      replicas: first(idx.number_of_replicas) || '—',
      uuid: first(idx.uuid) || '—',
      creationDate: Number(first(idx.creation_date)) || null,
      version: ((idx.version || {}).created) || '—',
      refreshInterval: first(idx.refresh_interval) || '—',
      codec: first(idx.codec) || '—',
      routing: ((idx.routing || {}).allocation || {}).include ? 'custom' : 'default',
    };
  }

  /* ---------------- 查询结果整形 ---------------- */
  function cellText(v) {
    if (v === null || v === undefined) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }

  // 把 _source 展平成单层 map：嵌套对象用 "." 连接，数组原样 JSON
  function flattenDoc(obj, prefix, out) {
    out = out || {};
    prefix = prefix === undefined ? '' : prefix;
    if (obj === null || obj === undefined) { out[prefix] = null; return out; }
    if (typeof obj !== 'object') { out[prefix] = obj; return out; }
    if (Array.isArray(obj)) {
      const simple = obj.every((v) => v === null || typeof v !== 'object');
      out[prefix] = simple ? JSON.stringify(obj) : obj.map((v) => (v && typeof v === 'object' ? '{…}' : String(v)));
      return out;
    }
    const keys = Object.keys(obj);
    if (!keys.length) { out[prefix] = '{}'; return out; }
    keys.forEach((k) => flattenDoc(obj[k], prefix ? prefix + '.' + k : k, out));
    return out;
  }

  // 把 aggregations 拍平成 [{agg, key, count}]，支持多级子聚合与指标聚合
  function aggRows(node, name, out) {
    out = out || [];
    name = name || '';
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node.buckets)) {
      node.buckets.forEach((b) => {
        out.push({
          agg: name || '—',
          key: b.key_as_string !== undefined && b.key_as_string !== null ? String(b.key_as_string) : cellText(b.key),
          count: b.doc_count === undefined ? '' : b.doc_count,
        });
        Object.keys(b).forEach((k) => {
          if (k === 'key' || k === 'key_as_string' || k === 'doc_count' || k === 'from' || k === 'to') return;
          if (b[k] && typeof b[k] === 'object') aggRows(b[k], (name ? name + ' › ' : '') + k, out);
        });
      });
      return out;
    }
    if (node.value !== undefined || node.value_as_string !== undefined) {
      out.push({
        agg: name || '—',
        key: node.value_as_string !== undefined && node.value_as_string !== null ? String(node.value_as_string) : cellText(node.value),
        count: '',
      });
      return out;
    }
    Object.keys(node).forEach((k) => {
      if (node[k] && typeof node[k] === 'object') aggRows(node[k], (name ? name + ' › ' : '') + k, out);
    });
    return out;
  }

  // 顶层指标聚合卡片：单值（avg/sum/min/max/cardinality/value_count）与
  // 多值（stats/extended_stats 平铺数值键、percentiles 的 values 映射）
  // -> [{ name, values: [{k, v}] }]；桶聚合不进这里（走表格）
  function aggMetricList(aggs) {
    const out = [];
    if (!aggs || typeof aggs !== 'object' || Array.isArray(aggs)) return out;
    Object.keys(aggs).forEach((name) => {
      const a = aggs[name];
      if (!a || typeof a !== 'object' || Array.isArray(a) || a.buckets !== undefined) return;
      const values = [];
      if ('value' in a) {
        const v = (a.value_as_string !== undefined && a.value_as_string !== null) ? a.value_as_string : a.value;
        values.push({ k: 'value', v: v });
      } else if (a.values && typeof a.values === 'object' && !Array.isArray(a.values)) {
        // percentiles：{ values: { "1.0": 12, "50.0": 88 } }
        Object.keys(a.values).forEach((k) => values.push({ k: 'P' + k, v: a.values[k] }));
      } else {
        // stats / extended_stats：平铺的数值键
        Object.keys(a).forEach((k) => {
          if (k === 'meta') return;
          const v = a[k];
          if (typeof v === 'number' || typeof v === 'string') values.push({ k, v });
        });
      }
      if (values.length) out.push({ name, values });
    });
    return out;
  }

  /* ---------------- 数据源存储 ---------------- */
  function loadLocal() {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function saveLocal(list) {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
    } catch (e) { /* 忽略配额错误 */ }
  }

  function newId() {
    return 'ds_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }

  const Sources = {
    async list() {
      if (mode === 'server') return api('/api/sources');
      return loadLocal();
    },
    async save(payload) {
      if (mode === 'server') {
        return api('/api/sources', { method: 'POST', body: payload });
      }
      const list = loadLocal();
      const clean = Object.assign({}, payload);
      if (!clean.id) clean.id = newId();
      clean.updatedAt = Date.now();
      const i = list.findIndex((s) => s.id === clean.id);
      if (i === -1) list.push(clean); else list[i] = clean;
      saveLocal(list);
      return clean;
    },
    async remove(id) {
      if (mode === 'server') return api('/api/sources/' + encodeURIComponent(id), { method: 'DELETE' });
      saveLocal(loadLocal().filter((s) => s.id !== id));
      return { ok: true };
    },
  };

  /* ---------------- 模式探测 ---------------- */
  async function detect() {
    if (typeof fetch !== 'function') return 'direct';
    if (typeof location !== 'undefined' && location.protocol === 'file:') return 'direct';
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (!res.ok) return 'direct';
      const j = await res.json();
      return j && j.ok ? 'server' : 'direct';
    } catch (e) {
      return 'direct';
    }
  }

  function loadToken() {
    try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { token = ''; }
  }

  function setToken(v) {
    token = String(v || '').trim();
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 连接测试（不落库） ---------------- */
  async function testConnection(src) {
    if (mode === 'server') return api('/api/test', { method: 'POST', body: src });
    return directRequest(src, '/');
  }

  const API = {
    ESError,
    AUTH_TYPES,
    init: async function () { loadToken(); mode = await detect(); return mode; },
    getMode: () => mode,
    isServer: () => mode === 'server',
    getToken: () => token,
    setToken: setToken,
    transport: (src) => (mode === 'server' ? serverTransport(src) : directTransport(src)),
    testConnection,
    Sources,
    // 纯函数
    trimUrl,
    joinUrl,
    encIndex,
    authHeaders,
    formatBytes,
    formatCount,
    hostOf,
    flattenMapping,
    typeGroup,
    typeCounts,
    filterFields,
    normalizeCatRows,
    parseDetail,
    indexSettingsSummary,
    fieldDefFromRaw,
    buildMappingBody,
    rowToDef,
    isCorsLike,
    cellText,
    flattenDoc,
    aggRows,
    aggMetricList,
    // 服务端健康检查（供 UI 展示）
    health: () => api('/api/health'),
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.ESDC = API;
})(typeof window !== 'undefined' ? window : globalThis);
