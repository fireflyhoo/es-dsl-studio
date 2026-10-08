/* ============================================================
 * ES DSL Studio - 界面逻辑
 * 元素库 / 拖拽 / 查询树 / 属性检查器 / JSON 预览与导入导出
 * ============================================================ */
(function () {
  'use strict';
  const { CATS, CATMAP, DEFS, mkNode, gen, importNode, validate, isEmpty } = window.ESQ;

  /* ---------------- 状态 ---------------- */
  let root = null;
  let selectedId = null;
  let settings = { size: '10', from: '', track_total_hits: 'true', min_score: '' };
  let paletteFilter = '';
  const collapsedCats = {};

  /* ---------------- DOM ---------------- */
  const $ = (s) => document.querySelector(s);
  const treeEl = $('#tree');
  const paletteEl = $('#palette-list');
  const inspectorEl = $('#inspector');
  const jsonOutEl = $('#json-out');
  const jsonWarnEl = $('#json-warn');
  const statusEl = $('#statusbar');

  /* ---------------- 小工具 ---------------- */
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  /* ---------------- 持久化 ---------------- */
  function save() {
    try {
      localStorage.setItem('esdsl.v1', JSON.stringify({ root, settings }));
    } catch (e) { /* 忽略配额错误 */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem('esdsl.v1');
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (data.settings) settings = Object.assign(settings, data.settings);
      if (data.root) { root = data.root; return true; }
    } catch (e) { /* 损坏则忽略 */ }
    return false;
  }

  /* ---------------- 树操作 ---------------- */
  function find(id, node, parent, key, index) {
    node = node === undefined ? root : node;
    parent = parent === undefined ? null : parent;
    key = key === undefined ? null : key;
    index = index === undefined ? -1 : index;
    if (!node) return null;
    if (node.id === id) return { node, parent, key, index };
    const d = DEFS[node.type];
    if (d.slots) {
      for (const s of d.slots) {
        const arr = node.kids[s.key] || [];
        for (let i = 0; i < arr.length; i++) {
          const r = find(id, arr[i], node, s.key, i);
          if (r) return r;
        }
      }
    } else if (d.listKids) {
      for (let i = 0; i < node.kids.length; i++) {
        const r = find(id, node.kids[i], node, 'list', i);
        if (r) return r;
      }
    }
    return null;
  }
  function selected() { return selectedId ? (find(selectedId) || {}).node || null : null; }
  function inSubtree(ancestor, id) {
    if (!ancestor) return false;
    if (ancestor.id === id) return true;
    const d = DEFS[ancestor.type];
    const kids = d.slots ? d.slots.flatMap((s) => ancestor.kids[s.key] || []) : (d.listKids ? ancestor.kids : []);
    return kids.some((k) => inSubtree(k, id));
  }
  function kidsArrayOf(loc) {
    if (!loc.parent) return null;
    return loc.key === 'list' ? loc.parent.kids : loc.parent.kids[loc.key];
  }
  function cloneNode(n) {
    const c = JSON.parse(JSON.stringify(n));
    (function reid(x) {
      x.id = window.ESQ.uid();
      const d = DEFS[x.type];
      const kids = d.slots ? d.slots.flatMap((s) => x.kids[s.key] || []) : (d.listKids ? x.kids : []);
      kids.forEach(reid);
    })(c);
    return c;
  }
  function countNodes(n) {
    if (!n) return 0;
    const d = DEFS[n.type];
    const kids = d.slots ? d.slots.flatMap((s) => n.kids[s.key] || []) : (d.listKids ? n.kids : []);
    return 1 + kids.reduce((a, k) => a + countNodes(k), 0);
  }

  // 类型是否能放进槽位
  function slotAccepts(slot, type) {
    const cat = DEFS[type].cat;
    if (slot.accept === 'fn') return cat === 'fn';
    return cat !== 'fn';
  }

  // 向父节点容器添加子节点（key: 槽位 key 或 'list'；index 可选）
  function insertChild(parent, key, child, index) {
    const d = DEFS[parent.type];
    if (key === 'list') {
      if (index === undefined) parent.kids.push(child);
      else parent.kids.splice(index, 0, child);
      return true;
    }
    const slot = (d.slots || []).find((s) => s.key === key);
    if (!slot) return false;
    if (!slotAccepts(slot, child.type)) {
      toast(slot.accept === 'fn' ? '该槽位只接受评分函数' : '评分函数只能放进 function_score 的 functions 槽位');
      return false;
    }
    const arr = parent.kids[key];
    if (!slot.multi) {
      if (arr.length) toast(key + ' 槽位只容纳一个查询，已替换');
      arr.splice(0, arr.length, child);
    } else if (index === undefined) arr.push(child);
    else arr.splice(index, 0, child);
    return true;
  }

  function detach(id) {
    const loc = find(id);
    if (!loc) return null;
    if (!loc.parent) { root = null; return loc.node; }
    kidsArrayOf(loc).splice(loc.index, 1);
    return loc.node;
  }

  function deleteNode(id) {
    const loc = find(id);
    if (!loc) return;
    detach(id);
    if (selectedId && !find(selectedId)) selectedId = null;
    renderAll();
    toast('已删除 ' + loc.node.type);
  }

  function duplicateNode(id) {
    const loc = find(id);
    if (!loc) return;
    const copy = cloneNode(loc.node);
    if (!loc.parent) { toast('根节点请先拖入组合查询，或包一层 bool'); return; }
    kidsArrayOf(loc).splice(loc.index + 1, 0, copy);
    selectedId = copy.id;
    renderAll();
  }

  function wrapBool(id) {
    const loc = find(id);
    if (!loc) return;
    const b = mkNode('bool');
    const node = detach(id);
    b.kids.must.push(node);
    if (!loc.parent) root = b;
    else kidsArrayOf(loc).splice(loc.index, 0, b);
    selectedId = b.id;
    renderAll();
    toast('已包一层 bool');
  }

  // 找容器节点中第一个能容纳该类型的槽位
  function firstSlotFor(parent, type) {
    const d = DEFS[parent.type];
    if (d.listKids) return { key: 'list', multi: true };
    return (d.slots || []).find((s) => slotAccepts(s, type) && (s.multi || !(parent.kids[s.key] || []).length)) || null;
  }

  // 拖拽落点处理。zone: {kind:'slot',pid,key} | {kind:'before',id} | {kind:'root'}
  // 约定：落到容器节点头上 = 加入其第一个可用槽位；落到叶子节点头上 = 插到它前面。
  function dropAt(zone, payloadKind, payload) {
    const nodeType = payloadKind === 'type' ? payload : (find(payload) || {}).node && (find(payload) || {}).node.type;
    if (!nodeType) return;

    /* ---- 预检（在 detach 之前，失败零副作用） ---- */
    if (payloadKind === 'node') {
      const dragLoc = find(payload);
      if (!dragLoc) return;
      if (payload === (zone.id || zone.pid)) return; // 拖到自己身上
      if (zone.kind === 'root' && dragLoc.node === root) return; // 根拖到画布
      const targetId = zone.id || zone.pid;
      if (targetId && inSubtree(dragLoc.node, targetId)) { toast('不能拖进自己的子节点里'); return; }
    }

    let parent = null, slot = null, insertIdx = -1;
    if (zone.kind === 'slot') {
      parent = (find(zone.pid) || {}).node;
      if (!parent) return;
      slot = zone.key === 'list' ? { key: 'list', multi: true }
        : Object.assign({}, (DEFS[parent.type].slots || []).find((s) => s.key === zone.key) || {});
      slot.key = zone.key;
    } else if (zone.kind === 'before') {
      const loc = find(zone.id);
      if (!loc) return;
      const td = DEFS[loc.node.type];
      if (td.slots || td.listKids) {
        // 容器：加入其第一个可用槽位
        parent = loc.node;
        slot = firstSlotFor(parent, nodeType);
        if (!slot) { toast('该节点没有可用的槽位'); return; }
      } else if (loc.parent) {
        // 叶子：插到它前面
        parent = loc.parent;
        slot = loc.key === 'list' ? { key: 'list', multi: true }
          : Object.assign({}, DEFS[loc.parent.type].slots.find((s) => s.key === loc.key) || {});
        slot.key = loc.key;
        insertIdx = loc.index;
      }
      // loc 为根且不是容器 -> 走 root 逻辑（包 bool）
    }

    if (slot && !slotAccepts(slot, nodeType)) {
      toast(slot.accept === 'fn' ? '该槽位只接受评分函数' : '评分函数只能放进 function_score 的 functions 槽位');
      return;
    }
    if (payloadKind === 'type' && DEFS[nodeType].cat === 'fn' && !(slot && slot.accept === 'fn')) {
      toast('评分函数请拖到 function_score 的 functions 槽位');
      return;
    }

    /* ---- 执行 ---- */
    let node;
    if (payloadKind === 'type') node = mkNode(payload);
    else node = detach(payload);

    if (parent && slot) {
      const d = DEFS[parent.type];
      if (slot.key === 'list') {
        if (insertIdx === -1) parent.kids.push(node);
        else parent.kids.splice(insertIdx, 0, node);
      } else {
        const arr = parent.kids[slot.key];
        if (!slot.multi) {
          if (arr.length) toast(slot.key + ' 槽位只容纳一个查询，已替换');
          arr.splice(0, arr.length, node);
        } else if (insertIdx === -1) arr.push(node);
        else arr.splice(insertIdx, 0, node);
      }
    } else {
      // root：空画布直接当根；已有根则包 bool
      if (!root) root = node;
      else {
        const b = mkNode('bool');
        b.kids.must.push(root, node);
        root = b;
        toast('已自动用 bool 组合两个根查询');
      }
    }
    if (selectedId && !find(selectedId)) selectedId = null;
    selectedId = node.id;
    renderAll();
  }

  // 点击元素库 "+"：智能放置
  function quickAdd(type) {
    const d = DEFS[type];
    if (d.cat === 'fn') {
      const sel = selected();
      if (sel && sel.type === 'function_score') {
        const n = mkNode(type);
        sel.kids.functions.push(n);
        selectedId = n.id;
        renderAll();
      } else toast('请先选中一个 function_score 节点，再添加评分函数');
      return;
    }
    const n = mkNode(type);
    if (!root) { root = n; selectedId = n.id; renderAll(); return; }
    const sel = selected();
    if (sel) {
      const sd = DEFS[sel.type];
      if (sd.slots) {
        const slot = sd.slots.find((s) => slotAccepts(s, type) && (s.multi || !(sel.kids[s.key] || []).length));
        if (slot) { insertChild(sel, slot.key, n); selectedId = n.id; renderAll(); return; }
      } else if (sd.listKids) {
        sel.kids.push(n); selectedId = n.id; renderAll(); return;
      }
      // 叶子节点：作为同级插到它后面
      const loc = find(sel.id);
      if (loc && loc.parent) {
        const slot = loc.key === 'list' ? { multi: true } : DEFS[loc.parent.type].slots.find((s) => s.key === loc.key);
        if (slot.multi && slotAccepts(slot, type)) {
          kidsArrayOf(loc).splice(loc.index + 1, 0, n);
          selectedId = n.id; renderAll(); return;
        }
      }
    }
    // 兜底：包 bool
    const b = mkNode('bool');
    b.kids.must.push(root, n);
    root = b;
    selectedId = n.id;
    renderAll();
    toast('已自动用 bool 组合到根部');
  }

  /* ---------------- 示例 ---------------- */
  function sampleTree() {
    const b = mkNode('bool');
    b.params.minimum_should_match = '1';
    const m = mkNode('match');
    m.params.field = 'title'; m.params.query = '智能手机'; m.params.operator = 'AND';
    const mp = mkNode('match_phrase');
    mp.params.field = 'desc'; mp.params.query = '超长续航'; mp.params.boost = '2';
    const t = mkNode('term');
    t.params.field = 'status'; t.params.value = '1';
    const r = mkNode('range');
    r.params.field = 'price'; r.params.gte = '1000'; r.params.lte = '5000';
    const gd = mkNode('geo_distance');
    gd.params.field = 'location'; gd.params.location = '31.23, 121.47'; gd.params.distance = '10km';
    b.kids.must.push(m);
    b.kids.should.push(mp);
    b.kids.filter.push(t, r, gd);
    return b;
  }

  /* ---------------- 元素库渲染 ---------------- */
  function renderPalette() {
    paletteEl.innerHTML = '';
    const kw = paletteFilter.trim().toLowerCase();
    for (const cat of CATS) {
      const items = Object.values(DEFS).filter((d) => d.cat === cat.id && (!kw ||
        d.type.toLowerCase().includes(kw) || d.cn.toLowerCase().includes(kw) || (d.desc || '').toLowerCase().includes(kw)));
      if (!items.length) continue;
      const box = el('div', 'pcat');
      box.style.setProperty('--c', cat.color);
      const h = el('div', 'pcat-h', `<span class="dot"></span>${esc(cat.label)}<span class="cnt">${items.length}</span>`);
      box.appendChild(h);
      if (!collapsedCats[cat.id]) {
        for (const d of items) {
          const it = el('div', 'pitem');
          it.style.setProperty('--c', cat.color);
          it.draggable = true;
          it.dataset.type = d.type;
          it.title = d.desc || '';
          it.innerHTML = `<span class="t">${esc(d.type)}</span><span class="cn">${esc(d.cn)}</span><button class="add" title="点击添加">+</button>`;
          box.appendChild(it);
        }
      }
      paletteEl.appendChild(box);
    }
  }

  /* ---------------- 查询树渲染 ---------------- */
  function summaryOf(node) {
    const d = DEFS[node.type];
    if (d.summary) { try { return d.summary(node); } catch (e) { return ''; } }
    const pairs = Object.entries(node.params).filter(([, v]) => !isEmpty(v)).slice(0, 2);
    return pairs.map(([k, v]) => k + '=' + String(v).slice(0, 18)).join(' ');
  }
  function hasIssue(node) {
    const d = DEFS[node.type];
    return d.fields.some((f) => f.req && isEmpty(node.params[f.k]));
  }

  function nodeEl(node) {
    const d = DEFS[node.type];
    const cat = CATMAP[d.cat];
    const box = el('div', 'qnode' + (node.id === selectedId ? ' sel' : '') + (hasIssue(node) ? ' invalid' : ''));
    box.dataset.id = node.id;
    box.style.setProperty('--c', cat.color);
    box.draggable = true;

    const isContainer = !!(d.slots || d.listKids);
    const head = el('div', 'qnode-h');
    head.dataset.drop = 'before';
    head.dataset.id = node.id;
    const caret = isContainer
      ? `<span class="caret ${node.collapsed ? '' : 'open'}" data-caret="${node.id}">▶</span>`
      : '<span class="caret"></span>';
    head.innerHTML =
      caret +
      `<span class="badge">${esc(node.type)}</span>` +
      `<span class="cn">${esc(d.cn)}</span>` +
      `<span class="summary">${esc(summaryOf(node))}</span>` +
      `<span class="acts">
        <button class="icon-btn" data-act="dup" title="复制节点"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
        <button class="icon-btn" data-act="wrap" title="包一层 bool" style="font-family:var(--mono);font-weight:700">{&thinsp;}</button>
        <button class="icon-btn del" data-act="del" title="删除节点"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </span>`;
    box.appendChild(head);

    if (isContainer && !node.collapsed) {
      const body = el('div', 'qnode-body');
      if (d.slots) {
        for (const s of d.slots) {
          const slotBox = el('div', 'slot');
          slotBox.style.setProperty('--sc', s.color || '#64748b');
          slotBox.appendChild(el('div', 'slot-h', esc(s.label)));
          const sb = el('div', 'slot-body');
          sb.dataset.drop = 'slot';
          sb.dataset.pid = node.id;
          sb.dataset.slot = s.key;
          const kids = node.kids[s.key] || [];
          if (!kids.length) {
            sb.appendChild(el('div', 'slot-empty', `<span class="plus">+</span>拖拽查询到这里`));
          } else {
            kids.forEach((k) => sb.appendChild(nodeEl(k)));
          }
          slotBox.appendChild(sb);
          body.appendChild(slotBox);
        }
      } else {
        const slotBox = el('div', 'slot');
        slotBox.appendChild(el('div', 'slot-h', esc(d.listKids.label)));
        const sb = el('div', 'slot-body');
        sb.dataset.drop = 'slot';
        sb.dataset.pid = node.id;
        sb.dataset.slot = 'list';
        if (!node.kids.length) sb.appendChild(el('div', 'slot-empty', `<span class="plus">+</span>拖拽查询到这里`));
        else node.kids.forEach((k) => sb.appendChild(nodeEl(k)));
        slotBox.appendChild(sb);
        body.appendChild(slotBox);
      }
      box.appendChild(body);
    }
    return box;
  }

  function renderTree() {
    treeEl.innerHTML = '';
    if (!root) {
      const em = el('div', '');
      em.id = 'empty-state';
      em.dataset.drop = 'root';
      em.innerHTML = `
        <div class="big">画布还是空的</div>
        <div>从左侧<span style="color:var(--accent);font-weight:600">拖拽</span>或<span style="color:var(--accent);font-weight:600">点击 +</span> 添加一个查询节点</div>
        <div class="mono">多个根查询会自动用 bool 组合</div>
        <div class="row">
          <button class="btn primary sm" id="btn-sample">载入示例查询</button>
          <button class="btn sm" id="btn-import2">导入已有 JSON</button>
        </div>`;
      treeEl.appendChild(em);
      $('#btn-sample').addEventListener('click', () => { root = sampleTree(); selectedId = root.id; renderAll(); });
      $('#btn-import2').addEventListener('click', openImport);
      return;
    }
    const wrap = el('div', '');
    wrap.dataset.drop = 'root';
    wrap.style.minHeight = '100%';
    wrap.appendChild(nodeEl(root));
    treeEl.appendChild(wrap);
  }

  /* ---------------- 属性检查器 ---------------- */
  function fieldEl(node, f) {
    const wrap = el('div', 'field');
    const v = node.params[f.k];
    if (f.kind === 'checkbox') {
      wrap.innerHTML = `<div class="switch-row">
        <span class="switch"><input type="checkbox" id="f_${f.k}" ${v === true || v === 'true' ? 'checked' : ''}><i></i></span>
        <label for="f_${f.k}" style="margin:0;cursor:pointer">${esc(f.label)}</label>
      </div>`;
      wrap.querySelector('input').addEventListener('change', (e) => {
        node.params[f.k] = e.target.checked ? 'true' : '';
        onParamChange(node);
      });
      return wrap;
    }
    const reqMark = f.req ? '<span class="req"> *</span>' : '';
    const hint = f.help ? `<span class="hint">${esc(f.help)}</span>` : '';
    let input;
    if (f.kind === 'select') {
      input = `<select id="f_${f.k}"><option value="">（默认）</option>` +
        f.opts.map((o) => `<option ${v === o ? 'selected' : ''}>${esc(o)}</option>`).join('') + '</select>';
    } else if (f.kind === 'textarea' || f.kind === 'json') {
      wrap.classList.add('wide');
      input = `<textarea id="f_${f.k}" rows="${f.rows || 2}" placeholder="${esc(f.ph || '')}" spellcheck="false">${esc(v || '')}</textarea>`;
    } else {
      input = `<input type="${f.kind === 'number' ? 'number' : 'text'}" id="f_${f.k}" value="${esc(v || '')}" placeholder="${esc(f.ph || '')}" step="any">`;
    }
    wrap.innerHTML = `<label for="f_${f.k}">${esc(f.label)}${reqMark}${hint}</label>` + input +
      (f.help && f.kind !== 'checkbox' ? `<div class="help">${esc(f.help)}</div>` : '');
    const inp = wrap.querySelector('#f_' + CSS.escape(f.k)) || wrap.querySelector('[id^="f_"]');
    inp.addEventListener('input', () => {
      node.params[f.k] = inp.value;
      if (f.kind === 'json') {
        if (inp.value.trim() === '') inp.classList.remove('bad-json');
        else { try { JSON.parse(inp.value); inp.classList.remove('bad-json'); } catch (e) { inp.classList.add('bad-json'); } }
      }
      onParamChange(node);
    });
    return wrap;
  }

  function renderInspector() {
    inspectorEl.innerHTML = '';
    const sub = $('#insp-sub');
    const node = selected();
    if (!node) {
      sub.textContent = '未选中节点';
      inspectorEl.innerHTML = `<div class="help-card">
        <h4>怎么用</h4>
        1. 左侧元素库<strong>拖拽</strong>查询节点到画布，或点 <kbd>+</kbd> 快速添加<br>
        2. 组合查询（bool 等）有彩色槽位，拖进槽位即建立父子关系<br>
        3. 点选节点后在下方编辑参数，右侧 JSON 实时更新<br>
        4. 拖动已有节点可调整位置和层级
        <h4>槽位颜色</h4>
        <span class="slotkey" style="color:#0d9488">must</span> 必须满足 ·
        <span class="slotkey" style="color:#d97706">should</span> 可选加分 ·
        <span class="slotkey" style="color:#dc2626">must_not</span> 必须不满足 ·
        <span class="slotkey" style="color:#2563eb">filter</span> 过滤不计分
        <h4>小技巧</h4>
        · 往已有根查询上再拖一个查询，会自动包一层 bool<br>
        · 不认识的 DSL 用「自定义 JSON」节点原样嵌入<br>
        · <kbd>Delete</kbd> 删除选中节点，<kbd>Esc</kbd> 取消选中<br>
        · 遇到编辑器没内置的新语法，导入时会自动变成「自定义 JSON」节点，不丢数据
      </div>`;
      return;
    }
    const d = DEFS[node.type];
    const cat = CATMAP[d.cat];
    sub.textContent = node.type + ' · ' + d.cn;
    const head = el('div', 'insp-head');
    head.style.setProperty('--c', cat.color);
    head.innerHTML = `
      <span class="badge">${esc(node.type)}</span>
      <span class="cn">${esc(d.cn)}</span>
      <span class="cat">${esc(cat.label)}</span>
      <span class="desc">${esc(d.desc || '')}</span>
      <span class="insp-acts">
        <button class="btn sm" data-act="dup">复制节点</button>
        <button class="btn sm" data-act="wrap">包一层 bool</button>
        <button class="btn sm danger" data-act="del">删除</button>
      </span>`;
    inspectorEl.appendChild(head);
    const grid = el('div', 'fields-grid');
    for (const f of d.fields) grid.appendChild(fieldEl(node, f));
    inspectorEl.appendChild(grid);
    if (d.cat === 'fn') {
      inspectorEl.appendChild(el('div', 'help-card', '评分函数需放在 function_score 节点的 functions 槽位中才会生效。'));
    }
  }

  /* ---------------- JSON 输出 ---------------- */
  function exportBody() {
    const q = gen(root);
    const body = {};
    if (q) body.query = q;
    if (!isEmpty(settings.from)) body.from = Number(settings.from) || 0;
    if (!isEmpty(settings.size)) body.size = Number(settings.size);
    if (settings.track_total_hits === 'false') body.track_total_hits = false;
    if (!isEmpty(settings.min_score)) body.min_score = Number(settings.min_score);
    return body;
  }

  function highlight(json) {
    return esc(json).replace(
      /(&quot;(?:\\.|[^&])*?&quot;)(\s*:)?|\b(true|false|null)\b|-?\d+(\.\d+)?([eE][+-]?\d+)?/g,
      (m, str, colon) => {
        if (str !== undefined) return colon ? `<span class="k">${str}</span>:` : `<span class="s">${str}</span>`;
        if (/^(true|false|null)$/.test(m)) return `<span class="b">${m}</span>`;
        return `<span class="n">${m}</span>`;
      }
    );
  }

  function renderJSON() {
    const body = exportBody();
    jsonOutEl.innerHTML = highlight(JSON.stringify(body, null, 2));
    const issues = validate(root);
    if (issues.length) {
      jsonWarnEl.classList.add('show');
      jsonWarnEl.innerHTML = issues.slice(0, 20).map((i) => `<div>${esc(i)}</div>`).join('') +
        (issues.length > 20 ? `<div>…还有 ${issues.length - 20} 项</div>` : '');
    } else {
      jsonWarnEl.classList.remove('show');
      jsonWarnEl.innerHTML = '';
    }
    // 状态栏
    const n = countNodes(root);
    statusEl.innerHTML =
      `<span>节点 <b>${n}</b></span>` +
      (issues.length
        ? `<span class="bad">▲ ${issues.length} 项待完善</span>`
        : (root ? '<span class="ok">✓ DSL 有效</span>' : '<span>空画布</span>')) +
      `<span class="spacer"></span><span>支持 56 种查询类型 · ES 7.x / 8.x</span>`;
  }

  /* ---------------- 渲染总控 ---------------- */
  let jsonTimer = null;
  function scheduleJSON() {
    clearTimeout(jsonTimer);
    jsonTimer = setTimeout(() => { renderJSON(); save(); }, 120);
  }
  function onParamChange(node) {
    // 只更新该节点的摘要，避免整树重绘导致输入失焦
    const box = treeEl.querySelector(`.qnode[data-id="${node.id}"]`);
    if (box) {
      const sum = box.querySelector(':scope > .qnode-h .summary');
      if (sum) sum.textContent = summaryOf(node);
      box.classList.toggle('invalid', hasIssue(node));
    }
    scheduleJSON();
  }
  function renderAll() {
    renderTree();
    renderInspector();
    renderJSON();
    save();
  }

  /* ---------------- 导入 / 导出 ---------------- */
  function openImport() {
    $('#modal-mask').classList.add('show');
    $('#m-err').textContent = '';
    $('#m-text').value = '';
    setTimeout(() => $('#m-text').focus(), 50);
  }
  function closeImport() { $('#modal-mask').classList.remove('show'); }
  function doImport() {
    const text = $('#m-text').value.trim();
    if (!text) { $('#m-err').textContent = '请粘贴 JSON'; return; }
    let obj;
    try { obj = JSON.parse(text); } catch (e) { $('#m-err').textContent = 'JSON 解析失败：' + e.message; return; }
    let q = obj;
    if (obj && typeof obj === 'object' && obj.query) {
      if (obj.size !== undefined) settings.size = String(obj.size);
      if (obj.from !== undefined) settings.from = String(obj.from);
      if (obj.track_total_hits !== undefined) settings.track_total_hits = String(obj.track_total_hits);
      if (obj.min_score !== undefined) settings.min_score = String(obj.min_score);
      q = obj.query;
    }
    const node = importNode(q);
    if (!node) { $('#m-err').textContent = '无法识别的查询结构'; return; }
    root = node;
    selectedId = node.id;
    syncSettingsInputs();
    closeImport();
    renderAll();
    toast('导入成功');
  }

  function syncSettingsInputs() {
    $('#set-size').value = settings.size;
    $('#set-from').value = settings.from;
    $('#set-tth').value = settings.track_total_hits;
    $('#set-minscore').value = settings.min_score;
  }

  function copyJSON() {
    const text = JSON.stringify(exportBody(), null, 2);
    const done = () => toast('已复制到剪贴板');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选择复制'); }
    document.body.removeChild(ta);
  }
  function downloadJSON() {
    const blob = new Blob([JSON.stringify(exportBody(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'es-query.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已下载 es-query.json');
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    // 元素库搜索
    $('#palette-search').addEventListener('input', (e) => { paletteFilter = e.target.value; renderPalette(); });

    // 元素库拖拽 + 点击添加
    paletteEl.addEventListener('dragstart', (e) => {
      const it = e.target.closest('.pitem');
      if (!it) return;
      e.dataTransfer.setData('text/plain', 'type:' + it.dataset.type);
      e.dataTransfer.effectAllowed = 'copy';
      it.classList.add('dragging');
    });
    paletteEl.addEventListener('dragend', (e) => {
      const it = e.target.closest('.pitem');
      if (it) it.classList.remove('dragging');
      clearDropHints();
    });
    paletteEl.addEventListener('click', (e) => {
      const add = e.target.closest('.pitem .add');
      const it = e.target.closest('.pitem');
      if (add && it) quickAdd(it.dataset.type);
      else if (e.target.closest('.pcat-h')) {
        const box = e.target.closest('.pcat');
        const label = box.querySelector('.pcat-h').textContent;
        const cat = CATS.find((c) => label.startsWith(c.label));
        if (cat) { collapsedCats[cat.id] = !collapsedCats[cat.id]; renderPalette(); }
      } else if (it) {
        quickAdd(it.dataset.type);
      }
    });

    // 树节点拖拽
    treeEl.addEventListener('dragstart', (e) => {
      const nd = e.target.closest('.qnode');
      if (!nd) return;
      e.dataTransfer.setData('text/plain', 'node:' + nd.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      nd.classList.add('dragging');
    });
    treeEl.addEventListener('dragend', (e) => {
      const nd = e.target.closest('.qnode');
      if (nd) nd.classList.remove('dragging');
      clearDropHints();
    });

    // 树点击：选中 / 操作 / 折叠
    treeEl.addEventListener('click', (e) => {
      const caret = e.target.closest('[data-caret]');
      if (caret) {
        const loc = find(caret.dataset.caret);
        if (loc) { loc.node.collapsed = !loc.node.collapsed; renderTree(); save(); }
        e.stopPropagation();
        return;
      }
      const act = e.target.closest('[data-act]');
      if (act) {
        const nd = act.closest('.qnode');
        if (!nd) return;
        const id = nd.dataset.id;
        if (act.dataset.act === 'del') deleteNode(id);
        else if (act.dataset.act === 'dup') duplicateNode(id);
        else if (act.dataset.act === 'wrap') wrapBool(id);
        e.stopPropagation();
        return;
      }
      const nd = e.target.closest('.qnode');
      if (nd) {
        selectedId = nd.dataset.id;
        renderTree();
        renderInspector();
      }
    });

    // 检查器操作按钮
    inspectorEl.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (!act || !selectedId) return;
      if (act.dataset.act === 'del') deleteNode(selectedId);
      else if (act.dataset.act === 'dup') duplicateNode(selectedId);
      else if (act.dataset.act === 'wrap') wrapBool(selectedId);
    });

    // 拖放
    document.addEventListener('dragover', (e) => {
      const zone = e.target.closest('[data-drop]');
      clearDropHints();
      if (!zone) return;
      e.preventDefault();
      if (zone.dataset.drop === 'slot') zone.classList.add('hover');
      else if (zone.dataset.drop === 'before') {
        const nd = zone.closest('.qnode');
        if (nd) nd.classList.add('insert-before');
      } else if (zone.dataset.drop === 'root') {
        const em = $('#empty-state');
        if (em) em.classList.add('hover');
        treeEl.classList.add('drop-root');
      }
    });
    document.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) clearDropHints();
    });
    document.addEventListener('drop', (e) => {
      const zone = e.target.closest('[data-drop]');
      clearDropHints();
      if (!zone) return;
      e.preventDefault();
      const data = e.dataTransfer.getData('text/plain');
      const sep = data.indexOf(':');
      if (sep === -1) return;
      const kind = data.slice(0, sep);
      const payload = data.slice(sep + 1);
      if (kind !== 'type' && kind !== 'node') return;
      if (zone.dataset.drop === 'slot') {
        dropAt({ kind: 'slot', pid: zone.dataset.pid, key: zone.dataset.slot }, kind, payload);
      } else if (zone.dataset.drop === 'before') {
        dropAt({ kind: 'before', id: zone.dataset.id }, kind, payload);
      } else {
        dropAt({ kind: 'root' }, kind, payload);
      }
    });

    // 顶栏 & 工具条
    $('#btn-import').addEventListener('click', openImport);
    $('#btn-copy').addEventListener('click', copyJSON);
    $('#btn-copy2').addEventListener('click', copyJSON);
    $('#btn-download').addEventListener('click', downloadJSON);
    $('#btn-clear').addEventListener('click', () => {
      if (!root) return;
      root = null; selectedId = null; renderAll(); toast('画布已清空');
    });
    $('#btn-sample-top').addEventListener('click', () => {
      root = sampleTree(); selectedId = root.id; renderAll(); toast('已载入示例');
    });

    // 查询设置
    const setMap = { 'set-size': 'size', 'set-from': 'from', 'set-tth': 'track_total_hits', 'set-minscore': 'min_score' };
    for (const [id, key] of Object.entries(setMap)) {
      $('#' + id).addEventListener('input', (e) => { settings[key] = e.target.value; scheduleJSON(); });
    }

    // 弹窗
    $('#m-cancel').addEventListener('click', closeImport);
    $('#m-ok').addEventListener('click', doImport);
    $('#modal-mask').addEventListener('click', (e) => { if (e.target === $('#modal-mask')) closeImport(); });

    // 属性面板高度拖拽
    const rz = $('#insp-resizer');
    rz.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const panel = $('#inspector-panel');
      const startY = e.clientY;
      const startH = panel.offsetHeight;
      function mv(ev) {
        panel.style.height = Math.max(120, Math.min(window.innerHeight * 0.7, startH + startY - ev.clientY)) + 'px';
      }
      function up() {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        rz.classList.remove('active');
        document.body.style.cursor = '';
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
      rz.classList.add('active');
      document.body.style.cursor = 'row-resize';
    });

    // 键盘
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if ($('#modal-mask').classList.contains('show')) {
        if (e.key === 'Escape') closeImport();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedId) { deleteNode(selectedId); e.preventDefault(); }
      } else if (e.key === 'Escape') {
        if ($('#modal-mask').classList.contains('show')) closeImport();
        else { selectedId = null; renderTree(); renderInspector(); }
      }
    });
  }

  function clearDropHints() {
    document.querySelectorAll('.slot-body.hover').forEach((x) => x.classList.remove('hover'));
    document.querySelectorAll('.qnode.insert-before').forEach((x) => x.classList.remove('insert-before'));
    const em = $('#empty-state');
    if (em) em.classList.remove('hover');
    treeEl.classList.remove('drop-root');
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    renderPalette();
    bind();
    syncSettingsInputs();
    if (!load()) {
      root = sampleTree();
      selectedId = root.id;
    }
    renderAll();
  }
  init();
})();
