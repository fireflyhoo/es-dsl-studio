/* ============================================================
 * ES DSL Studio - 索引管理视图
 * 数据源（多集群）→ 索引 → 字段 的树形浏览，以及索引结构详情
 * ============================================================ */
(function () {
  'use strict';

  const E = window.ESDC;
  const {
    formatBytes, formatCount, hostOf, typeCounts, filterFields,
    parseDetail, indexSettingsSummary, transport, Sources, AUTH_TYPES,
  } = E;

  /* ---------------- 状态 ---------------- */
  const state = {
    mode: 'direct',
    sources: [],
    conn: {},        // sid -> {status, info, rows, err, at}
    detail: {},      // sid|index -> {data|err}
    pending: {},     // sid|index -> Promise
    sample: {},      // sid|index -> {data|err}
    samplePending: {},
    expandedSrc: {}, // sid -> bool（默认展开）
    expandedIdx: {}, // sid|index -> bool
    active: null,    // {sid, index}
    tab: 'overview',
    filter: '',
    fieldFilter: '',
    fieldType: 'all',
    showSystem: false,
    booted: false,
  };
  let renderSampleColBtn = null; // 样本数据「选择列」按钮（renderSample 内赋值）

  /* ---------------- DOM 工具 ---------------- */
  const $ = (s) => document.querySelector(s);
  function h(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1900);
  }
  function copy(text, okMsg) {
    const done = () => toast(okMsg || '已复制');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallback(text, done));
    } else fallback(text, done);
  }
  function fallback(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选择'); }
    document.body.removeChild(ta);
  }

  const ICON = {
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  };

  /* ---------------- 类型着色（分组表在 es-client.js，索引管理与字段联想共用） ---------------- */
  function typeGroup(t) { return E.typeGroup(t); }

  function typeBadge(t) {
    return '<span class="ftype g-' + typeGroup(t) + '">' + esc(t) + '</span>';
  }

  function healthClass(hh) {
    if (hh === 'green') return 'ok';
    if (hh === 'yellow') return 'warn';
    if (hh === 'red') return 'bad';
    return 'unknown';
  }

  /* ---------------- 数据加载 ---------------- */
  function srcOf(sid) { return state.sources.find((s) => s.id === sid); }

  async function loadSources() {
    try {
      state.sources = await Sources.list();
    } catch (e) {
      state.sources = [];
      if (e.kind === 'auth') openTokenModal(loadSources);
      else toast('读取数据源失败：' + e.message);
    }
    renderTree();
  }

  async function connect(sid, silent) {
    const src = srcOf(sid);
    if (!src) return;
    state.conn[sid] = { status: 'loading' };
    renderTree();
    try {
      const t = transport(src);
      const [info, rows] = await Promise.all([t.ping(), t.list()]);
      state.conn[sid] = { status: 'ok', info: info, rows: rows, at: Date.now() };
      if (!silent) toast(src.name + '：' + rows.length + ' 个索引');
    } catch (e) {
      if (e.kind === 'auth') openTokenModal(() => connect(sid));
      state.conn[sid] = { status: 'error', err: e.message || String(e) };
    }
    renderTree();
  }

  async function ensureDetail(sid, index, force) {
    const key = sid + '|' + index;
    if (!force && state.detail[key] && !state.detail[key].err) return state.detail[key];
    if (state.pending[key]) return state.pending[key];

    const p = (async () => {
      const src = srcOf(sid);
      try {
        if (!src) throw new Error('数据源已不存在');
        const raw = await transport(src).detail(index);
        state.detail[key] = { data: parseDetail(raw, index) };
      } catch (e) {
        if (e.kind === 'auth') openTokenModal(() => ensureDetail(sid, index, true));
        state.detail[key] = { err: e.message || String(e) };
      } finally {
        delete state.pending[key];
        renderTree();
        if (state.active && state.active.sid === sid && state.active.index === index) renderDetail();
      }
      return state.detail[key];
    })();

    state.pending[key] = p;
    return p;
  }

  async function loadSample(sid, index) {
    const key = sid + '|' + index;
    if (state.sample[key] && !state.sample[key].err) return;
    if (state.samplePending[key]) return;
    const src = srcOf(sid);
    if (!src) return;
    const p = (async () => {
      try {
        const data = await transport(src).sample(index, 10);
        state.sample[key] = { data: data };
      } catch (e) {
        state.sample[key] = { err: e.message || String(e) };
      } finally {
        delete state.samplePending[key];
        if (state.active && state.active.sid === sid && state.active.index === index && state.tab === 'sample') renderDetail();
      }
    })();
    state.samplePending[key] = p;
    if (state.active && state.active.sid === sid && state.active.index === index) renderDetail();
  }

  /* ---------------- 树渲染 ---------------- */
  function matchIndex(src, it) {
    const kw = state.filter.trim().toLowerCase();
    if (!kw) return true;
    if (it.index.toLowerCase().indexOf(kw) !== -1) return true;
    const d = state.detail[src.id + '|' + it.index];
    if (d && d.data) return d.data.fields.some((f) => f.path.toLowerCase().indexOf(kw) !== -1);
    return false;
  }

  function sourceEl(src) {
    const conn = state.conn[src.id] || { status: 'idle' };
    const expanded = state.expandedSrc[src.id] === true;
    const el = h('div', 'ds-node');
    el.dataset.sid = src.id;

    const dotCls = conn.status === 'ok' ? 'ok' : conn.status === 'error' ? 'bad' : conn.status === 'loading' ? 'loading' : '';
    const head = h('div', 'ds-head');
    head.innerHTML =
      '<span class="ds-caret' + (expanded ? ' open' : '') + '">▶</span>' +
      '<span class="ds-dot ' + dotCls + '"></span>' +
      '<span class="ds-name" title="' + esc(src.url) + '">' + esc(src.name) + '</span>' +
      (src.readonly ? '<span class="tag-ro">只读</span>' : '') +
      '<span class="ds-url">' + esc(hostOf(src.url)) + '</span>' +
      '<span class="ds-acts">' +
        '<button class="icon-btn" data-act="refresh" title="刷新">' + ICON.refresh + '</button>' +
        '<button class="icon-btn" data-act="edit" title="编辑数据源">' + ICON.edit + '</button>' +
        '<button class="icon-btn del" data-act="remove" title="删除数据源">' + ICON.trash + '</button>' +
      '</span>';
    el.appendChild(head);

    if (!expanded) return el;

    const body = h('div', 'ds-body');

    if (conn.status === 'loading') {
      body.appendChild(h('div', 'ds-hint', '正在连接…'));
    } else if (conn.status === 'error') {
      const box = h('div', 'ds-error', esc(conn.err));
      const btn = h('button', 'btn sm', '重试');
      btn.dataset.act = 'connect';
      box.appendChild(btn);
      body.appendChild(box);
    } else if (conn.status === 'idle') {
      const box = h('div', 'ds-hint', '尚未连接');
      const btn = h('button', 'btn sm primary', '连接');
      btn.dataset.act = 'connect';
      box.appendChild(btn);
      body.appendChild(box);
    } else {
      const rows = conn.rows || [];
      const visible = rows.filter((it) => (state.showSystem || it.index.charAt(0) !== '.') && matchIndex(src, it));
      const totalDocs = rows.reduce((a, it) => a + (it.docs || 0), 0);
      const totalSize = rows.reduce((a, it) => a + (it.sizeBytes || 0), 0);
      const info = conn.info || {};
      const ver = (info.version && info.version.number) || '';

      const summary = h('div', 'ds-summary');
      summary.innerHTML =
        '<span>' + visible.length + (visible.length !== rows.length ? ' / ' + rows.length : '') + ' 个索引</span>' +
        '<span>' + formatCount(totalDocs) + ' 文档</span>' +
        '<span>' + formatBytes(totalSize) + '</span>' +
        (ver ? '<span class="mono">v' + esc(ver) + '</span>' : '');
      body.appendChild(summary);

      if (!visible.length) {
        body.appendChild(h('div', 'ds-hint', state.filter ? '没有匹配的索引或字段' : '该集群没有索引'));
      } else {
        const list = h('div', 'idx-list');
        for (const it of visible) list.appendChild(indexEl(src, it));
        body.appendChild(list);
      }
    }

    el.appendChild(body);
    return el;
  }

  function indexEl(src, it) {
    const key = src.id + '|' + it.index;
    const wrap = h('div', 'idx-node');
    const isActive = state.active && state.active.sid === src.id && state.active.index === it.index;
    const expanded = state.expandedIdx[key] === true;

    const row = h('div', 'idx-row' + (isActive ? ' sel' : ''));
    row.dataset.sid = src.id;
    row.dataset.index = it.index;
    row.innerHTML =
      '<span class="idx-caret' + (expanded ? ' open' : '') + '">▶</span>' +
      '<span class="hdot ' + healthClass(it.health) + '" title="健康度 ' + esc(it.health || '未知') + '"></span>' +
      '<span class="idx-name">' + esc(it.index) + '</span>' +
      '<span class="idx-meta">' + (it.docs === null ? '' : formatCount(it.docs) + ' · ') + formatBytes(it.sizeBytes) + '</span>';
    wrap.appendChild(row);

    if (!expanded) return wrap;

    const d = state.detail[key];
    const box = h('div', 'idx-fields');
    if (state.pending[key]) {
      box.appendChild(h('div', 'idx-loading', '加载字段…'));
    } else if (!d) {
      box.appendChild(h('div', 'idx-loading', '展开以加载字段'));
    } else if (d.err) {
      box.appendChild(h('div', 'idx-loading bad', esc(d.err)));
    } else {
      const fields = d.data.fields;
      const shown = fields.slice(0, 300);
      for (const f of shown) {
        const fe = h('div', 'idx-field');
        fe.dataset.act = 'copy-field';
        fe.dataset.path = f.path;
        fe.style.paddingLeft = (8 + f.depth * 14) + 'px';
        fe.innerHTML = typeBadge(f.type) + '<span class="fname">' + esc(f.name) + '</span>';
        box.appendChild(fe);
      }
      if (fields.length > shown.length) {
        const more = h('div', 'idx-more', '还有 ' + (fields.length - shown.length) + ' 个字段，点索引查看全部');
        more.dataset.act = 'open-fields-tab';
        more.dataset.sid = src.id;
        more.dataset.index = it.index;
        box.appendChild(more);
      }
      if (!fields.length) box.appendChild(h('div', 'idx-loading', '该索引没有字段映射'));
    }
    wrap.appendChild(box);
    return wrap;
  }

  function renderTree() {
    const treeEl = $('#idx-tree');
    if (!treeEl) return;
    treeEl.innerHTML = '';

    if (!state.sources.length) {
      const empty = h('div', 'ds-empty');
      empty.innerHTML =
        '<div class="big">还没有数据源</div>' +
        '<div>添加一个 Elasticsearch 地址，就能在这里浏览索引结构</div>';
      const btn = h('button', 'btn primary sm', '新增数据源');
      btn.dataset.act = 'add';
      empty.appendChild(btn);
      treeEl.appendChild(empty);
      return;
    }

    for (const src of state.sources) treeEl.appendChild(sourceEl(src));
  }

  /* ---------------- 详情渲染 ---------------- */
  function highlightJSON(obj) {
    const json = JSON.stringify(obj, null, 2);
    return esc(json).replace(
      /(&quot;(?:\\.|[^&])*?&quot;)(\s*:)?|\b(true|false|null)\b|-?\d+(\.\d+)?([eE][+-]?\d+)?/g,
      (m, str, colon) => {
        if (str !== undefined) return colon ? '<span class="k">' + str + '</span>:' : '<span class="s">' + str + '</span>';
        if (/^(true|false|null)$/.test(m)) return '<span class="b">' + m + '</span>';
        return '<span class="n">' + m + '</span>';
      }
    );
  }

  function renderDetail() {
    const emptyEl = $('#idx-empty');
    const contentEl = $('#idx-content');
    if (!emptyEl || !contentEl) return;

    const sel = state.active;
    if (!sel) {
      emptyEl.hidden = false;
      contentEl.hidden = true;
      return;
    }
    const key = sel.sid + '|' + sel.index;
    const src = srcOf(sel.sid);
    const rec = state.detail[key];
    const rows = (state.conn[sel.sid] || {}).rows || [];
    const meta = rows.find((r) => r.index === sel.index) || {};

    emptyEl.hidden = true;
    contentEl.hidden = false;

    // 头部
    $('#idx-title-name').textContent = sel.index;
    const hd = $('#idx-title-health');
    hd.className = 'hbadge ' + healthClass(meta.health);
    hd.textContent = meta.health ? meta.health.toUpperCase() : '—';
    hd.title = '健康度：' + (meta.health || '未知');

    const sub = [];
    if (meta.docs !== null && meta.docs !== undefined) sub.push(formatCount(meta.docs) + ' 文档');
    if (meta.sizeBytes !== null && meta.sizeBytes !== undefined) sub.push(formatBytes(meta.sizeBytes));
    if (meta.shards !== null && meta.shards !== undefined) sub.push(meta.shards + ' 主分片 / ' + (meta.replicas || 0) + ' 副本');
    if (src) sub.push(src.name);
    $('#idx-sub').textContent = sub.join(' · ');

    // 页签
    document.querySelectorAll('#idx-tabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === state.tab);
    });

    const body = $('#idx-body');
    body.innerHTML = '';

    if (rec && rec.err) {
      const box = h('div', 'detail-error');
      box.innerHTML = '<b>加载失败</b><div>' + esc(rec.err) + '</div>';
      const retry = h('button', 'btn sm', '重试');
      retry.dataset.act = 'retry-detail';
      box.appendChild(retry);
      body.appendChild(box);
      return;
    }
    if (!rec || state.pending[key]) {
      body.appendChild(h('div', 'detail-loading', '正在读取索引结构…'));
      return;
    }

    const data = rec.data;
    if (state.tab === 'overview') body.appendChild(renderOverview(data, meta, src));
    else if (state.tab === 'fields') body.appendChild(renderFields(data));
    else if (state.tab === 'settings') body.appendChild(renderSettings(data));
    else if (state.tab === 'aliases') body.appendChild(renderAliases(data));
    else if (state.tab === 'sample') {
      if (!state.sample[key]) { loadSample(sel.sid, sel.index); body.appendChild(h('div', 'detail-loading', '正在抽样…')); }
      else body.appendChild(renderSample(state.sample[key]));
    } else if (state.tab === 'raw') body.appendChild(renderRaw(data));
  }

  function statCard(label, value, hint) {
    return '<div class="stat"><span class="sk">' + esc(label) + '</span>' +
      '<b>' + esc(value) + '</b>' + (hint ? '<span class="sh">' + esc(hint) + '</span>' : '') + '</div>';
  }

  function renderOverview(data, meta, src) {
    const box = h('div', 'tab-pane');
    const s = indexSettingsSummary(data.settings);
    const stats = h('div', 'stat-grid');
    stats.innerHTML =
      statCard('文档数', formatCount(meta.docs), '') +
      statCard('存储大小', formatBytes(meta.sizeBytes), '含副本') +
      statCard('主分片', String(meta.shards === null || meta.shards === undefined ? s.shards : meta.shards), 'pri') +
      statCard('副本数', String(meta.replicas === null || meta.replicas === undefined ? s.replicas : meta.replicas), 'rep') +
      statCard('字段数', String(data.fields.length), '含多字段') +
      statCard('别名', String(Object.keys(data.aliases).length), '');
    box.appendChild(stats);

    const info = h('div', 'info-table');
    const created = s.creationDate ? new Date(s.creationDate).toLocaleString('zh-CN') : '—';
    const pairs = [
      ['索引名', data.index || '-'],
      ['状态', meta.status === 'open' ? '已打开' : (meta.status || '—')],
      ['UUID', s.uuid],
      ['创建时间', created],
      ['Lucene 版本', s.version],
      ['refresh_interval', s.refreshInterval],
      ['codec', s.codec],
      ['数据源', src ? src.name + ' · ' + src.url : '—'],
    ];
    for (const [k, v] of pairs) {
      const row = h('div', 'info-row');
      row.innerHTML = '<span class="ik">' + esc(k) + '</span><span class="iv mono">' + esc(v) + '</span>';
      info.appendChild(row);
    }
    box.appendChild(info);

    const counts = typeCounts(data.fields);
    if (counts.length) {
      const t = h('div', 'type-summary');
      t.innerHTML = '<div class="ts-h">字段类型分布</div>';
      const chips = h('div', 'ts-chips');
      for (const c of counts) {
        const chip = h('span', 'ts-chip');
        chip.innerHTML = typeBadge(c.type) + '<b>' + c.count + '</b>';
        chips.appendChild(chip);
      }
      t.appendChild(chips);
      box.appendChild(t);
    }
    return box;
  }

  function renderFields(data) {
    const box = h('div', 'tab-pane');

    const bar = h('div', 'fields-toolbar');
    const counts = typeCounts(data.fields);
    const search = h('input');
    search.type = 'text';
    search.id = 'fld-search';
    search.placeholder = '搜索字段名或类型…';
    search.value = state.fieldFilter;
    const sel = h('select');
    sel.id = 'fld-type';
    sel.innerHTML = '<option value="all">全部类型（' + data.fields.length + '）</option>' +
      counts.map((c) => '<option value="' + esc(c.type) + '"' + (state.fieldType === c.type ? ' selected' : '') + '>' +
        esc(c.type) + '（' + c.count + '）</option>').join('');
    const copyBtn = h('button', 'btn sm', '复制可见字段');
    copyBtn.dataset.act = 'copy-visible-fields';
    bar.appendChild(search);
    bar.appendChild(sel);
    bar.appendChild(copyBtn);
    box.appendChild(bar);

    const list = filterFields(data.fields, state.fieldFilter, state.fieldType);
    const cnt = h('div', 'fields-count', '共 ' + data.fields.length + ' 个字段' + (list.length !== data.fields.length ? '，匹配 ' + list.length + ' 个' : ''));
    box.appendChild(cnt);

    if (!list.length) {
      box.appendChild(h('div', 'detail-loading', '没有匹配的字段'));
      return box;
    }

    const table = h('table', 'fields-table');
    table.innerHTML = '<thead><tr><th>字段</th><th>类型</th><th>分词器 / 格式</th><th>属性</th></tr></thead>';
    const tbody = h('tbody');
    for (const f of list) {
      const tr = h('tr');
      tr.dataset.act = 'copy-field';
      tr.dataset.path = f.path;
      tr.title = '点击复制：' + f.path;

      const attrs = [];
      if (!f.indexed) attrs.push('index:false');
      if (!f.docValues) attrs.push('doc_values:false');
      if (f.isMultiField) attrs.push('multi-field');

      tr.innerHTML =
        '<td class="fc-name"><span style="padding-left:' + (f.depth * 16) + 'px" class="' +
          (f.isContainer ? 'is-container' : '') + '">' + esc(f.name) + '</span></td>' +
        '<td>' + typeBadge(f.type) + '</td>' +
        '<td class="fc-meta mono">' + esc(f.analyzer || f.format || '') + '</td>' +
        '<td class="fc-attrs mono">' + esc(attrs.join(' ')) + '</td>';
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
    return box;
  }

  function renderSettings(data) {
    const box = h('div', 'tab-pane');
    const s = indexSettingsSummary(data.settings);
    const bar = h('div', 'fields-toolbar');
    const tip = h('span', 'mono dim', 'index.number_of_shards=' + s.shards + '  index.number_of_replicas=' + s.replicas);
    const btn = h('button', 'btn sm', '复制 JSON');
    btn.dataset.act = 'copy-settings';
    bar.appendChild(tip);
    bar.appendChild(btn);
    box.appendChild(bar);
    box.appendChild(h('pre', 'json-view', highlightJSON(data.settings)));
    return box;
  }

  function renderAliases(data) {
    const box = h('div', 'tab-pane');
    const names = Object.keys(data.aliases);
    if (!names.length) {
      box.appendChild(h('div', 'detail-loading', '该索引没有配置别名'));
      return box;
    }
    const table = h('table', 'fields-table');
    table.innerHTML = '<thead><tr><th>别名</th><th>过滤条件</th><th>路由</th></tr></thead>';
    const tbody = h('tbody');
    for (const n of names) {
      const a = data.aliases[n] || {};
      const tr = h('tr');
      tr.innerHTML =
        '<td class="fc-name">' + esc(n) + '</td>' +
        '<td class="fc-meta mono">' + (a.filter ? esc(JSON.stringify(a.filter)) : '—') + '</td>' +
        '<td class="fc-meta mono">' + esc(a.routing || a.index_routing || '—') + '</td>';
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
    return box;
  }

  function renderSample(rec) {
    if (window.ESCols) window.ESCols.close(); // 切页签/重渲染时收起浮层
    const box = h('div', 'tab-pane');
    if (!rec || rec.err) {
      box.appendChild(h('div', 'detail-loading bad', (rec && rec.err) || '抽样失败'));
      const retry = h('button', 'btn sm', '重试');
      retry.dataset.act = 'retry-sample';
      box.appendChild(retry);
      return box;
    }
    const resp = rec.data || {};
    const hitsWrap = resp.hits || {};
    const hits = hitsWrap.hits || [];
    const total = typeof hitsWrap.total === 'object' ? (hitsWrap.total || {}).value : hitsWrap.total;

    const bar = h('div', 'fields-toolbar');
    bar.innerHTML = '<span class="mono dim">返回 ' + hits.length + ' 条' +
      (total !== undefined ? ' · 命中 ' + formatCount(total) : '') + '</span>' +
      '<span style="flex:1"></span>';
    const btn = h('button', 'btn sm', '重新抽样');
    btn.dataset.act = 'retry-sample';
    bar.appendChild(btn);
    if (window.ESCols) {
      const colBtn = h('button', 'btn sm cp-btn', '选择列');
      colBtn.title = '选择表格展示哪些列（按索引记忆）';
      bar.appendChild(colBtn);
      renderSampleColBtn = colBtn; // 供表格渲染后更新计数徽标
    }
    box.appendChild(bar);

    if (!hits.length) {
      box.appendChild(h('div', 'detail-loading', '该索引暂无文档'));
      return box;
    }

    const cols = [];
    const seen = {};
    for (const it of hits) {
      const s = it._source || {};
      for (const k of Object.keys(s)) {
        if (!seen[k]) { seen[k] = 1; cols.push(k); }
      }
    }
    const idxName = (state.active && state.active.index) || '';
    const vis = window.ESCols ? window.ESCols.visible(cols, idxName) : { cols: cols.slice(0, 14), saved: false };
    const showCols = vis.cols;
    if (renderSampleColBtn) window.ESCols.badge(renderSampleColBtn, '选择列', showCols.length, cols.length);

    const table = h('table', 'fields-table sample-table');
    table.innerHTML = '<thead><tr><th>#</th>' + showCols.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr></thead>';
    const tbody = h('tbody');
    hits.forEach((it, i) => {
      const tr = h('tr');
      const cells = showCols.map((c) => {
        const v = (it._source || {})[c];
        let text;
        if (v === undefined || v === null) text = '—';
        else if (typeof v === 'object') text = JSON.stringify(v);
        else text = String(v);
        if (text.length > 60) text = text.slice(0, 60) + '…';
        return '<td class="mono">' + esc(text) + '</td>';
      }).join('');
      tr.innerHTML = '<td class="mono dim">' + (i + 1) + '</td>' + cells;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    box.appendChild(table);

    if (vis.saved) {
      if (showCols.length < cols.length) box.appendChild(h('div', 'sample-cols-hint', '已选 ' + showCols.length + ' / ' + cols.length + ' 列（点「选择列」调整，设置按索引记忆）'));
    } else if (cols.length > 14) {
      box.appendChild(h('div', 'sample-cols-hint', '字段较多，默认显示前 14 列（共 ' + cols.length + ' 列），点「选择列」可挑要看的'));
    }

    if (window.ESCols && renderSampleColBtn) {
      window.ESCols.attach(renderSampleColBtn, {
        getAll: () => cols,
        getSel: () => showCols,
        onApply: (picked) => {
          window.ESCols.setPref(idxName, picked);
          renderDetail();
        },
        onReset: () => {
          window.ESCols.setPref(idxName, null);
          renderDetail();
        }
      });
    }
    return box;
  }

  function renderRaw(data) {
    const box = h('div', 'tab-pane');
    const bar = h('div', 'fields-toolbar');
    const btn = h('button', 'btn sm', '复制原始响应');
    btn.dataset.act = 'copy-raw';
    bar.appendChild(h('span', 'mono dim', 'mapping 原始结构（未扁平化）'));
    bar.appendChild(btn);
    box.appendChild(bar);
    box.appendChild(h('pre', 'json-view', highlightJSON(data.rawMapping)));
    return box;
  }

  /* ---------------- 桥接查询编辑器 ---------------- */
  function syncBridge() {
    if (!state.active || !window.ESStudio) return;
    const rec = state.detail[state.active.sid + '|' + state.active.index];
    if (!rec || !rec.data) return;
    const srcRec = srcOf(state.active.sid) || {};
    window.ESStudio.setActiveIndex({
      index: state.active.index,
      source: srcRec.name || '',
      sourceId: srcRec.id || '',
      // 带 type 的字段清单，查询编辑器的字段联想会把类型展示出来
      fields: rec.data.fields.map((f) => ({ path: f.path, type: f.type })),
    });
  }

  /* ---------------- 数据源弹窗 ---------------- */
  let editingId = null;

  function openSourceModal(src) {
    editingId = src ? src.id : null;
    $('#ds-title').textContent = src ? '编辑数据源' : '新增数据源';
    $('#ds-name').value = src ? src.name : '';
    $('#ds-url').value = src ? src.url : 'http://localhost:9200';
    $('#ds-auth').value = (src && src.authType) || 'none';
    $('#ds-user').value = (src && src.username) || '';
    $('#ds-pass').value = '';
    $('#ds-apikey').value = '';
    $('#ds-bearer').value = '';
    $('#ds-insecure').checked = !!(src && src.insecure);
    $('#ds-readonly').checked = !!(src && src.readonly);
    $('#ds-test-result').textContent = '';
    $('#ds-test-result').className = 'ds-test-result';
    const passEl = $('#ds-pass');
    passEl.placeholder = src && src.hasSecret ? '留空表示不修改' : '';
    syncAuthRows();
    $('#ds-mask').classList.add('show');
    setTimeout(() => $('#ds-name').focus(), 40);
  }

  function closeSourceModal() {
    $('#ds-mask').classList.remove('show');
    editingId = null;
  }

  function syncAuthRows() {
    const t = $('#ds-auth').value;
    document.querySelectorAll('[data-auth]').forEach((el) => {
      el.hidden = el.dataset.auth !== t;
    });
  }

  function formPayload() {
    const payload = {
      name: $('#ds-name').value.trim(),
      url: $('#ds-url').value.trim(),
      authType: $('#ds-auth').value,
      username: $('#ds-user').value.trim(),
      insecure: $('#ds-insecure').checked,
      readonly: $('#ds-readonly').checked,
    };
    if (editingId) payload.id = editingId;
    const t = payload.authType;
    if (t === 'basic') payload.password = $('#ds-pass').value;
    if (t === 'apikey') payload.apiKey = $('#ds-apikey').value;
    if (t === 'bearer') payload.token = $('#ds-bearer').value;
    return payload;
  }

  async function testForm() {
    const box = $('#ds-test-result');
    const payload = formPayload();
    if (!payload.url) { box.className = 'ds-test-result bad'; box.textContent = '请填写地址'; return; }
    box.className = 'ds-test-result';
    box.textContent = '正在连接…';
    try {
      const info = await E.testConnection(payload);
      const v = (info && info.version && info.version.number) || '';
      const cluster = (info && info.cluster_name) || '';
      box.className = 'ds-test-result ok';
      box.textContent = '连接成功 · 集群 ' + (cluster || '（未命名）') + (v ? ' · v' + v : '');
    } catch (e) {
      box.className = 'ds-test-result bad';
      box.textContent = e.message || String(e);
    }
  }

  function formError(msg, focusSel) {
    const box = $('#ds-test-result');
    if (box) { box.className = 'ds-test-result bad'; box.textContent = msg; }
    if (focusSel) { const el = $(focusSel); if (el) el.focus(); }
  }

  async function saveForm() {
    const payload = formPayload();
    if (!payload.name) { formError('请填写数据源名称', '#ds-name'); return; }
    if (!/^https?:\/\//i.test(payload.url)) { formError('地址需以 http:// 或 https:// 开头', '#ds-url'); return; }
    try {
      const saved = await Sources.save(payload);
      closeSourceModal();
      await loadSources();
      state.expandedSrc[saved.id] = true;
      renderTree();
      connect(saved.id);
      toast('已保存');
    } catch (e) {
      if (e.kind === 'auth') openTokenModal(() => saveForm());
      else toast('保存失败：' + e.message);
    }
  }

  /* ---------------- 通用确认弹窗 ---------------- */
  let confirmResolve = null;

  function confirmDialog(opt) {
    $('#confirm-title').textContent = opt.title || '确认';
    $('#confirm-desc').innerHTML = opt.desc || '';
    $('#confirm-ok').textContent = opt.okText || '确定';
    $('#confirm-ok').classList.toggle('danger', !!opt.danger);
    const wrap = $('#confirm-input-wrap');
    if (opt.requireText) {
      wrap.hidden = false;
      $('#confirm-input').value = '';
      $('#confirm-input').placeholder = opt.requireText;
      $('#confirm-ok').disabled = true;
    } else {
      wrap.hidden = true;
      $('#confirm-ok').disabled = false;
    }
    $('#confirm-mask').classList.add('show');
    if (opt.requireText) setTimeout(() => $('#confirm-input').focus(), 40);

    confirmResolve = async () => {
      $('#confirm-mask').classList.remove('show');
      const fn = opt.onOk;
      confirmResolve = null;
      if (fn) {
        try { await fn(); } catch (e) {
          if (e.kind === 'auth') openTokenModal(null);
          else toast('操作失败：' + e.message);
        }
      }
    };
  }

  function closeConfirm() {
    $('#confirm-mask').classList.remove('show');
    confirmResolve = null;
  }

  /* ---------------- 令牌弹窗 ---------------- */
  let tokenRetry = null;
  function openTokenModal(retry) {
    tokenRetry = retry || null;
    $('#token-input').value = E.getToken() || '';
    $('#token-mask').classList.add('show');
    setTimeout(() => $('#token-input').focus(), 40);
  }
  function closeTokenModal(apply) {
    if (apply) {
      E.setToken($('#token-input').value);
      toast('令牌已保存');
    }
    $('#token-mask').classList.remove('show');
    const fn = tokenRetry;
    tokenRetry = null;
    if (apply && fn) fn();
  }

  /* ---------------- 动作 ---------------- */
  function toggleSource(sid) {
    state.expandedSrc[sid] = state.expandedSrc[sid] !== true;
    renderTree();
    if (state.expandedSrc[sid] && (!state.conn[sid] || state.conn[sid].status === 'idle')) connect(sid);
  }

  function toggleIndex(sid, index) {
    const key = sid + '|' + index;
    state.expandedIdx[key] = state.expandedIdx[key] !== true;
    renderTree();
    if (state.expandedIdx[key]) ensureDetail(sid, index);
  }

  function selectIndex(sid, index) {
    state.active = { sid: sid, index: index };
    state.fieldFilter = '';
    state.fieldType = 'all';
    state.expandedSrc[sid] = true;
    renderTree();
    renderDetail();
    ensureDetail(sid, index).then(syncBridge);
  }

  function deleteIndexFlow(sid, index) {
    const src = srcOf(sid);
    if (src && src.readonly) { toast('该数据源处于只读模式'); return; }
    confirmDialog({
      title: '删除索引',
      desc: '将永久删除索引 <b class="mono">' + esc(index) + '</b> 及其全部文档，此操作不可撤销。<br>' +
        '请输入索引名以确认：',
      requireText: index,
      okText: '永久删除',
      danger: true,
      onOk: async () => {
        const src2 = srcOf(sid);
        await transport(src2).remove(index);
        delete state.detail[sid + '|' + index];
        if (state.active && state.active.sid === sid && state.active.index === index) state.active = null;
        renderDetail();
        toast('已删除索引 ' + index);
        connect(sid, true);
      },
    });
  }

  function removeSourceFlow(sid) {
    const src = srcOf(sid);
    if (!src) return;
    confirmDialog({
      title: '删除数据源',
      desc: '将从本工具中移除数据源 <b>' + esc(src.name) + '</b>。<br>不会删除 Elasticsearch 上的任何索引，但保存的凭据会一并清除。',
      okText: '删除',
      danger: true,
      onOk: async () => {
        await Sources.remove(sid);
        delete state.conn[sid];
        if (state.active && state.active.sid === sid) state.active = null;
        await loadSources();
        renderDetail();
        toast('已删除数据源');
      },
    });
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    // 树：所有点击走委托
    const treeEl = $('#idx-tree');
    treeEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      const holder = e.target.closest('[data-sid]');
      const sidVal = holder ? holder.dataset.sid : null;

      if (btn) {
        const act = btn.dataset.act;
        e.stopPropagation();
        if (act === 'add') { openSourceModal(null); return; }
        if (act === 'connect' && sidVal) { connect(sidVal); return; }
        if (act === 'refresh' && sidVal) { connect(sidVal); return; }
        if (act === 'edit' && sidVal) { openSourceModal(srcOf(sidVal)); return; }
        if (act === 'remove' && sidVal) { removeSourceFlow(sidVal); return; }
        if (act === 'copy-field') { copy(btn.dataset.path, '已复制字段名'); return; }
        if (act === 'open-fields-tab') {
          selectIndex(btn.dataset.sid, btn.dataset.index);
          state.tab = 'fields';
          renderDetail();
          return;
        }
        return;
      }

      const row = e.target.closest('.idx-row');
      if (row) {
        const s = row.dataset.sid;
        const i = row.dataset.index;
        const caret = e.target.closest('.idx-caret');
        if (caret) { toggleIndex(s, i); return; }
        if (state.active && state.active.sid === s && state.active.index === i) toggleIndex(s, i);
        else selectIndex(s, i);
        return;
      }

      const head = e.target.closest('.ds-head');
      if (head) {
        const node = head.closest('.ds-node');
        toggleSource(node.dataset.sid);
      }
    });

    // 检索框
    const search = $('#idx-search');
    if (search) {
      search.addEventListener('input', (e) => {
        state.filter = e.target.value;
        renderTree();
      });
    }
    const sysToggle = $('#idx-system-toggle');
    if (sysToggle) {
      sysToggle.addEventListener('change', (e) => {
        state.showSystem = e.target.checked;
        renderTree();
      });
    }

    // 头部按钮
    $('#btn-add-ds').addEventListener('click', () => openSourceModal(null));
    $('#btn-refresh-all').addEventListener('click', () => {
      state.sources.forEach((s) => connect(s.id, true));
    });

    // 详情头部动作
    $('#idx-acts').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn || !state.active) return;
      const { sid, index } = state.active;
      const act = btn.dataset.act;
      if (act === 'refresh') {
        delete state.detail[sid + '|' + index];
        delete state.sample[sid + '|' + index];
        ensureDetail(sid, index, true).then(syncBridge);
        renderDetail();
      } else if (act === 'copy-name') {
        copy(index, '已复制索引名');
      } else if (act === 'copy-path') {
        copy('GET /' + index + '/_search\n' + JSON.stringify({ query: { match_all: {} }, size: 10 }, null, 2), '已复制请求');
      } else if (act === 'use-fields') {
        if (window.ESStudio) { window.ESStudio.switchView('query'); toast('字段已同步到查询编辑器'); }
      } else if (act === 'delete') {
        deleteIndexFlow(sid, index);
      }
    });

    // 页签
    $('#idx-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]');
      if (!b) return;
      state.tab = b.dataset.tab;
      renderDetail();
    });

    // 详情内容里的交互（输入框 / 复制 / 重试）
    $('#idx-body').addEventListener('input', (e) => {
      if (e.target.id === 'fld-search') {
        const pos = e.target.selectionStart;
        state.fieldFilter = e.target.value;
        renderDetail();
        const s = $('#fld-search');
        if (s) { s.focus(); s.setSelectionRange(pos, pos); }
      }
    });
    $('#idx-body').addEventListener('change', (e) => {
      if (e.target.id === 'fld-type') {
        state.fieldType = e.target.value;
        renderDetail();
      }
    });
    $('#idx-body').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (btn) {
        const act = btn.dataset.act;
        if (act === 'copy-field') { copy(btn.dataset.path, '已复制字段名'); return; }
        if (act === 'retry-detail' && state.active) {
          delete state.detail[state.active.sid + '|' + state.active.index];
          ensureDetail(state.active.sid, state.active.index, true);
          renderDetail();
          return;
        }
        if (act === 'retry-sample' && state.active) {
          delete state.sample[state.active.sid + '|' + state.active.index];
          renderDetail();
          return;
        }
        if (act === 'copy-settings') {
          const rec = state.detail[state.active.sid + '|' + state.active.index];
          if (rec && rec.data) copy(JSON.stringify(rec.data.settings, null, 2), '已复制设置');
          return;
        }
        if (act === 'copy-raw') {
          const rec = state.detail[state.active.sid + '|' + state.active.index];
          if (rec && rec.data) copy(JSON.stringify(rec.data.rawMapping, null, 2), '已复制原始结构');
          return;
        }
        if (act === 'copy-visible-fields') {
          const rec = state.detail[state.active.sid + '|' + state.active.index];
          if (rec && rec.data) {
            const list = filterFields(rec.data.fields, state.fieldFilter, state.fieldType);
            copy(list.map((f) => f.path).join('\n'), '已复制 ' + list.length + ' 个字段名');
          }
          return;
        }
        return;
      }
      const row = e.target.closest('tr[data-act="copy-field"]');
      if (row) copy(row.dataset.path, '已复制字段名');
    });

    // 数据源弹窗
    $('#ds-cancel').addEventListener('click', closeSourceModal);
    $('#ds-save').addEventListener('click', saveForm);
    $('#ds-test').addEventListener('click', testForm);
    $('#ds-auth').addEventListener('change', syncAuthRows);
    $('#ds-mask').addEventListener('click', (e) => { if (e.target === $('#ds-mask')) closeSourceModal(); });
    $('#ds-form').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); saveForm(); }
    });
    // 用户一开始修改表单，就清掉上一次的红色提示
    $('#ds-form').addEventListener('input', () => {
      const box = $('#ds-test-result');
      if (box && box.classList.contains('bad')) { box.className = 'ds-test-result'; box.textContent = ''; }
    });

    // 确认弹窗
    $('#confirm-cancel').addEventListener('click', closeConfirm);
    $('#confirm-ok').addEventListener('click', () => { if (confirmResolve) confirmResolve(); });
    $('#confirm-mask').addEventListener('click', (e) => { if (e.target === $('#confirm-mask')) closeConfirm(); });
    $('#confirm-input').addEventListener('input', (e) => {
      const need = e.target.placeholder;
      $('#confirm-ok').disabled = e.target.value !== need;
    });

    // 令牌弹窗
    $('#token-cancel').addEventListener('click', () => closeTokenModal(false));
    $('#token-save').addEventListener('click', () => closeTokenModal(true));
    $('#token-mask').addEventListener('click', (e) => { if (e.target === $('#token-mask')) closeTokenModal(false); });
    $('#token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') closeTokenModal(true); });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if ($('#ds-mask').classList.contains('show')) closeSourceModal();
      else if ($('#confirm-mask').classList.contains('show')) closeConfirm();
      else if ($('#token-mask').classList.contains('show')) closeTokenModal(false);
    });
  }

  /* ---------------- 启动 ---------------- */
  let bootPromise = null;
  function onShow() {
    if (!bootPromise) {
      bootPromise = boot().catch(() => { bootPromise = null; });
    }
    return bootPromise;
  }
  async function boot() {
    try {
      state.mode = await E.init();
    } catch (e) {
      bootPromise = null;   // 允许下次进入时重试
      const tree = $('#idx-tree');
      if (tree) tree.innerHTML = '<div class="ds-empty">初始化失败：' + esc(e && e.message) + '</div>';
      return;
    }
    const badge = $('#idx-mode-badge');
    if (badge) {
      badge.textContent = state.mode === 'server' ? '服务端代理' : '浏览器直连';
      badge.className = 'mode-badge ' + (state.mode === 'server' ? 'server' : 'direct');
      badge.title = state.mode === 'server'
        ? '请求经由本机 Python 服务代理，凭据不进入浏览器'
        : '直连 Elasticsearch，需要集群开启 CORS；建议用 server.py 启动以避开跨域限制';
    }
    const note = $('#ds-secret-note');
    if (note) {
      note.innerHTML = state.mode === 'server'
        ? '凭据只保存在服务端 <code>data/sources.json</code>，不会下发到浏览器。'
        : '当前为浏览器直连模式，凭据保存在本机 localStorage，请勿在公用电脑使用。';
    }
    await loadSources();

    // 首次进入：展开并自动连接已有数据源
    state.sources.forEach((s) => {
      if (state.expandedSrc[s.id] === undefined) state.expandedSrc[s.id] = true;
      if (!state.conn[s.id]) connect(s.id, true);
    });
    renderTree();
  }

  // 供查询编辑器跳转：切到本视图并定位到指定数据源下的索引
  async function locate(sid, index) {
    await onShow();   // 等数据源真正加载完，避免「进来了但列表还是空」的竞态
    if (!state.sources.some((s) => s.id === sid)) return false;
    selectIndex(sid, index);
    return true;
  }

  window.ESIndexBrowser = { onShow: onShow, locate: locate };

  // 脚本在 body 末尾加载，DOM 已就绪时直接绑定
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  // #index 深链：app.js 的 setTimeout 可能在脚本加载完成前就调用了 switchView，
  // 那时 window.ESIndexBrowser 还不存在而被静默跳过，这里补一次启动。
  if (document.body.classList.contains('view-index')) onShow();
})();
