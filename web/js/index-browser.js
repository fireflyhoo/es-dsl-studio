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
    fieldDefFromRaw, buildMappingBody, rowToDef,
    DATA_OPS, buildDocsQuery,
  } = E;

  /* ---------------- 状态 ---------------- */
  const state = {
    mode: 'direct',
    sources: [],
    conn: {},        // sid -> {status, info, rows, err, at}
    detail: {},      // sid|index -> {data|err}
    pending: {},     // sid|index -> Promise
    docs: {},        // sid|index -> {data|err}（数据 tab 的 _search 结果）
    docsPending: {},
    docsView: {},    // sid|index -> {conds, logic, sort, from, size, sel, checkedAll}
    expandedSrc: {}, // sid -> bool（默认展开）
    expandedIdx: {}, // sid|index -> bool
    active: null,    // {sid, index}
    tab: 'overview',
    filter: '',
    fieldFilter: '',
    fieldType: 'all',
    showSystem: false,
    booted: false,
    // 字段批量编辑器（字段映射页签内联编辑）：{sid, index, rows, sel, err}
    // rows: [{name, type, meta, props, propsOpen}]，sel: {已有字段路径: true}
    batch: null,
  };

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
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>',
    reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',
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

  /* ---------------- 数据 tab（文档查询） ---------------- */
  function docsViewOf(sid, index) {
    const key = sid + '|' + index;
    if (!state.docsView[key]) {
      state.docsView[key] = {
        conds: [{ field: '', op: 'contains', value: '' }],
        logic: 'must',
        sort: null,          // {field, order}
        from: 0,
        size: 20,
        sel: {},             // docId -> true（当前页勾选）
        checkedAll: false,
      };
    }
    return state.docsView[key];
  }

  async function loadDocs(sid, index, resetPage) {
    const key = sid + '|' + index;
    const view = docsViewOf(sid, index);
    if (resetPage) { view.from = 0; view.sel = {}; view.checkedAll = false; }
    if (state.docsPending[key]) return;
    const src = srcOf(sid);
    if (!src) return;
    const body = buildDocsQuery(view);
    const p = (async () => {
      try {
        const data = await transport(src).queryDocs(index, body);
        state.docs[key] = { data: data };
      } catch (e) {
        state.docs[key] = { err: e.message || String(e) };
      } finally {
        delete state.docsPending[key];
        if (state.active && state.active.sid === sid && state.active.index === index && state.tab === 'data') renderDetail();
      }
    })();
    state.docsPending[key] = p;
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
    // 当前选中索引所属的数据源：头部柔和高亮（.ds-node.has-active）
    if (state.active && state.active.sid === src.id) el.classList.add('has-active');

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
        fe.dataset.depth = f.depth;
        fe.style.setProperty('--ind', (10 + f.depth * 14) + 'px');
        fe.title = '点击复制：' + f.path;
        fe.innerHTML = '<span class="fname">' + esc(f.name) + '</span>' + typeBadge(f.type);
        if (f.isContainer) fe.classList.add('is-container');
        if (f.isMultiField) fe.classList.add('is-multi');
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
    dselClose(); // 详情整体重绘，筛选栏下拉浮层先收起（DOM 重建后旧浮层会失效）

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
    else if (state.tab === 'fields') {
      // 批量编辑器打开时，整块替换字段列表（仍在字段映射页签内）
      if (state.batch && state.batch.sid === sel.sid && state.batch.index === sel.index) {
        body.appendChild(renderBatchEditor(data, src));
      } else {
        body.appendChild(renderFields(data));
      }
    }
    else if (state.tab === 'settings') body.appendChild(renderSettings(data));
    else if (state.tab === 'aliases') body.appendChild(renderAliases(data));
    else if (state.tab === 'data') {
      if (!state.docs[key]) { loadDocs(sel.sid, sel.index); body.appendChild(h('div', 'detail-loading', '正在加载数据…')); }
      else body.appendChild(renderData(state.docs[key], sel, data, meta));
    } else if (state.tab === 'raw') body.appendChild(renderRaw(data));
  }

  /* 指标色板：沿用查询构建的子句配色（teal 全文 / blue 词项 / amber 特殊 / violet 聚合 / cyan span / rose 嵌套） */
  const STAT_COLORS = {
    docs: '#0d9488', size: '#2563eb', shards: '#d97706', replicas: '#7c3aed',
    fields: '#0e7490', aliases: '#e11d48',
  };

  function statCard(label, value, hint, color) {
    return '<div class="stat"' + (color ? ' style="--sc:' + color + '"' : '') + '><span class="sk">' + esc(label) + '</span>' +
      '<b>' + esc(value) + '</b>' + (hint ? '<span class="sh">' + esc(hint) + '</span>' : '') + '</div>';
  }

  /* 概览分区标题 */
  function secHead(title, sub) {
    return '<div class="ov-sec-h">' + esc(title) +
      (sub ? '<span class="sub">' + esc(sub) + '</span>' : '') + '</div>';
  }

  function renderOverview(data, meta, src) {
    const box = h('div', 'tab-pane');
    const s = indexSettingsSummary(data.settings);
    box.insertAdjacentHTML('beforeend', secHead('运行指标', '文档 · 存储 · 分片实时统计'));
    const stats = h('div', 'stat-grid');
    stats.innerHTML =
      statCard('文档数', formatCount(meta.docs), '', STAT_COLORS.docs) +
      statCard('存储大小', formatBytes(meta.sizeBytes), '含副本', STAT_COLORS.size) +
      statCard('主分片', String(meta.shards === null || meta.shards === undefined ? s.shards : meta.shards), 'pri', STAT_COLORS.shards) +
      statCard('副本数', String(meta.replicas === null || meta.replicas === undefined ? s.replicas : meta.replicas), 'rep', STAT_COLORS.replicas) +
      statCard('字段数', String(data.fields.length), '含多字段', STAT_COLORS.fields) +
      statCard('别名', String(Object.keys(data.aliases).length), '', STAT_COLORS.aliases);
    box.appendChild(stats);

    box.insertAdjacentHTML('beforeend', secHead('基本信息'));
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
      box.insertAdjacentHTML('beforeend', secHead('字段类型分布', '点击「字段映射」页签查看全部字段'));
      const t = h('div', 'type-summary');
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
      counts.map((c) => '<option value="' + esc(c.type) + '"' + (state.fieldType === c.type ? ' selected' : '') +
        ' data-type="' + esc(c.type) + '">' + esc(c.type) + '（' + c.count + '）</option>').join('');
    const copyBtn = h('button', 'btn sm', ICON.copy + '复制可见字段');
    copyBtn.dataset.act = 'copy-visible-fields';
    const batchBtn = h('button', 'btn sm primary', ICON.edit + '编辑');
    batchBtn.dataset.act = 'batch-edit';
    batchBtn.title = '批量添加 / 编辑字段，保存到当前环境，并可生成同步到其他环境的 DSL';
    bar.appendChild(search);
    bar.appendChild(sel);
    bar.appendChild(copyBtn);
    bar.appendChild(batchBtn);
    upgradeDataSelects(bar); // 原生 select → 自绘下拉
    box.appendChild(bar);

    const list = filterFields(data.fields, state.fieldFilter, state.fieldType);
    const cnt = h('div', 'fields-count', '共 ' + data.fields.length + ' 个字段' + (list.length !== data.fields.length ? '，匹配 ' + list.length + ' 个' : ''));
    box.appendChild(cnt);

    if (!list.length) {
      const empty = h('div', 'tab-empty');
      empty.innerHTML = '<b>没有匹配的字段</b><div>换个关键词，或把类型筛选项调回「全部类型」</div>';
      box.appendChild(empty);
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

      // 树形缩进引导线：每个层级一根淡竖线，代替原来的裸 padding
      const guides = f.depth > 0 ? '<span class="fc-ind">' + '<i></i>'.repeat(f.depth) + '</span>' : '';
      tr.innerHTML =
        '<td class="fc-name">' + guides + '<span class="' +
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
    const spacer = h('span');
    spacer.style.flex = '1';
    const btn = h('button', 'btn sm', '复制 JSON');
    btn.dataset.act = 'copy-settings';
    bar.appendChild(tip);
    bar.appendChild(spacer);
    bar.appendChild(btn);
    box.appendChild(bar);
    box.appendChild(h('pre', 'json-view', highlightJSON(data.settings)));
    return box;
  }

  function renderAliases(data) {
    const box = h('div', 'tab-pane');
    const names = Object.keys(data.aliases);

    const bar = h('div', 'fields-toolbar');
    const cnt = h('span', 'mono dim', '共 ' + names.length + ' 个别名');
    const addBtn = h('button', 'btn sm primary', ICON.plus + '添加别名');
    addBtn.dataset.act = 'add-alias';
    addBtn.title = '给该索引添加别名（PUT _alias）';
    const spacer = h('span');
    spacer.style.flex = '1';
    bar.appendChild(cnt);
    bar.appendChild(spacer);
    bar.appendChild(addBtn);
    box.appendChild(bar);

    if (!names.length) {
      const empty = h('div', 'tab-empty');
      empty.innerHTML = '<b>该索引没有配置别名</b><div>别名可用于灰度切换、只读视图、跨索引检索等场景</div>';
      box.appendChild(empty);
      return box;
    }
    const table = h('table', 'fields-table');
    table.innerHTML = '<thead><tr><th>别名</th><th>过滤条件</th><th>路由</th><th>写索引</th><th style="width:36px"></th></tr></thead>';
    const tbody = h('tbody');
    for (const n of names) {
      const a = data.aliases[n] || {};
      const tr = h('tr');
      const routing = a.routing || a.index_routing || a.search_routing || '';
      tr.innerHTML =
        '<td class="fc-name">' + esc(n) + '</td>' +
        '<td class="fc-meta mono">' + (a.filter ? esc(JSON.stringify(a.filter)) : '—') + '</td>' +
        '<td class="fc-meta mono">' + esc(routing || '—') + '</td>' +
        '<td>' + (a.is_write_index ? '<span class="tag-ro" style="color:#0369a1;border-color:#bae6fd;background:#f0f9ff">写</span>' : '—') + '</td>';
      const td = h('td');
      const del = h('button', 'icon-btn del', '✕');
      del.dataset.act = 'del-alias';
      del.dataset.alias = n;
      del.dataset.sid = state.active ? state.active.sid : '';
      del.dataset.index = state.active ? state.active.index : '';
      del.title = '删除别名 ' + n;
      td.appendChild(del);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
    return box;
  }

  /* ---------------- 数据 tab：列集合与单元格 ---------------- */
  // 列集合：mapping 顶层字段在前，hits 里出现的新 key 追加
  function collectDataCols(data, hits) {
    const cols = [];
    const seen = {};
    for (const f of (data && data.fields) || []) {
      if (f.depth === 0 && !f.isMultiField && !seen[f.path]) { seen[f.path] = 1; cols.push(f.path); }
    }
    for (const it of hits) {
      const s = it._source || {};
      for (const k of Object.keys(s)) {
        if (!seen[k]) { seen[k] = 1; cols.push(k); }
      }
    }
    return cols;
  }

  function dataCellText(v) {
    if (v === undefined || v === null) return { text: '—', full: '', empty: true };
    let text;
    if (typeof v === 'object') text = JSON.stringify(v);
    else text = String(v);
    return { text: text, full: text, empty: false };
  }

  /* ---------------- 数据 tab 渲染 ---------------- */
  function renderData(rec, sel, data, meta) {
    const box = h('div', 'tab-pane data-pane');
    const view = docsViewOf(sel.sid, sel.index);
    const readonlySrc = !!(srcOf(sel.sid) || {}).readonly;

    if (!rec || rec.err) {
      box.appendChild(h('div', 'detail-loading bad', (rec && rec.err) || '查询失败'));
      const retry = h('button', 'btn sm', '重试');
      retry.dataset.act = 'docs-refresh';
      box.appendChild(retry);
      return box;
    }

    const resp = rec.data || {};
    const hitsWrap = resp.hits || {};
    const hits = hitsWrap.hits || [];
    const total = typeof hitsWrap.total === 'object' ? (hitsWrap.total || {}).value : hitsWrap.total;

    box.appendChild(renderDataToolbar(view, data, sel, hits, readonlySrc));

    if (!hits.length) {
      const empty = h('div', 'data-empty');
      const condActive = view.conds.some((c) => c.field && (c.op === 'exists' || String(c.value || '').trim() !== ''));
      empty.innerHTML = condActive
        ? '<b>没有符合条件的记录</b><div>调整筛选条件后重试，或点「重置」清空条件</div>'
        : '<b>该索引暂无文档</b><div>点右上角「+ 添加记录」写入第一条数据</div>';
      box.appendChild(empty);
      return box;
    }

    const cols = collectDataCols(data, hits);
    const selCount = Object.keys(view.sel).length;
    const pageFrom = view.from + 1;
    const pageTo = view.from + hits.length;

    // 状态行
    const status = h('div', 'data-status');
    status.innerHTML =
      '<span>命中 <b>' + formatCount(total) + '</b> 条</span>' +
      '<span class="dim">·</span><span>第 ' + pageFrom + ' - ' + pageTo + ' 条</span>' +
      (view.sort ? '<span class="dim">·</span><span>排序 <span class="mono">' + esc(view.sort.field) + '</span> ' + (view.sort.order === 'asc' ? '↑' : '↓') + '</span>' : '') +
      '<span class="data-sel-count"' + (selCount ? '' : ' hidden') + '>已选 ' + selCount + ' 条</span>' +
      '<span style="flex:1"></span>' +
      (readonlySrc ? '<span class="data-ro" title="该数据源为只读模式">只读</span>' : '');
    box.appendChild(status);

    // 表格
    const table = h('table', 'fields-table data-table');
    const headCells = ['<th class="data-cell-check"><input type="checkbox" data-act="docs-check-all"' + (view.checkedAll ? ' checked' : '') + ' title="全选 / 取消本页"></th>',
      '<th class="data-cell-id">_id</th>'];
    for (const c of cols) {
      const sorted = view.sort && view.sort.field === c;
      const arrow = sorted ? (view.sort.order === 'asc' ? ' ↑' : ' ↓') : '';
      headCells.push('<th data-act="docs-sort" data-field="' + esc(c) + '" class="data-col-head' + (sorted ? ' is-sorted' : '') + '" title="点击排序：' + esc(c) + '">' +
        '<span>' + esc(c) + '</span><span class="data-sort-arrow">' + arrow + '</span></th>');
    }
    headCells.push('<th class="data-cell-ops" style="width:64px">操作</th>');
    table.innerHTML = '<thead><tr>' + headCells.join('') + '</tr></thead>';

    const tbody = h('tbody');
    hits.forEach((it) => {
      const tr = h('tr', 'data-row');
      tr.dataset.id = it._id;
      const checked = !!view.sel[it._id];
      if (checked) tr.classList.add('is-checked');
      const cells = ['<td class="data-cell-check"><input type="checkbox" data-act="docs-check" data-id="' + esc(it._id) + '"' + (checked ? ' checked' : '') + '></td>',
        '<td class="data-cell-id mono" title="' + esc(it._id) + '">' + esc(it._id.length > 24 ? it._id.slice(0, 24) + '…' : it._id) + '</td>'];
      for (const c of cols) {
        const cell = dataCellText((it._source || {})[c]);
        const cls = cell.empty ? 'data-cell is-empty' : 'data-cell';
        const shown = cell.text.length > 120 ? cell.text.slice(0, 120) + '…' : cell.text;
        cells.push('<td class="' + cls + ' mono" title="' + esc(cell.full.slice(0, 500)) + '">' + esc(shown) + '</td>');
      }
      cells.push(
        '<td class="data-cell-ops">' +
        '<button class="icon-btn" data-act="docs-edit-doc" data-id="' + esc(it._id) + '" title="编辑这条记录">' + ICON.edit + '</button>' +
        '<button class="icon-btn del" data-act="docs-del-doc" data-id="' + esc(it._id) + '" title="删除这条记录">' + ICON.trash + '</button>' +
        '</td>'
      );
      tr.innerHTML = cells.join('');
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    box.appendChild(table);

    // 分页
    const pages = Math.max(1, Math.ceil((total || 0) / view.size));
    const page = Math.floor(view.from / view.size) + 1;
    const pager = h('div', 'data-pager');
    const prev = h('button', 'btn sm', '‹ 上一页');
    prev.dataset.act = 'docs-page';
    prev.dataset.dir = 'prev';
    prev.disabled = view.from <= 0;
    const next = h('button', 'btn sm', '下一页 ›');
    next.dataset.act = 'docs-page';
    next.dataset.dir = 'next';
    next.disabled = page >= pages;
    pager.appendChild(prev);
    pager.appendChild(h('span', 'data-page-info mono', '第 ' + page + ' / ' + pages + ' 页'));
    pager.appendChild(next);
    box.appendChild(pager);
    return box;
  }

  /* ---------------- 筛选栏自绘下拉（替代原生 select 弹层） ----------------
     原生 select 仍留在 DOM 里（视觉隐藏）当数据载体，所有既有 change 事件链路不变；
     触发器按钮 + fs-pop 浮层负责展示与交互，选中后同步回隐藏 select 并派发 change。
     renderDetail 会重建工具栏 DOM，浮层跟随失效，故每次重绘工具栏先关旧浮层再升级新 select。 */
  const DSEL_SELECTOR = 'select.data-cond-field, select.data-cond-op, select.data-logic, select.data-size, select#fld-type, select.doc-bool';
  let dselPop = null; // { pop, wrap, sel, btn, items }

  function dselItems(sel) {
    return Array.prototype.map.call(sel.options, (o) => ({
      value: o.value,
      label: o.textContent,
      sel: o.selected,
      type: o.dataset.type || '',
    }));
  }

  function dselClose() {
    if (!dselPop) return;
    dselPop.pop.remove();
    dselPop.wrap.classList.remove('open');
    window.removeEventListener('scroll', dselPosition, true);
    window.removeEventListener('resize', dselPosition);
    document.removeEventListener('mousedown', dselOutside, true);
    document.removeEventListener('keydown', dselKey, true);
    dselPop = null;
  }

  function dselOutside(e) {
    if (!dselPop) return;
    if (dselPop.pop.contains(e.target)) return;
    if (dselPop.wrap.contains(e.target)) return;
    dselClose();
  }

  function dselPosition() {
    if (!dselPop) return;
    const r = dselPop.btn.getBoundingClientRect();
    const w = Math.max(r.width, 132);
    dselPop.pop.style.width = w + 'px';
    const h = dselPop.pop.offsetHeight || 220;
    let top = r.bottom + 5;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 5);
    dselPop.pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - w)) + 'px';
    dselPop.pop.style.top = top + 'px';
  }

  function dselRender() {
    if (!dselPop) return;
    dselPop.items = dselItems(dselPop.sel);
    if (!dselPop.items.length) {
      dselPop.pop.innerHTML = '<div class="fs-empty">没有可选项</div>';
      dselPosition();
      return;
    }
    dselPop.pop.innerHTML = dselPop.items.map((it, i) =>
      '<button type="button" class="fs-item dsel-item' + (it.sel ? ' on' : '') + '" data-i="' + i + '" title="' + esc(it.label) + '">' +
      '<span class="dsel-check' + (it.sel ? ' on' : '') + '"></span>' +
      '<span class="fs-path' + (it.value === '' ? ' dim' : '') + '">' + esc(it.label) + '</span>' +
      (it.type ? typeBadge(it.type) : '') +
      '</button>').join('');
    dselPosition();
  }

  function dselPick(i) {
    if (!dselPop || !dselPop.items[i]) return;
    const it = dselPop.items[i];
    const sel = dselPop.sel;
    if (sel.value === it.value) { dselClose(); return; }
    sel.value = it.value;
    // 先同步触发器文案再收起（dselClose 后 dselPop 引用即失效）
    const o = sel.options[sel.selectedIndex];
    const label = o ? o.textContent : '';
    dselPop.btn.querySelector('.dsel-val').textContent = label;
    dselPop.btn.classList.toggle('is-empty', !sel.value);
    dselPop.btn.title = label;
    dselClose();
    // 走既有 change 链路（改条件 / 改每页条数 / 改逻辑关系都会触发重绘或重查）
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function dselMoveActive(delta) {
    if (!dselPop) return;
    const items = dselPop.pop.querySelectorAll('.fs-item');
    const n = items.length;
    if (!n) return;
    let idx = -1;
    items.forEach((node, i) => { if (node.classList.contains('kbon')) idx = i; });
    dselHighlight(delta > 0 ? (idx + 1) % n : (idx - 1 + n) % n);
  }

  function dselKey(e) {
    if (!dselPop) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      dselMoveActive(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cur = dselPop.pop.querySelector('.fs-item.kbon');
      if (cur) dselPick(Number(cur.dataset.i));
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      dselClose();
    }
  }

  function dselHighlight(i) {
    if (!dselPop) return;
    const items = dselPop.pop.querySelectorAll('.fs-item');
    items.forEach((node, idx) => node.classList.toggle('kbon', idx === i));
    if (items[i]) items[i].scrollIntoView({ block: 'nearest' });
  }

  function dselOpen(wrap) {
    const sel = wrap.querySelector('select');
    const btn = wrap.querySelector('.dsel-btn');
    if (!sel || !btn) return;
    if (dselPop && dselPop.wrap === wrap) { dselClose(); return; }
    dselClose();
    const pop = h('div', 'fs-pop dsel-pop');
    pop.addEventListener('mousedown', (e) => {
      e.preventDefault(); // 抢在 blur / 重绘之前，点选稳定生效
      const item = e.target.closest('.fs-item');
      if (item) dselPick(Number(item.dataset.i));
    });
    document.body.appendChild(pop);
    dselPop = { pop: pop, wrap: wrap, sel: sel, btn: btn, items: [] };
    wrap.classList.add('open');
    window.addEventListener('scroll', dselPosition, true);
    window.addEventListener('resize', dselPosition);
    document.addEventListener('mousedown', dselOutside, true);
    document.addEventListener('keydown', dselKey, true);
    dselRender();
    // 默认高亮当前选中项（无选中则第一项）
    const selIdx = dselPop.items.findIndex((it) => it.sel);
    dselHighlight(selIdx >= 0 ? selIdx : 0);
  }

  // 把容器里的目标 select 升级为自绘下拉（幂等：已包 .dsel 的跳过）
  function upgradeDataSelects(root) {
    (root || document).querySelectorAll(DSEL_SELECTOR).forEach((sel) => {
      if (sel.parentElement && sel.parentElement.classList.contains('dsel')) return;
      const kind = sel.id === 'fld-type' ? 'type' :
        (sel.classList.contains('data-cond-field') ? 'field' :
          (sel.classList.contains('data-cond-op') ? 'op' :
            (sel.classList.contains('data-logic') ? 'logic' :
              (sel.classList.contains('doc-bool') ? 'bool' : 'size'))));
      const wrap = document.createElement('span');
      wrap.className = 'dsel';
      wrap.dataset.kind = kind;
      sel.parentNode.insertBefore(wrap, sel);
      wrap.appendChild(sel);
      const btn = h('button', 'dsel-btn');
      btn.type = 'button';
      btn.innerHTML = '<span class="dsel-val"></span>' + ICON.chevron;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dselOpen(wrap);
      });
      wrap.appendChild(btn);
      const o = sel.options[sel.selectedIndex];
      btn.querySelector('.dsel-val').textContent = o ? o.textContent : '';
      btn.classList.toggle('is-empty', !sel.value);
      btn.title = o ? o.textContent : '';
    });
  }

  function renderDataToolbar(view, data, sel, hits, readonlySrc) {
    dselClose(); // 工具栏将重建，先收掉可能开着的浮层
    const bar = h('div', 'data-toolbar');

    // 筛选条件区
    const conds = h('div', 'data-conds');
    const cols = collectDataCols(data, hits);
    // 字段路径 → 类型（用于下拉浮层里的类型徽标）
    const typeMap = {};
    for (const f of (data && data.fields) || []) {
      if (f.depth === 0 && !f.isMultiField && !typeMap[f.path]) typeMap[f.path] = f.type;
    }
    const optionsHtml = (cur) => '<option value="">选择字段…</option>' + cols.map((c) =>
      '<option value="' + esc(c) + '"' + (c === cur ? ' selected' : '') +
      (typeMap[c] ? ' data-type="' + esc(typeMap[c]) + '"' : '') + '>' + esc(c) + '</option>').join('');
    const opsHtml = (cur) => DATA_OPS.map(([v, label]) =>
      '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + label + '</option>').join('');

    view.conds.forEach((c, i) => {
      const row = h('div', 'data-cond');
      row.dataset.i = String(i);
      const fsel = h('select', 'data-cond-field', optionsHtml(c.field));
      fsel.dataset.i = String(i);
      const osel = h('select', 'data-cond-op', opsHtml(c.op));
      osel.dataset.i = String(i);
      const vin = h('input', 'data-cond-val');
      vin.dataset.i = String(i);
      vin.value = c.value || '';
      vin.placeholder = c.op === 'exists' ? '（无需填值）' : '值';
      vin.disabled = c.op === 'exists';
      row.appendChild(fsel);
      row.appendChild(osel);
      row.appendChild(vin);
      if (view.conds.length > 1) {
        const x = h('button', 'data-cond-x', '✕');
        x.dataset.act = 'docs-del-cond';
        x.dataset.i = String(i);
        x.title = '删除这个条件';
        row.appendChild(x);
      }
      conds.appendChild(row);
    });
    bar.appendChild(conds);

    // 条件操作区
    const condActs = h('div', 'data-cond-acts');
    const addCond = h('button', 'btn sm', ICON.plus + '条件');
    addCond.dataset.act = 'docs-add-cond';
    addCond.title = '添加一个筛选条件';
    condActs.appendChild(addCond);
    if (view.conds.length > 1) {
      const logic = h('select', 'data-logic');
      logic.id = 'docs-logic';
      logic.title = '多个条件之间的逻辑关系';
      logic.innerHTML = '<option value="must"' + (view.logic === 'must' ? ' selected' : '') + '>并且（AND）</option>' +
        '<option value="should"' + (view.logic === 'should' ? ' selected' : '') + '>或者（OR）</option>';
      condActs.appendChild(logic);
    }
    const qBtn = h('button', 'btn sm primary', ICON.search + '查询');
    qBtn.dataset.act = 'docs-query';
    qBtn.title = '按当前条件重新查询';
    condActs.appendChild(qBtn);
    const resetBtn = h('button', 'btn sm', ICON.reset + '重置');
    resetBtn.dataset.act = 'docs-reset';
    resetBtn.title = '清空筛选条件与排序';
    condActs.appendChild(resetBtn);
    bar.appendChild(condActs);

    // 右侧动作区
    const acts = h('div', 'data-acts');
    const refresh = h('button', 'btn sm', ICON.refresh + '刷新');
    refresh.dataset.act = 'docs-refresh';
    refresh.title = '重新执行当前查询';
    acts.appendChild(refresh);

    const sizeSel = h('select', 'data-size');
    sizeSel.id = 'docs-size';
    sizeSel.title = '每页条数';
    [10, 20, 50, 100].forEach((n) => {
      const o = document.createElement('option');
      o.value = String(n);
      o.textContent = n + ' 条/页';
      if (n === view.size) o.selected = true;
      sizeSel.appendChild(o);
    });
    acts.appendChild(sizeSel);

    if (!readonlySrc) {
      const addBtn = h('button', 'btn sm primary', ICON.plus + '添加记录');
      addBtn.dataset.act = 'docs-add';
      addBtn.title = '向该索引写入一条新文档';
      acts.appendChild(addBtn);

      const selCount = Object.keys(view.sel).length;
      const delBtn = h('button', 'btn sm danger', ICON.trash + '删除选中' + (selCount ? '（' + selCount + '）' : ''));
      delBtn.dataset.act = 'docs-del-selected';
      delBtn.disabled = !selCount;
      delBtn.title = selCount ? '删除勾选的 ' + selCount + ' 条记录' : '先在表格里勾选记录';
      acts.appendChild(delBtn);
    }
    bar.appendChild(acts);
    upgradeDataSelects(bar); // 原生 select → 自绘下拉
    return bar;
  }

  // 勾选状态变化后局部刷新（不重绘整表，保持滚动位置与输入焦点）
  function syncDataSelUI() {
    const sel = state.active;
    if (!sel || state.tab !== 'data') return;
    const view = docsViewOf(sel.sid, sel.index);
    const ids = Object.keys(view.sel);
    const rows = document.querySelectorAll('#idx-body .data-row');
    rows.forEach((tr) => {
      const on = !!view.sel[tr.dataset.id];
      tr.classList.toggle('is-checked', on);
      const cb = tr.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = on;
    });
    const allCb = document.querySelector('#idx-body input[data-act="docs-check-all"]');
    if (allCb) allCb.checked = ids.length > 0 && ids.length === rows.length;
    const delBtn = document.querySelector('#idx-body button[data-act="docs-del-selected"]');
    if (delBtn) {
      delBtn.disabled = !ids.length;
      delBtn.textContent = '删除选中' + (ids.length ? '（' + ids.length + '）' : '');
    }
    const cnt = document.querySelector('#idx-body .data-sel-count');
    if (cnt) {
      cnt.textContent = '已选 ' + ids.length + ' 条';
      cnt.hidden = !ids.length;
    }
  }

  function renderRaw(data) {
    const box = h('div', 'tab-pane');
    const bar = h('div', 'fields-toolbar');
    const btn = h('button', 'btn sm', '复制原始响应');
    btn.dataset.act = 'copy-raw';
    const spacer = h('span');
    spacer.style.flex = '1';
    bar.appendChild(h('span', 'mono dim', 'mapping 原始结构（未扁平化）'));
    bar.appendChild(spacer);
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
    state.batch = null; // 切换索引时退出批量编辑，避免把改动写到别的索引上
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

  /* ---------------- 别名管理 ---------------- */
  function aliasFormError(msg, focusSel) {
    const box = $('#alias-err');
    if (box) { box.className = 'ds-test-result bad'; box.textContent = msg; }
    if (focusSel) { const el = $(focusSel); if (el) el.focus(); }
  }

  function openAliasModal() {
    if (!state.active) { toast('请先选择一个索引'); return; }
    const src = srcOf(state.active.sid);
    if (src && src.readonly) { toast('该数据源处于只读模式'); return; }
    $('#alias-title').textContent = '添加别名 · ' + state.active.index;
    $('#alias-target-note').textContent = 'PUT /' + state.active.index + '/_alias/{别名}';
    $('#alias-name').value = '';
    $('#alias-routing').value = '';
    $('#alias-index-routing').value = '';
    $('#alias-search-routing').value = '';
    $('#alias-write').checked = false;
    $('#alias-filter').value = '';
    $('#alias-err').className = 'ds-test-result';
    $('#alias-err').textContent = '';
    $('#alias-mask').classList.add('show');
    setTimeout(() => $('#alias-name').focus(), 40);
  }

  function closeAliasModal() {
    $('#alias-mask').classList.remove('show');
  }

  async function saveAlias() {
    if (!state.active) return;
    const sid = state.active.sid;
    const index = state.active.index;
    const src = srcOf(sid);
    if (!src) return;
    if (src.readonly) { aliasFormError('该数据源处于只读模式，禁止添加别名'); return; }

    const name = $('#alias-name').value.trim();
    if (!name) { aliasFormError('请填写别名', '#alias-name'); return; }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
      aliasFormError('别名只能用小写字母 / 数字 / _ - .，且须以字母或数字开头', '#alias-name'); return;
    }
    const rec = state.detail[sid + '|' + index];
    if (rec && rec.data && rec.data.aliases[name]) { aliasFormError('该别名已存在', '#alias-name'); return; }

    // 空值不写入，保持请求体干净（用 ES 默认行为）
    const body = {};
    const routing = $('#alias-routing').value.trim();
    if (routing) body.routing = routing;
    const indexRouting = $('#alias-index-routing').value.trim();
    if (indexRouting) body.index_routing = indexRouting;
    const searchRouting = $('#alias-search-routing').value.trim();
    if (searchRouting) body.search_routing = searchRouting;
    if ($('#alias-write').checked) body.is_write_index = true;
    const rawFilter = $('#alias-filter').value.trim();
    if (rawFilter) {
      let filter;
      try { filter = JSON.parse(rawFilter); }
      catch (e) { aliasFormError('过滤条件 JSON 解析失败：' + e.message, '#alias-filter'); return; }
      if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
        aliasFormError('过滤条件必须是一个 JSON 对象', '#alias-filter'); return;
      }
      body.filter = filter;
    }

    const btn = $('#alias-save');
    btn.disabled = true;
    try {
      await transport(src).addAlias(index, name, body);
      closeAliasModal();
      delete state.detail[sid + '|' + index]; // 清缓存，重新拉取别名
      await ensureDetail(sid, index, true);
      renderDetail();
      toast('已添加别名 ' + name);
    } catch (e) {
      if (e.kind === 'auth') { closeAliasModal(); openTokenModal(() => saveAlias()); }
      else aliasFormError(e.message || String(e));
    } finally {
      btn.disabled = false;
    }
  }

  function removeAliasFlow(sid, index, alias) {
    const src = srcOf(sid);
    if (src && src.readonly) { toast('该数据源处于只读模式'); return; }
    confirmDialog({
      title: '删除别名',
      desc: '将删除索引 <b class="mono">' + esc(index) + '</b> 上的别名 <b class="mono">' + esc(alias) + '</b>。<br>' +
        '通过该别名的查询 / 写入将不再可用，<b>索引本身与数据不受影响</b>。',
      okText: '删除别名',
      danger: true,
      onOk: async () => {
        const src2 = srcOf(sid);
        await transport(src2).removeAlias(index, alias);
        delete state.detail[sid + '|' + index];
        await ensureDetail(sid, index, true);
        renderDetail();
        toast('已删除别名 ' + alias);
      },
    });
  }

  /* ---------------- 新建索引 ---------------- */
  function esIndexNameError(name) {
    if (!name) return '请填写索引名';
    if (name !== name.toLowerCase()) return '索引名必须全小写（ES 不允许大写）';
    if ('-_+'.indexOf(name[0]) !== -1) return '索引名不能以 -、_、+ 开头';
    if (!/^[a-z0-9][a-z0-9\-_+.]*$/.test(name)) return '只能包含小写字母、数字、-、_、+、.';
    if (utf8Len(name) > 255) return '索引名过长（最多 255 字节）';
    if (['.', '..'].indexOf(name) !== -1) return '索引名不能是 . 或 ..';
    return '';
  }
  // 索引名长度限制按 UTF-8 字节算
  function utf8Len(s) {
    return new TextEncoder().encode(s).length;
  }

  function ixFormError(msg, focusSel) {
    const box = $('#ix-err');
    if (box) { box.className = 'ds-test-result bad'; box.textContent = msg; }
    if (focusSel) { const el = $(focusSel); if (el) el.focus(); }
  }

  function openCreateIndexModal() {
    if (!state.sources.length) { toast('请先添加数据源'); return; }
    // 目标数据源：当前选中索引所属 > 第一个数据源
    const prefer = (state.active && srcOf(state.active.sid)) || state.sources[0];
    const sel = $('#ix-source');
    sel.innerHTML = state.sources.map((s) =>
      '<option value="' + esc(s.id) + '"' + (s.id === prefer.id ? ' selected' : '') + '>' +
      esc(s.name + ' · ' + hostOf(s.url)) + '</option>').join('');
    $('#ix-name').value = '';
    $('#ix-shards').value = '1';
    $('#ix-replicas').value = '1';
    $('#ix-body').value = '';
    $('#ix-err').className = 'ds-test-result';
    $('#ix-err').textContent = '';
    $('#ix-mask').classList.add('show');
    setTimeout(() => $('#ix-name').focus(), 40);
  }

  function closeCreateIndexModal() {
    $('#ix-mask').classList.remove('show');
  }

  async function saveCreateIndex() {
    const src = srcOf($('#ix-source').value);
    if (!src) return;
    if (src.readonly) { ixFormError('该数据源处于只读模式，禁止创建索引'); return; }
    const name = $('#ix-name').value.trim();
    const nameErr = esIndexNameError(name);
    if (nameErr) { ixFormError(nameErr, '#ix-name'); return; }

    // 索引体：高级 JSON 优先，否则用分片 / 副本数值生成 settings
    let body = null;
    const rawJson = $('#ix-body').value.trim();
    if (rawJson) {
      try { body = JSON.parse(rawJson); }
      catch (e) { ixFormError('索引体 JSON 解析失败：' + e.message, '#ix-body'); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        ixFormError('索引体必须是一个 JSON 对象', '#ix-body'); return;
      }
    } else {
      const shards = Math.max(1, Math.min(64, parseInt($('#ix-shards').value, 10) || 1));
      const replicas = Math.max(0, Math.min(10, parseInt($('#ix-replicas').value, 10) || 0));
      body = { settings: { number_of_shards: shards, number_of_replicas: replicas } };
    }

    // 高级 JSON 里带了 mappings.properties：把字段书写顺序记进 _meta.studioFieldOrder
    // （ES 的 _mapping 不保留创建顺序，之后「添加记录」表单按它还原）
    if (body.mappings && body.mappings.properties &&
        typeof body.mappings.properties === 'object' && !Array.isArray(body.mappings.properties)) {
      body.mappings._meta = Object.assign({}, body.mappings._meta, {
        studioFieldOrder: Object.keys(body.mappings.properties),
      });
    }

    const btn = $('#ix-save');
    btn.disabled = true;
    try {
      await transport(src).create(name, body);
      closeCreateIndexModal();
      state.expandedSrc[src.id] = true;
      await connect(src.id, true);
      selectIndex(src.id, name); // 自动选中新索引，方便接着加字段
      toast('已创建索引 ' + name);
    } catch (e) {
      if (e.kind === 'auth') { closeCreateIndexModal(); openTokenModal(() => saveCreateIndex()); }
      else ixFormError(e.message || String(e));
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------------- 批量字段编辑 + 索引变更 DSL ---------------- */
  const FIELD_TYPES = [
    ['keyword', 'keyword（精确值 / 聚合 / 排序）'],
    ['text', 'text（全文检索，需分词）'],
    ['long', 'long（整数）'],
    ['integer', 'integer（整数）'],
    ['short', 'short（整数）'],
    ['double', 'double（小数）'],
    ['float', 'float（小数）'],
    ['boolean', 'boolean（布尔）'],
    ['date', 'date（日期时间）'],
    ['ip', 'ip（IP 地址）'],
    ['object', 'object（对象，含子字段）'],
    ['nested', 'nested（对象数组）'],
    ['geo_point', 'geo_point（经纬度坐标）'],
  ];

  function emptyRow() {
    return { name: '', type: 'keyword', meta: '', props: '', propsOpen: false, err: '' };
  }

  function metaPlaceholder(type) {
    if (type === 'text') return '分词器，如 standard / ik_max_word';
    if (type === 'date') return '格式，如 yyyy-MM-dd HH:mm:ss||epoch_millis';
    if (type === 'keyword') return 'normalizer（可选），如 lowercase';
    return '该类型一般无需填写';
  }

  function openBatchEditor() {
    if (!state.active) { toast('请先选择一个索引'); return; }
    state.batch = {
      sid: state.active.sid,
      index: state.active.index,
      rows: [emptyRow()],
      sel: {},
      err: '',
      saving: false,
    };
    renderDetail();
  }

  function closeBatchEditor() {
    state.batch = null;
    renderDetail();
  }

  // 已有字段里可勾选的顶层字段（多字段属于父字段定义，不单独列出）
  function selectableFields(data) {
    return (data.fields || []).filter((f) => f.depth === 0 && !f.isMultiField);
  }

  function selCount() {
    if (!state.batch) return 0;
    return Object.keys(state.batch.sel).filter((k) => state.batch.sel[k]).length;
  }

  function renderNewRow(row) {
    const wrap = h('div', 'be-row');
    if (row.propsOpen) wrap.classList.add('open');

    const main = h('div', 'be-row-main');
    const nameInput = h('input', 'be-input be-name mono');
    nameInput.type = 'text';
    nameInput.placeholder = '字段名，如 customer_name';
    nameInput.value = row.name;
    nameInput.spellcheck = false;
    nameInput.autocomplete = 'off';
    nameInput.addEventListener('input', () => { row.name = nameInput.value; });

    const typeSel = h('select', 'be-input be-type');
    typeSel.innerHTML = FIELD_TYPES.map(([v, label]) =>
      '<option value="' + v + '"' + (row.type === v ? ' selected' : '') + '>' + esc(label) + '</option>').join('');

    const metaInput = h('input', 'be-input be-meta mono');
    metaInput.type = 'text';
    metaInput.placeholder = metaPlaceholder(row.type);
    metaInput.value = row.meta;
    metaInput.spellcheck = false;
    metaInput.autocomplete = 'off';
    typeSel.addEventListener('change', () => {
      row.type = typeSel.value;
      metaInput.placeholder = metaPlaceholder(row.type);
    });
    metaInput.addEventListener('input', () => { row.meta = metaInput.value; });

    const propsBtn = h('button', 'icon-btn', '⚙');
    propsBtn.title = '高级属性 JSON（analyzer / format / fields 等）';
    propsBtn.dataset.act = 'be-props';

    const delBtn = h('button', 'icon-btn del', '✕');
    delBtn.title = '删除该行';
    delBtn.dataset.act = 'be-del-row';

    main.appendChild(nameInput);
    main.appendChild(typeSel);
    main.appendChild(metaInput);
    main.appendChild(propsBtn);
    main.appendChild(delBtn);
    wrap.appendChild(main);

    if (row.err) {
      wrap.appendChild(h('div', 'be-row-err', esc(row.err)));
    }
    if (row.propsOpen) {
      const propsBox = h('div', 'be-props-box');
      const ta = h('textarea', 'be-input mono');
      ta.rows = 3;
      ta.spellcheck = false;
      ta.placeholder = '{ "index": false } 或 { "fields": { "kw": { "type": "keyword" } } }';
      ta.value = row.props;
      ta.addEventListener('input', () => { row.props = ta.value; });
      propsBox.appendChild(ta);
      wrap.appendChild(propsBox);
    }
    return wrap;
  }

  function renderBatchEditor(data, src) {
    const box = h('div', 'tab-pane batch-editor');
    const readonly = !!(src && src.readonly);

    // ---- 头部 ----
    const head = h('div', 'be-head');
    head.innerHTML =
      '<div class="be-title">' + ICON.edit + '<span>批量字段编辑</span></div>' +
      '<div class="be-target mono">' + esc(state.batch.index) + (src ? ' · ' + esc(src.name) : '') + '</div>';
    const exitBtn = h('button', 'btn sm', '退出编辑');
    exitBtn.dataset.act = 'batch-close';
    head.appendChild(exitBtn);
    box.appendChild(head);

    if (state.batch.err) {
      box.appendChild(h('div', 'detail-error', '<b>操作失败</b><div>' + esc(state.batch.err) + '</div>'));
    }

    // ---- 已有字段（勾选纳入 DSL） ----
    const existing = selectableFields(data);
    const sec1 = h('div', 'be-sec');
    const sec1h = h('div', 'be-sec-h');
    sec1h.innerHTML = '<span class="be-sec-t">已有字段</span>' +
      '<span class="be-sec-sub">勾选后纳入 DSL，用于同步到其他环境</span><span style="flex:1"></span>' +
      '<span class="be-sel-count" id="be-sel-count">' + (selCount() ? '已选 ' + selCount() + ' 个' : '') + '</span>';
    const allBtn = h('button', 'btn sm', '全选');
    allBtn.dataset.act = 'be-sel-all';
    const noneBtn = h('button', 'btn sm', '全不选');
    noneBtn.dataset.act = 'be-sel-none';
    sec1h.appendChild(allBtn);
    sec1h.appendChild(noneBtn);
    sec1.appendChild(sec1h);

    if (!existing.length) {
      sec1.appendChild(h('div', 'be-empty', '该索引暂无字段'));
    } else {
      const tbl = h('table', 'fields-table be-existing');
      tbl.innerHTML = '<thead><tr><th class="be-col-chk"></th><th>字段</th><th>类型</th><th>分词器 / 格式</th></tr></thead>';
      const tb = h('tbody');
      for (const f of existing) {
        const tr = h('tr');
        const chk = h('input', 'be-chk');
        chk.type = 'checkbox';
        chk.checked = !!state.batch.sel[f.path];
        chk.title = '勾选后纳入 DSL';
        chk.addEventListener('change', () => {
          if (chk.checked) state.batch.sel[f.path] = true;
          else delete state.batch.sel[f.path];
          const c = $('#be-sel-count');
          if (c) c.textContent = selCount() ? '已选 ' + selCount() + ' 个' : '';
        });
        const tdChk = h('td', 'be-col-chk');
        tdChk.appendChild(chk);
        tr.appendChild(tdChk);
        tr.appendChild(h('td', 'fc-name mono', esc(f.path)));
        const tdType = h('td');
        tdType.innerHTML = typeBadge(f.type);
        tr.appendChild(tdType);
        tr.appendChild(h('td', 'fc-meta mono', esc(f.analyzer || f.format || '—')));
        tb.appendChild(tr);
      }
      tbl.appendChild(tb);
      sec1.appendChild(tbl);
    }
    box.appendChild(sec1);

    // ---- 新增字段 ----
    const sec2 = h('div', 'be-sec');
    const sec2h = h('div', 'be-sec-h');
    sec2h.innerHTML = '<span class="be-sec-t">新增字段</span>' +
      '<span class="be-sec-sub">保存后写入 ' + esc(state.batch.index) + '（UAT 改结构 → 生成 DSL → 线上执行）</span><span style="flex:1"></span>';
    const addRowBtn = h('button', 'btn sm', '+ 添加一行');
    addRowBtn.dataset.act = 'be-add-row';
    sec2h.appendChild(addRowBtn);
    sec2.appendChild(sec2h);

    const rowsWrap = h('div', 'be-rows');
    state.batch.rows.forEach((row) => rowsWrap.appendChild(renderNewRow(row)));
    sec2.appendChild(rowsWrap);
    box.appendChild(sec2);

    // ---- 底部操作 ----
    const foot = h('div', 'be-foot');
    const cancelBtn = h('button', 'btn', '取消');
    cancelBtn.dataset.act = 'batch-close';
    const dslBtn = h('button', 'btn', '生成 DSL');
    dslBtn.dataset.act = 'batch-dsl';
    dslBtn.title = '勾选的已有字段 + 下方新增字段，生成 PUT _mapping 语句';
    const saveBtn = h('button', 'btn primary', state.batch.saving ? '保存中…' : '保存到当前环境');
    saveBtn.dataset.act = 'batch-save';
    saveBtn.title = readonly ? '该数据源处于只读模式，仅支持生成 DSL' : '把下方新增字段一次性写入当前环境';
    if (readonly || state.batch.saving) saveBtn.disabled = true;
    foot.appendChild(cancelBtn);
    foot.appendChild(h('span', 'be-foot-spacer'));
    foot.appendChild(dslBtn);
    foot.appendChild(saveBtn);
    box.appendChild(foot);

    box.appendChild(h('div', 'form-note be-note', readonly
      ? '只读数据源：不能写入，但可以勾选字段生成 DSL，拿到其他环境执行。'
      : '已有字段的类型不可修改（ES 限制），如需变更请新建索引并 reindex。「分词器 / 格式」列按类型对应 analyzer / format / normalizer，更多属性点行尾 ⚙ 填 JSON。'));
    return box;
  }

  // 汇总字段条目：勾选的已有字段（取原始定义）+ 填写完整的新增行
  function collectBatchEntries() {
    const batch = state.batch;
    const rec = state.detail[batch.sid + '|' + batch.index];
    const data = rec && rec.data ? rec.data : { fields: [], rawMapping: {} };
    const existingPaths = {};
    for (const f of data.fields) existingPaths[f.path] = true;

    const entries = [];
    const rowErrors = [];

    for (const path of Object.keys(batch.sel)) {
      if (!batch.sel[path]) continue;
      const def = fieldDefFromRaw(data.rawMapping, path);
      if (def) entries.push({ path: path, def: def, from: 'existing' });
    }

    const seen = {};
    batch.rows.forEach((row, i) => {
      const filled = row.name.trim() || row.type !== 'keyword' || row.meta.trim() || row.props.trim();
      const r = rowToDef(row);
      if (!r.ok) {
        if (filled) rowErrors.push({ idx: i, error: r.error });
        return;
      }
      const name = row.name.trim();
      if (seen[name]) { rowErrors.push({ idx: i, error: '字段名重复：' + name }); return; }
      if (existingPaths[name]) { rowErrors.push({ idx: i, error: '字段已存在：' + name }); return; }
      seen[name] = 1;
      entries.push({ path: name, def: r.def, from: 'new' });
    });
    return { entries: entries, rowErrors: rowErrors };
  }

  async function saveBatch() {
    const batch = state.batch;
    if (!batch) return;
    const src = srcOf(batch.sid);
    if (!src) return;
    if (src.readonly) { toast('该数据源处于只读模式'); return; }

    const { entries, rowErrors } = collectBatchEntries();
    batch.rows.forEach((r) => { r.err = ''; });
    for (const re of rowErrors) batch.rows[re.idx].err = re.error;
    const newEntries = entries.filter((e) => e.from === 'new');
    if (rowErrors.length || !newEntries.length) {
      batch.err = '';
      renderDetail();
      toast(rowErrors.length ? rowErrors[0].error : '请至少填写一个新增字段');
      return;
    }

    batch.saving = true;
    renderDetail();
    try {
      await transport(src).putMapping(batch.index, buildMappingBody(newEntries));
      // ES 的 _mapping 不保留字段顺序（按字母返回）——把创建顺序写进 _meta.studioFieldOrder，
      // 供「数据 → 添加记录」表单按创建顺序展示。注意 ES 更新 _meta 是整份替换，需先合并旧值
      try {
        const key0 = batch.sid + '|' + batch.index;
        const oldRec = state.detail[key0];
        const oldMeta = (oldRec && oldRec.data && oldRec.data.rawMapping && oldRec.data.rawMapping._meta) || {};
        const prevOrder = Array.isArray(oldMeta.studioFieldOrder) ? oldMeta.studioFieldOrder : [];
        const added = newEntries.map((e) => e.path).filter((p) => prevOrder.indexOf(p) === -1);
        if (added.length) {
          await transport(src).putMapping(batch.index, {
            _meta: Object.assign({}, oldMeta, { studioFieldOrder: prevOrder.concat(added) }),
          });
        }
      } catch (me) { /* _meta 写入失败不影响字段已保存，顺序回退为字母序 */ }
      // 新字段并入「已有字段」并默认勾选，方便紧接着生成 DSL 同步到其他环境
      for (const e of newEntries) batch.sel[e.path] = true;
      batch.rows = [emptyRow()];
      batch.err = '';
      delete state.detail[batch.sid + '|' + batch.index];
      await ensureDetail(batch.sid, batch.index, true);
      renderDetail();
      syncBridge();
      toast('已保存 ' + newEntries.length + ' 个字段，可点「生成 DSL」同步到其他环境');
      focusFirstName();
    } catch (e) {
      if (e.kind === 'auth') openTokenModal(() => saveBatch());
      else { batch.err = e.message || String(e); }
    } finally {
      batch.saving = false;
      renderDetail();
    }
  }

  // 焦点落到最后一个新增行的字段名输入框（保存后 / 添加一行后接着录）
  function focusFirstName() {
    setTimeout(() => {
      const els = document.querySelectorAll('.be-row .be-name');
      if (els.length) els[els.length - 1].focus();
    }, 0);
  }

  /* ---------------- 索引变更 DSL 弹窗 ---------------- */
  let dslState = null; // {index, entries: [{path, def, from}], src}

  function openDslModal() {
    const batch = state.batch;
    if (!batch) return;
    const { entries, rowErrors } = collectBatchEntries();
    if (rowErrors.length) { toast(rowErrors[0].error); return; }
    if (!entries.length) { toast('请先勾选已有字段，或填写新增字段'); return; }
    dslState = { index: batch.index, entries: entries, src: srcOf(batch.sid) };
    renderDslModal();
    $('#dsl-mask').classList.add('show');
  }

  function closeDslModal() {
    $('#dsl-mask').classList.remove('show');
    dslState = null;
  }

  function dslBody() {
    return buildMappingBody(dslState.entries);
  }

  function dslRequestLine() {
    return 'PUT /' + dslState.index + '/_mapping';
  }

  function dslCurl() {
    const src = dslState.src || {};
    const base = String(src.url || 'http://localhost:9200').replace(/\/+$/, '');
    return 'curl -X PUT "' + base + '/' + dslState.index + '/_mapping" \\\n' +
      "  -H 'Content-Type: application/json' \\\n" +
      "  -d '" + JSON.stringify(dslBody()) + "'";
  }

  function renderDslModal() {
    $('#dsl-title-index').textContent = dslState.index;
    $('#dsl-req').textContent = dslRequestLine();
    $('#dsl-body').innerHTML = highlightJSON(dslBody());
    $('#dsl-count').textContent = '共 ' + dslState.entries.length + ' 个字段';

    const chips = $('#dsl-chips');
    chips.innerHTML = '';
    dslState.entries.forEach((e, i) => {
      const chip = h('span', 'dsl-chip' + (e.from === 'new' ? ' is-new' : ''));
      chip.title = e.path + (e.from === 'new' ? '（新增，尚未保存）' : '（已有字段）');
      chip.innerHTML = '<span class="mono">' + esc(e.path) + '</span>';
      const x = h('button', 'chip-x', '✕');
      x.title = '从本次语句中移除';
      x.addEventListener('click', () => {
        dslState.entries.splice(i, 1);
        if (!dslState.entries.length) { closeDslModal(); toast('已移除全部字段'); return; }
        renderDslModal();
      });
      chip.appendChild(x);
      chips.appendChild(chip);
    });
  }

  /* ---------------- 记录编辑弹窗（添加 / 编辑文档） ---------------- */
  let docModal = null; // {mode:'create'|'edit', sid, index, docId, fields, jsonMode, source}

  function docErr(msg) {
    const box = $('#doc-err');
    if (box) { box.className = 'ds-test-result bad'; box.textContent = msg; }
  }
  function clearDocErr() {
    const box = $('#doc-err');
    if (box) { box.className = 'ds-test-result'; box.textContent = ''; }
  }

  // 顶层字段 + 输入控件类型
  const DOC_NUMERIC_TYPES = ['integer', 'long', 'short', 'byte', 'float', 'double', 'half_float', 'scaled_float'];
  function docInputKind(type) {
    if (type === 'object' || type === 'nested') return 'json';
    if (type === 'boolean') return 'bool';
    if (DOC_NUMERIC_TYPES.indexOf(type) !== -1) return 'number';
    return 'text';
  }

  function docFieldRow(f, value) {
    const kind = docInputKind(f.type);
    const row = h('div', 'doc-field');
    row.dataset.path = f.path;
    row.dataset.kind = kind;
    const label = h('label', 'doc-field-label');
    label.innerHTML = '<span class="mono">' + esc(f.path) + '</span>' + typeBadge(f.type) +
      (kind === 'json' ? '<span class="doc-json-tag">JSON</span>' : '');
    row.appendChild(label);

    let input;
    if (kind === 'json') {
      input = document.createElement('textarea');
      input.className = 'doc-input doc-input-json mono';
      input.rows = 3;
      input.spellcheck = false;
      input.value = value !== undefined && value !== null && typeof value === 'object' ? JSON.stringify(value, null, 2) : '';
      input.placeholder = '{ "key": "value" }';
    } else if (kind === 'bool') {
      input = document.createElement('select');
      input.className = 'doc-input doc-bool';
      input.innerHTML = '<option value="">（不设置）</option><option value="true"' + (value === true ? ' selected' : '') + '>true</option>' +
        '<option value="false"' + (value === false ? ' selected' : '') + '>false</option>';
    } else if (kind === 'number') {
      input = document.createElement('input');
      input.className = 'doc-input mono';
      input.type = 'number';
      input.step = 'any';
      input.value = value !== undefined && value !== null ? String(value) : '';
    } else {
      input = document.createElement('input');
      input.className = 'doc-input';
      input.type = f.type === 'date' ? 'text' : 'text';
      input.value = value !== undefined && value !== null ? String(value) : '';
      input.placeholder = f.type === 'date' ? '如 2026-10-25' : '';
    }
    row.appendChild(input);
    return row;
  }

  function openDocModal(mode, doc) {
    dselClose(); // 弹窗将重建表单，先收掉可能开着的浮层
    const sel = state.active;
    if (!sel) return;
    const key = sel.sid + '|' + sel.index;
    const rec = state.detail[key];
    const fields = E.sortFieldsByOrder(
      ((rec && rec.data && rec.data.fields) || []).filter((f) => f.depth === 0 && !f.isMultiField),
      rec && rec.data && rec.data.rawMapping && rec.data.rawMapping._meta && rec.data.rawMapping._meta.studioFieldOrder
    );
    const source = doc && doc._source ? doc._source : {};

    docModal = {
      mode: mode,
      sid: sel.sid,
      index: sel.index,
      docId: doc ? doc._id : '',
      fields: fields,
      jsonMode: false,
    };

    $('#doc-modal-title').textContent = mode === 'create' ? '添加记录' : '编辑记录';
    $('#doc-modal-index').textContent = sel.index;
    clearDocErr();

    // 文档 ID：新建可填（留空自动生成），编辑时锁定
    const idInput = $('#doc-id');
    idInput.value = mode === 'edit' ? (doc._id || '') : '';
    idInput.disabled = mode === 'edit';
    $('#doc-id-label').style.opacity = mode === 'edit' ? '.55' : '';

    // 表单模式：按 mapping 生成输入行
    const pane = $('#doc-fields');
    pane.innerHTML = '';
    if (!fields.length) {
      pane.appendChild(h('div', 'form-note', '该索引没有已定义的顶层字段（动态映射索引），请切换到 JSON 模式直接编写文档。'));
    }
    for (const f of fields) {
      pane.appendChild(docFieldRow(f, source[f.path]));
    }
    // 布尔字段下拉升级为自绘下拉（与筛选栏 / 字段映射页同款）
    upgradeDataSelects(pane);

    // JSON 模式：整体文档
    $('#doc-json').value = JSON.stringify(mode === 'edit' ? source : {}, null, 2);

    setDocMode('form');
    $('#doc-save').disabled = false;
    $('#doc-save').textContent = mode === 'create' ? '添加' : '保存修改';
    $('#doc-mask').classList.add('show');
    setTimeout(() => {
      const first = $('#doc-fields .doc-input');
      if (first) first.focus();
    }, 60);
  }

  function setDocMode(mode) {
    if (!docModal) return;
    docModal.jsonMode = mode === 'json';
    $('#doc-form-pane').hidden = docModal.jsonMode;
    $('#doc-json-pane').hidden = !docModal.jsonMode;
    document.querySelectorAll('#doc-mode-switch button').forEach((b) => {
      b.classList.toggle('on', b.dataset.mode === mode);
    });
  }

  function collectDocFromForm() {
    const doc = {};
    let bad = null;
    document.querySelectorAll('#doc-fields .doc-field').forEach((row) => {
      if (bad) return;
      const path = row.dataset.path;
      const kind = row.dataset.kind;
      const el = row.querySelector('.doc-input');
      if (kind === 'json') {
        const raw = el.value.trim();
        if (!raw) return;
        try { doc[path] = JSON.parse(raw); } catch (e) { bad = '字段 ' + path + ' 不是合法 JSON：' + e.message; }
      } else if (kind === 'number') {
        const raw = el.value.trim();
        if (raw === '') return;
        const n = Number(raw);
        if (Number.isNaN(n)) { bad = '字段 ' + path + ' 需要填写数字'; return; }
        doc[path] = n;
      } else if (kind === 'bool') {
        if (el.value === '') return;
        doc[path] = el.value === 'true';
      } else {
        if (el.value.trim() === '') return;
        doc[path] = el.value;
      }
    });
    return { doc: doc, bad: bad };
  }

  async function saveDocFlow() {
    const m = docModal;
    if (!m) return;
    clearDocErr();
    let doc;
    if (m.jsonMode) {
      try { doc = JSON.parse($('#doc-json').value); } catch (e) { docErr('JSON 解析失败：' + e.message); return; }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) { docErr('文档必须是一个 JSON 对象'); return; }
    } else {
      const r = collectDocFromForm();
      if (r.bad) { docErr(r.bad); return; }
      doc = r.doc;
    }
    if (!Object.keys(doc).length) { docErr('至少填写一个字段'); return; }

    const src = srcOf(m.sid);
    if (!src) return;
    const btn = $('#doc-save');
    btn.disabled = true;
    try {
      if (m.mode === 'create') {
        const id = $('#doc-id').value.trim();
        await transport(src).createDoc(m.index, doc, id);
        toast('已添加记录' + (id ? '（_id：' + id + '）' : ''));
      } else {
        await transport(src).replaceDoc(m.index, m.docId, doc);
        toast('已保存修改（_id：' + m.docId + '）');
      }
      closeDocModal();
      // 文档数会变：强制刷新 detail + 重新查询当前页
      ensureDetail(m.sid, m.index, true);
      loadDocs(m.sid, m.index);
    } catch (e) {
      if (e.kind === 'auth') openTokenModal(() => saveDocFlow());
      else docErr(e.message || String(e));
    } finally {
      btn.disabled = false;
    }
  }

  function closeDocModal() {
    dselClose(); // 收掉可能开着的下拉浮层
    $('#doc-mask').classList.remove('show');
    docModal = null;
  }

  // 从表格行打开编辑弹窗
  function openDocEditById(docId) {
    const sel = state.active;
    if (!sel) return;
    const rec = state.docs[sel.sid + '|' + sel.index];
    const hits = (rec && rec.data && rec.data.hits && rec.data.hits.hits) || [];
    const hit = hits.find((x) => x._id === docId);
    if (!hit) { toast('该记录已不在当前页，请刷新后重试'); return; }
    openDocModal('edit', hit);
  }

  function deleteDocsFlow(sid, index, ids) {
    const src = srcOf(sid);
    if (src && src.readonly) { toast('该数据源处于只读模式'); return; }
    if (!ids.length) return;
    confirmDialog({
      title: ids.length > 1 ? '删除 ' + ids.length + ' 条记录' : '删除记录',
      desc: '将从索引 <b class="mono">' + esc(index) + '</b> 永久删除' +
        (ids.length > 1 ? '这 ' + ids.length + ' 条记录' : '这条记录') +
        (ids.length <= 3 ? '：<div class="mono dim confirm-id-list">' + ids.map(esc).join('<br>') + '</div>' : '') +
        '，此操作不可撤销。',
      okText: '永久删除',
      danger: true,
      onOk: async () => {
        const src2 = srcOf(sid);
        for (const id of ids) {
          await transport(src2).deleteDoc(index, id);
        }
        delete state.docs[sid + '|' + index];
        ensureDetail(sid, index, true);
        loadDocs(sid, index);
        toast('已删除 ' + ids.length + ' 条记录');
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
    $('#btn-add-idx').addEventListener('click', openCreateIndexModal);
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
        delete state.docs[sid + '|' + index];
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
        return;
      }
      // 数据 tab：筛选条件输入实时同步到 state（不重渲染，避免打断输入）
      if (e.target.classList && e.target.classList.contains('data-cond-val') && state.active) {
        const v = docsViewOf(state.active.sid, state.active.index);
        const i = parseInt(e.target.dataset.i, 10);
        if (!Number.isNaN(i) && v.conds[i]) v.conds[i].value = e.target.value;
      }
    });
    $('#idx-body').addEventListener('change', (e) => {
      if (e.target.id === 'fld-type') {
        state.fieldType = e.target.value;
        renderDetail();
        return;
      }
      // 数据 tab：条件字段 / 操作符 / 逻辑 / 每页条数 / 勾选
      if (state.active && state.tab === 'data') {
        const v = docsViewOf(state.active.sid, state.active.index);
        const t = e.target;
        if (t.classList && t.classList.contains('data-cond-field')) {
          const i = parseInt(t.dataset.i, 10);
          if (!Number.isNaN(i) && v.conds[i]) v.conds[i].field = t.value;
        } else if (t.classList && t.classList.contains('data-cond-op')) {
          const i = parseInt(t.dataset.i, 10);
          if (!Number.isNaN(i) && v.conds[i]) {
            v.conds[i].op = t.value;
            renderDetail(); // exists 无需填值：切换后更新输入框禁用态
          }
        } else if (t.id === 'docs-logic') {
          v.logic = t.value;
        } else if (t.id === 'docs-size') {
          v.size = parseInt(t.value, 10) || 20;
          v.from = 0;
          v.sel = {};
          v.checkedAll = false;
          loadDocs(state.active.sid, state.active.index, false);
        } else if (t.dataset && t.dataset.act === 'docs-check') {
          if (t.checked) v.sel[t.dataset.id] = true; else delete v.sel[t.dataset.id];
          syncDataSelUI();
        } else if (t.dataset && t.dataset.act === 'docs-check-all') {
          v.sel = {};
          if (t.checked) {
            document.querySelectorAll('#idx-body .data-row').forEach((tr) => { v.sel[tr.dataset.id] = true; });
          }
          syncDataSelUI();
        }
      }
    });
    $('#idx-body').addEventListener('click', (e) => {
      // 数据行双击 → 编辑记录（renderDetail 会重建 DOM，用 detail 判定代替 dblclick 事件）
      const dataRow = e.target.closest('.data-row');
      if (dataRow && e.detail >= 2 && !e.target.closest('button, input, select, label, a')) {
        openDocEditById(dataRow.dataset.id);
        return;
      }
      const btn = e.target.closest('[data-act]');
      if (btn) {
        const act = btn.dataset.act;
        if (act === 'copy-field') { copy(btn.dataset.path, '已复制字段名'); return; }
        if (act === 'add-alias') { openAliasModal(); return; }
        if (act === 'del-alias') {
          removeAliasFlow(btn.dataset.sid, btn.dataset.index, btn.dataset.alias);
          return;
        }
        if (act === 'batch-edit') { openBatchEditor(); return; }
        if (act === 'batch-close') { closeBatchEditor(); return; }
        if (act === 'batch-save') { saveBatch(); return; }
        if (act === 'batch-dsl') { openDslModal(); return; }
        if (act === 'be-add-row' && state.batch) {
          state.batch.rows.push(emptyRow());
          renderDetail();
          focusFirstName();
          return;
        }
        if (act === 'be-del-row' && state.batch) {
          const rowEl = btn.closest('.be-row');
          const rows = Array.prototype.slice.call(document.querySelectorAll('.be-rows .be-row'));
          const i = rows.indexOf(rowEl);
          if (i >= 0) state.batch.rows.splice(i, 1);
          if (!state.batch.rows.length) state.batch.rows.push(emptyRow());
          renderDetail();
          return;
        }
        if (act === 'be-props' && state.batch) {
          const rowEl = btn.closest('.be-row');
          const rows = Array.prototype.slice.call(document.querySelectorAll('.be-rows .be-row'));
          const i = rows.indexOf(rowEl);
          if (i >= 0 && state.batch.rows[i]) {
            state.batch.rows[i].propsOpen = !state.batch.rows[i].propsOpen;
            renderDetail();
          }
          return;
        }
        if (act === 'be-sel-all' && state.batch) {
          const rec = state.detail[state.batch.sid + '|' + state.batch.index];
          if (rec && rec.data) for (const f of selectableFields(rec.data)) state.batch.sel[f.path] = true;
          renderDetail();
          return;
        }
        if (act === 'be-sel-none' && state.batch) {
          state.batch.sel = {};
          renderDetail();
          return;
        }
        if (act === 'retry-detail' && state.active) {
          delete state.detail[state.active.sid + '|' + state.active.index];
          ensureDetail(state.active.sid, state.active.index, true);
          renderDetail();
          return;
        }
        if (act === 'docs-refresh' && state.active) {
          delete state.docs[state.active.sid + '|' + state.active.index];
          loadDocs(state.active.sid, state.active.index);
          renderDetail();
          return;
        }
        if (act === 'docs-query' && state.active) {
          loadDocs(state.active.sid, state.active.index, true);
          return;
        }
        if (act === 'docs-reset' && state.active) {
          const v = docsViewOf(state.active.sid, state.active.index);
          v.conds = [{ field: '', op: 'contains', value: '' }];
          v.logic = 'must';
          v.sort = null;
          v.from = 0;
          v.sel = {};
          v.checkedAll = false;
          loadDocs(state.active.sid, state.active.index, false);
          renderDetail();
          return;
        }
        if (act === 'docs-add-cond' && state.active) {
          const v = docsViewOf(state.active.sid, state.active.index);
          v.conds.push({ field: '', op: 'contains', value: '' });
          renderDetail();
          return;
        }
        if (act === 'docs-del-cond' && state.active) {
          const v = docsViewOf(state.active.sid, state.active.index);
          const i = parseInt(btn.dataset.i, 10);
          if (!Number.isNaN(i) && v.conds.length > 1) v.conds.splice(i, 1);
          renderDetail();
          return;
        }
        if (act === 'docs-add' && state.active) {
          const src = srcOf(state.active.sid);
          if (src && src.readonly) { toast('该数据源处于只读模式'); return; }
          openDocModal('create');
          return;
        }
        if (act === 'docs-edit-doc') { openDocEditById(btn.dataset.id); return; }
        if (act === 'docs-del-doc' && state.active) {
          deleteDocsFlow(state.active.sid, state.active.index, [btn.dataset.id]);
          return;
        }
        if (act === 'docs-del-selected' && state.active) {
          const v = docsViewOf(state.active.sid, state.active.index);
          const ids = Object.keys(v.sel);
          if (!ids.length) { toast('先勾选要删除的记录'); return; }
          deleteDocsFlow(state.active.sid, state.active.index, ids);
          return;
        }
        if (act === 'docs-page' && state.active) {
          const v = docsViewOf(state.active.sid, state.active.index);
          if (btn.dataset.dir === 'prev') v.from = Math.max(0, v.from - v.size);
          else v.from = v.from + v.size;
          v.sel = {};
          v.checkedAll = false;
          loadDocs(state.active.sid, state.active.index, false);
          return;
        }
        if (act === 'docs-sort' && state.active) {
          const v = docsViewOf(state.active.sid, state.active.index);
          const f = btn.dataset.field;
          if (v.sort && v.sort.field === f) {
            v.sort = v.sort.order === 'asc' ? { field: f, order: 'desc' } : null;
          } else {
            v.sort = { field: f, order: 'asc' };
          }
          v.from = 0;
          loadDocs(state.active.sid, state.active.index, false);
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

    // 新建索引弹窗
    $('#ix-cancel').addEventListener('click', closeCreateIndexModal);
    $('#ix-save').addEventListener('click', saveCreateIndex);
    $('#ix-mask').addEventListener('click', (e) => { if (e.target === $('#ix-mask')) closeCreateIndexModal(); });
    $('#ix-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveCreateIndex(); }
    });
    $('#ix-form').addEventListener('input', () => {
      const box = $('#ix-err');
      if (box && box.classList.contains('bad')) { box.className = 'ds-test-result'; box.textContent = ''; }
    });

    // 添加别名弹窗
    $('#alias-cancel').addEventListener('click', closeAliasModal);
    $('#alias-save').addEventListener('click', saveAlias);
    $('#alias-mask').addEventListener('click', (e) => { if (e.target === $('#alias-mask')) closeAliasModal(); });
    $('#alias-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveAlias(); }
    });
    $('#alias-form').addEventListener('input', () => {
      const box = $('#alias-err');
      if (box && box.classList.contains('bad')) { box.className = 'ds-test-result'; box.textContent = ''; }
    });

    // 索引变更 DSL 弹窗
    $('#dsl-copy-req').addEventListener('click', () => { if (dslState) copy(dslRequestLine(), '已复制请求行'); });
    $('#dsl-copy-json').addEventListener('click', () => { if (dslState) copy(JSON.stringify(dslBody(), null, 2), '已复制 JSON'); });
    $('#dsl-copy-curl').addEventListener('click', () => { if (dslState) copy(dslCurl(), '已复制 curl 命令'); });
    $('#dsl-done').addEventListener('click', closeDslModal);
    $('#dsl-close').addEventListener('click', closeDslModal);
    $('#dsl-mask').addEventListener('click', (e) => { if (e.target === $('#dsl-mask')) closeDslModal(); });

    // 记录编辑弹窗（数据 tab）
    $('#doc-cancel').addEventListener('click', closeDocModal);
    $('#doc-save').addEventListener('click', () => saveDocFlow());
    $('#doc-mask').addEventListener('click', (e) => { if (e.target === $('#doc-mask')) closeDocModal(); });
    $('#doc-mode-switch').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-mode]');
      if (b) setDocMode(b.dataset.mode);
    });
    // JSON 模式 / 文档 ID 输入框：Ctrl|Cmd+Enter 直接保存
    $('#doc-json').addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveDocFlow(); }
    });
    $('#doc-id').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveDocFlow(); }
    });
    // 表单输入时清除错误提示
    $('#doc-mask').addEventListener('input', () => clearDocErr());

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
      if ($('#doc-mask').classList.contains('show')) closeDocModal();
      else if ($('#dsl-mask').classList.contains('show')) closeDslModal();
      else if ($('#alias-mask').classList.contains('show')) closeAliasModal();
      else if ($('#ds-mask').classList.contains('show')) closeSourceModal();
      else if ($('#ix-mask').classList.contains('show')) closeCreateIndexModal();
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
