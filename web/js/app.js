/* ============================================================
 * ES DSL Studio - 界面逻辑
 * 元素库 / 拖拽 / 查询树 / 属性检查器 / JSON 预览与导入导出
 * ============================================================ */
(function () {
  'use strict';
  const { CATS, CATMAP, DEFS, mkNode, gen, importNode, importAggs, validate, isEmpty } = window.ESQ;
  // 结果整形复用 es-client.js 的纯函数（那边有单元测试）
  const { flattenDoc, aggRows, aggMetricList, cellText } = window.ESDC;
  const DSEL = window.ESDSEL; // 自绘下拉（与索引管理视图共用同一套机制）

  /* ---------------- 状态 ---------------- */
  let root = null;        // 查询树根
  let aggsRoot = null;    // 聚合树根（aggs 容器），与查询树并列，产出 body.aggs
  let selectedId = null;
  let settings = { size: '10', from: '', track_total_hits: 'true', min_score: '', extra: '' };
  let paletteFilter = '';
  const collapsedCats = {};
  let aggSeq = 0; // 聚合默认名称计数器

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
      localStorage.setItem('esdsl.v1', JSON.stringify({ root, aggsRoot, settings }));
    } catch (e) { /* 忽略配额错误 */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem('esdsl.v1');
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (data.settings) settings = Object.assign(settings, data.settings);
      if (data.root) root = data.root;
      if (data.aggsRoot) aggsRoot = data.aggsRoot;
      return !!data.root;
    } catch (e) { /* 损坏则忽略 */ }
    return false;
  }

  /* ---------------- 树操作 ---------------- */
  // 查询树、聚合树两棵并列的树；find 依次查找
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
  // 先在查询树找，找不到再查聚合树
  function findAny(id) {
    return find(id, root, null, null, -1) || find(id, aggsRoot, null, null, -1);
  }
  function selected() { return selectedId ? (findAny(selectedId) || {}).node || null : null; }
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

  // 类型是否能放进槽位：fn / agg 是专属类别，只能进 accept 匹配的槽位
  function slotAccepts(slot, type) {
    const cat = DEFS[type].cat;
    if (slot.accept === 'fn') return cat === 'fn';
    if (slot.accept === 'agg') return cat === 'agg';
    if (cat === 'fn' || cat === 'agg') return false;
    return true;
  }
  // listKids 容器的合成槽位：必须保留 DEFS.listKids 上的约束（如 aggs 列表 accept:'agg'），
  // 否则硬编码 { key:'list', multi:true } 会丢掉 accept，导致聚合节点拖不进聚合列表
  function listSlotOf(parent) {
    return Object.assign({}, DEFS[parent.type].listKids, { key: 'list', multi: true });
  }
  function slotRejectMsg(type, slot) {
    const cat = DEFS[type].cat;
    if (cat === 'fn') return '评分函数请拖到 function_score 的 functions 槽位';
    if (cat === 'agg') return '聚合节点请拖到画布下方「聚合统计」区，或桶聚合的子聚合槽位';
    if (slot && slot.accept === 'agg') return '这里只能放聚合节点，查询请放到上方查询区';
    if (slot && slot.accept === 'fn') return '这里只能放评分函数';
    return '该节点不能放在这个位置';
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
      toast(slotRejectMsg(child.type, slot));
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
    const loc = findAny(id);
    if (!loc) return null;
    if (!loc.parent) {
      // 两棵树的根分别处理
      if (loc.node === aggsRoot) aggsRoot = null;
      else if (loc.node === root) root = null;
      return loc.node;
    }
    kidsArrayOf(loc).splice(loc.index, 1);
    return loc.node;
  }

  function deleteNode(id) {
    const loc = findAny(id);
    if (!loc) return;
    detach(id);
    if (selectedId && !findAny(selectedId)) selectedId = null;
    renderAll();
    toast('已删除 ' + loc.node.type);
  }

  function duplicateNode(id) {
    const loc = findAny(id);
    if (!loc) return;
    const copy = cloneNode(loc.node);
    if (!loc.parent) { toast('根节点请先拖入组合查询，或包一层 bool'); return; }
    kidsArrayOf(loc).splice(loc.index + 1, 0, copy);
    selectedId = copy.id;
    renderAll();
  }

  function wrapBool(id) {
    const loc = findAny(id);
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
    if (d.listKids) return listSlotOf(parent);
    return (d.slots || []).find((s) => slotAccepts(s, type) && (s.multi || !(parent.kids[s.key] || []).length)) || null;
  }

  // 拖拽落点处理。zone: {kind:'slot',pid,key} | {kind:'before',id} | {kind:'root'} | {kind:'aggsroot'}
  // 约定：落到容器节点头上 = 加入其第一个可用槽位；落到叶子节点头上 = 插到它前面。
  function dropAt(zone, payloadKind, payload) {
    const nodeType = payloadKind === 'type' ? payload : (findAny(payload) || {}).node && (findAny(payload) || {}).node.type;
    if (!nodeType) return;
    const isAgg = DEFS[nodeType].cat === 'agg';

    /* ---- 预检（在 detach 之前，失败零副作用） ---- */
    if (payloadKind === 'node') {
      const dragLoc = findAny(payload);
      if (!dragLoc) return;
      if (payload === (zone.id || zone.pid)) return; // 拖到自己身上
      if (zone.kind === 'root' && dragLoc.node === root) return; // 根拖到画布
      if (zone.kind === 'aggsroot' && dragLoc.node === aggsRoot) return; // 聚合容器拖进自己的面板
      const targetId = zone.id || zone.pid;
      if (targetId && inSubtree(dragLoc.node, targetId)) { toast('不能拖进自己的子节点里'); return; }
    }

    /* ---- 聚合区根落点：只收聚合节点 ---- */
    if (zone.kind === 'aggsroot') {
      if (!isAgg) { toast('这里只能放聚合节点，查询请放到上方查询区'); return; }
      if (nodeType === 'aggs' && aggsRoot) { toast('聚合区已存在，直接往里拖聚合节点即可'); return; }
      let node = payloadKind === 'type' ? mkNode(payload) : detach(payload);
      if (node.type !== 'aggs' && isEmpty(node.params.name)) node.params.name = uniqueAggName(DEFS[nodeType]);
      if (node.type === 'aggs') { aggsRoot = node; }
      else {
        if (!aggsRoot) aggsRoot = mkNode('aggs');
        aggsRoot.kids.push(node);
      }
      if (selectedId && !findAny(selectedId)) selectedId = null;
      selectedId = node.id;
      renderAll();
      return;
    }

    /* ---- 查询区根落点：不收聚合节点 ---- */
    if (zone.kind === 'root' && isAgg) { toast('聚合节点请拖到画布下方的「聚合统计」区'); return; }

    let parent = null, slot = null, insertIdx = -1;
    if (zone.kind === 'slot') {
      parent = (findAny(zone.pid) || {}).node;
      if (!parent) return;
      slot = zone.key === 'list' ? listSlotOf(parent)
        : Object.assign({}, (DEFS[parent.type].slots || []).find((s) => s.key === zone.key) || {});
      slot.key = zone.key;
    } else if (zone.kind === 'before') {
      const loc = findAny(zone.id);
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
        slot = loc.key === 'list' ? listSlotOf(loc.parent)
          : Object.assign({}, DEFS[loc.parent.type].slots.find((s) => s.key === loc.key) || {});
        slot.key = loc.key;
        insertIdx = loc.index;
      }
      // loc 为根且不是容器 -> 走 root 逻辑（包 bool）
    }

    // 「聚合统计」容器只能有一个且必须在聚合区根部，不能拖进任何槽位
    if (nodeType === 'aggs' && parent) { toast('聚合区只能有一个，直接往里拖聚合节点即可'); return; }

    if (slot && !slotAccepts(slot, nodeType)) {
      toast(slotRejectMsg(nodeType, slot));
      return;
    }
    if (isAgg && !(slot && slot.accept === 'agg')) {
      toast(slotRejectMsg(nodeType, slot));
      return;
    }

    /* ---- 执行 ---- */
    let node;
    if (payloadKind === 'type') node = mkNode(payload);
    else node = detach(payload);
    if (payloadKind === 'type' && isAgg && isEmpty(node.params.name)) node.params.name = uniqueAggName(DEFS[nodeType]);

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

  // 聚合节点默认名称：terms_1 / avg_price_2 …
  function uniqueAggName(d) {
    return d.type.replace(/^agg_/, '') + '_' + (++aggSeq);
  }

  // 确保聚合根存在，返回容器
  function ensureAggsRoot() {
    if (!aggsRoot) aggsRoot = mkNode('aggs');
    return aggsRoot;
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
    if (d.cat === 'agg') {
      // 聚合节点：自动展开聚合统计区，保证落点可见
      const sec = $('#aggs-sec');
      if (sec && sec.classList.contains('collapsed')) {
        sec.classList.remove('collapsed');
        $('#btn-aggs-toggle').title = '收起聚合统计区';
      }
      // 聚合容器：没有就建，有了就选中
      if (type === 'aggs') {
        const c = ensureAggsRoot();
        selectedId = c.id;
        renderAll();
        toast(aggsRoot.kids.length ? '已选中聚合统计区' : '聚合区已就绪，从左侧拖入聚合节点');
        return;
      }
      const n = mkNode(type);
      if (isEmpty(n.params.name)) n.params.name = uniqueAggName(d);
      const sel = selected();
      if (sel && DEFS[sel.type].cat === 'agg' && sel.kids && sel.kids.sub) {
        // 选中了某个聚合：作为它的子聚合
        sel.kids.sub.push(n);
      } else {
        ensureAggsRoot().kids.push(n);
      }
      selectedId = n.id;
      renderAll();
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
        const slot = listSlotOf(sel);
        if (!slotAccepts(slot, type)) { toast(slotRejectMsg(type, slot)); return; }
        sel.kids.push(n); selectedId = n.id; renderAll(); return;
      }
      // 叶子节点：作为同级插到它后面
      const loc = findAny(sel.id);
      if (loc && loc.parent) {
        const slot = loc.key === 'list' ? listSlotOf(loc.parent) : DEFS[loc.parent.type].slots.find((s) => s.key === loc.key);
        if (slot && slot.multi && slotAccepts(slot, type)) {
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

  /* ---------------- 默认查询：一个空的 bool ---------------- */
  function sampleTree() {
    return mkNode('bool');
  }

  /* ---------------- 元素库渲染 ----------------
     分组（pcat）可收缩：items 包在 .pcat-items 里，靠 max-height 过渡做抽屉动画；
     搜索时忽略收起状态（自动展开命中分组），避免「搜到了却看不见」。 */
  function renderPalette() {
    paletteEl.innerHTML = '';
    const kw = paletteFilter.trim().toLowerCase();
    for (const cat of CATS) {
      const items = Object.values(DEFS).filter((d) => d.cat === cat.id && (!kw ||
        d.type.toLowerCase().includes(kw) || d.cn.toLowerCase().includes(kw) || (d.desc || '').toLowerCase().includes(kw)));
      if (!items.length) continue;
      const collapsed = !kw && !!collapsedCats[cat.id];
      const box = el('div', 'pcat' + (collapsed ? ' collapsed' : ''));
      box.style.setProperty('--c', cat.color);
      box.dataset.cat = cat.id;
      const h = el('div', 'pcat-h',
        `<span class="caret"></span><span class="dot"></span>${esc(cat.label)}<span class="cnt">${items.length}</span>`);
      box.appendChild(h);
      const body = el('div', 'pcat-items');
      for (const d of items) {
        const it = el('div', 'pitem');
        it.style.setProperty('--c', cat.color);
        it.draggable = true;
        it.dataset.type = d.type;
        it.title = d.desc || '';
        it.innerHTML = `<span class="t">${esc(d.type)}</span><span class="cn">${esc(d.cn)}</span><button class="add" title="点击添加">+</button>`;
        body.appendChild(it);
      }
      box.appendChild(body);
      paletteEl.appendChild(box);
    }
    syncCatsToggle();
  }

  /* 分组一键展开/收起：全收起时按钮变为「展开所有」；搜索中恒为「收起所有」，
     状态会记下，清空搜索后生效（搜索时命中分组强制展开，避免搜到却看不见） */
  const ICON_CHEVS_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 20 5-5 5 5"/><path d="m7 12 5-5 5 5"/></svg>';
  const ICON_CHEVS_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/></svg>';
  function syncCatsToggle() {
    const btn = $('#btn-cats-toggle');
    if (!btn) return;
    const allCollapsed = !paletteFilter.trim() && CATS.every((c) => collapsedCats[c.id]);
    btn.title = allCollapsed ? '展开所有分类' : '收起所有分类';
    btn.innerHTML = allCollapsed ? ICON_CHEVS_DOWN : ICON_CHEVS_UP;
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
    // 聚合节点的徽标显示名称（重命名后一眼能看到 DSL 里的 key）
    const badge = d.cat === 'agg' && node.type !== 'aggs'
      ? esc(node.params.name || node.type)
      : esc(node.type);
    head.innerHTML =
      caret +
      `<span class="badge">${badge}</span>` +
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
          <button class="btn primary sm" id="btn-sample">新建 bool 查询</button>
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

  /* ---------------- 聚合区渲染 ---------------- */
  function renderAggsPanel() {
    const host = $('#aggs-tree');
    if (!host) return;
    host.innerHTML = '';
    const cnt = $('#aggs-count');
    if (cnt) cnt.textContent = aggsRoot ? (aggsRoot.kids || []).length + ' 个聚合' : '';
    if (!aggsRoot) {
      const em = el('div', 'aggs-empty');
      em.dataset.drop = 'aggsroot';
      em.innerHTML =
        '<span>统计指标？从左侧<span class="k">聚合统计</span>分类拖入聚合节点到这里</span>' +
        '<button class="btn sm" id="btn-aggs-new">新建聚合区</button>';
      host.appendChild(em);
      $('#btn-aggs-new').addEventListener('click', () => quickAdd('aggs'));
      return;
    }
    const wrap = el('div', 'aggs-wrap');
    wrap.dataset.drop = 'aggsroot';
    wrap.appendChild(nodeEl(aggsRoot));
    host.appendChild(wrap);
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
    const fieldLike = (f.k === 'field' || f.k === 'fields' || f.k === 'path');
    let input;
    if (f.kind === 'select') {
      input = `<select id="f_${f.k}" class="qp-select"><option value="">（默认）</option>` +
        f.opts.map((o) => `<option ${v === o ? 'selected' : ''}>${esc(o)}</option>`).join('') + '</select>';
    } else if (f.kind === 'textarea' || f.kind === 'json') {
      wrap.classList.add('wide');
      input = `<textarea id="f_${f.k}" rows="${f.rows || 2}" placeholder="${esc(f.ph || '')}" spellcheck="false">${esc(v || '')}</textarea>`;
    } else {
      input = `<input type="${f.kind === 'number' ? 'number' : 'text'}" id="f_${f.k}" value="${esc(v || '')}" placeholder="${esc(f.ph || '')}" step="any"` +
        (fieldLike ? ' autocomplete="off"' : '') + '>';
    }
    wrap.innerHTML = `<label for="f_${f.k}">${esc(f.label)}${reqMark}${hint}</label>` +
      `<span class="ctl">${input}<button type="button" class="ctl-x" title="清空">✕</button></span>` +
      (f.help && f.kind !== 'checkbox' ? `<div class="help">${esc(f.help)}</div>` : '');
    const inp = wrap.querySelector('#f_' + CSS.escape(f.k)) || wrap.querySelector('[id^="f_"]');
    const ctl = wrap.querySelector('.ctl');
    // 字段类输入框挂自绘联想浮层（能带出类型徽标，datalist 做不到）
    if (fieldLike && inp && inp.tagName === 'INPUT') attachFieldSuggest(inp);
    // 下拉框的 ✕ 不能覆盖原生箭头，改用并排布局
    if (f.kind === 'select') { ctl.classList.add('ctl-sel'); DSEL.upgrade(wrap); }
    // 有值时才显示清空按钮
    const syncClear = () => { ctl.classList.toggle('has', String(inp.value) !== ''); };
    wrap.querySelector('.ctl-x').addEventListener('click', () => {
      inp.value = '';
      node.params[f.k] = '';
      inp.classList.remove('bad-json');
      syncClear();
      if (f.kind === 'select') DSEL.sync(inp); // 一键清空后同步自绘触发器
      onParamChange(node);
      inp.focus();
    });
    inp.addEventListener('input', () => {
      node.params[f.k] = inp.value;
      if (f.kind === 'json') {
        if (inp.value.trim() === '') inp.classList.remove('bad-json');
        else { try { JSON.parse(inp.value); inp.classList.remove('bad-json'); } catch (e) { inp.classList.add('bad-json'); } }
      }
      syncClear();
      onParamChange(node);
    });
    if (f.kind === 'select') inp.addEventListener('change', () => {
      node.params[f.k] = inp.value;
      syncClear();
      onParamChange(node);
    });
    syncClear();
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
        4. 拖动已有节点可调整位置和层级<br>
        5. 统计需求？把「聚合统计」分类的节点拖到画布下方聚合区
        <h4>槽位颜色</h4>
        <span class="slotkey" style="color:#0d9488">must</span> 必须满足 ·
        <span class="slotkey" style="color:#d97706">should</span> 可选加分 ·
        <span class="slotkey" style="color:#dc2626">must_not</span> 必须不满足 ·
        <span class="slotkey" style="color:#2563eb">filter</span> 过滤不计分
        <h4>小技巧</h4>
        · 往已有根查询上再拖一个查询，会自动包一层 bool<br>
        · 桶聚合（terms / 日期直方图）里能嵌子聚合，先分组再求指标<br>
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
    if (node.type === 'aggs') {
      inspectorEl.appendChild(el('div', 'help-card',
        '从左侧「聚合统计」分类拖入聚合节点即可。桶聚合（terms / 日期直方图 / 范围等）的子聚合槽位里还能继续嵌套，例如先按状态分组、再求均价。'));
    } else if (d.cat === 'agg') {
      const subN = ((node.kids && node.kids.sub) || []).length;
      inspectorEl.appendChild(el('div', 'help-card',
        '聚合名称是 DSL 里 aggs 的 key，同一级别不能重复。' +
        (subN ? '当前已嵌套 ' + subN + ' 个子聚合。' : '把聚合节点拖到「子聚合」槽位，可在此聚合内部继续统计。')));
    }
  }

  /* ---------------- JSON 输出 ---------------- */
  // 由画布直接控制的字段，导入时不会被附加体覆盖
  const BODY_RESERVED = { query: 1, size: 1, from: 1, track_total_hits: 1, min_score: 1, aggs: 1 };

  function extraBody() {
    const raw = (settings.extra || '').trim();
    if (!raw) return null;
    try {
      const o = JSON.parse(raw);
      return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
    } catch (e) { return null; }
  }

  function exportBody() {
    const q = gen(root);
    const body = {};
    if (q) body.query = q;
    if (!isEmpty(settings.from)) body.from = Number(settings.from) || 0;
    if (!isEmpty(settings.size)) body.size = Number(settings.size);
    if (settings.track_total_hits === 'false') body.track_total_hits = false;
    if (!isEmpty(settings.min_score)) body.min_score = Number(settings.min_score);
    // 聚合树 -> body.aggs（空容器不发）
    if (aggsRoot) {
      const m = gen(aggsRoot);
      if (m && Object.keys(m).length) body.aggs = m;
    }
    // 导入 DSL 时保留的附加字段：sort / _source / highlight …
    const extra = extraBody();
    if (extra) {
      Object.keys(extra).forEach((k) => { if (!BODY_RESERVED[k]) body[k] = extra[k]; });
    }
    return body;
  }

  // 附加字段的小标签，让用户知道 JSON 里这些不是画布生成的
  function renderExtraNote() {
    const box = $('#extra-note');
    if (!box) return;
    const extra = extraBody();
    const keys = extra ? Object.keys(extra) : [];
    if (!keys.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '<span class="ex-k">附加</span>' + esc(keys.join('、'));
    const x = document.createElement('button');
    x.className = 'ex-x';
    x.title = '清除附加字段';
    x.textContent = '✕';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      settings.extra = '';
      renderAll();
    });
    box.appendChild(x);
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
    renderExtraNote();
    // DSL 与上次执行的不一致时，提示结果可能过期
    if (rs.open && rs.result && rs.sentSig && rs.sentSig !== JSON.stringify(requestBody())) {
      if (!rs.stale) { rs.stale = true; renderStatus(); }
    }
    const issues = validate(root, 'query').concat(aggsRoot ? validate(aggsRoot, 'aggs') : []);
    if (issues.length) {
      jsonWarnEl.classList.add('show');
      jsonWarnEl.innerHTML = issues.slice(0, 20).map((i) => `<div>${esc(i)}</div>`).join('') +
        (issues.length > 20 ? `<div>…还有 ${issues.length - 20} 项</div>` : '');
    } else {
      jsonWarnEl.classList.remove('show');
      jsonWarnEl.innerHTML = '';
    }
    // 状态栏
    const n = countNodes(root) + countNodes(aggsRoot);
    const nAgg = aggsRoot ? (aggsRoot.kids || []).length : 0;
    const nQ = Object.values(DEFS).filter((d) => d.cat !== 'agg').length;
    const nAT = Object.values(DEFS).filter((d) => d.cat === 'agg' && d.type !== 'aggs').length;
    statusEl.innerHTML =
      `<span>节点 <b>${n}</b></span>` +
      (nAgg ? `<span>聚合 <b>${nAgg}</b></span>` : '') +
      (issues.length
        ? `<span class="bad">▲ ${issues.length} 项待完善</span>`
        : (root || aggsRoot ? '<span class="ok">✓ DSL 有效</span>' : '<span>空画布</span>')) +
      `<span class="spacer"></span><span>支持 ${nQ} 种查询 + ${nAT} 种聚合 · ES 7.x / 8.x</span>`;
  }

  /* ---------------- 渲染总控 ---------------- */
  let jsonTimer = null;
  function scheduleJSON() {
    clearTimeout(jsonTimer);
    jsonTimer = setTimeout(() => {
      renderJSON();
      save();
    }, 120);
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
    renderAggsPanel();
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
      // 保留 sort / _source / highlight 等顶层字段，避免导入后被丢掉（aggs 单独走聚合树）
      const rest = {};
      Object.keys(obj).forEach((k) => { if (!BODY_RESERVED[k]) rest[k] = obj[k]; });
      settings.extra = Object.keys(rest).length ? JSON.stringify(rest) : '';
      // aggs 解析成聚合树；无法识别的结构原样留在附加字段里，不丢数据
      aggsRoot = null;
      if (obj.aggs !== undefined) {
        const parsed = importAggs(obj.aggs);
        if (parsed) aggsRoot = parsed;
        else { rest.aggs = obj.aggs; settings.extra = JSON.stringify(rest); }
      }
    } else {
      settings.extra = '';
      aggsRoot = null;
    }
    const node = importNode(q);
    if (!node) { $('#m-err').textContent = '无法识别的查询结构'; return; }
    root = node;
    selectedId = node.id;
    syncSettingsInputs();
    closeImport();
    renderAll();
    toast(aggsRoot ? '导入成功（含 ' + (aggsRoot.kids || []).length + ' 个聚合）' : '导入成功');
  }

  function syncSettingsInputs() {
    $('#set-size').value = settings.size;
    $('#set-from').value = settings.from;
    $('#set-tth').value = settings.track_total_hits;
    DSEL.sync($('#set-tth')); // 回填后同步自绘触发器
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
    // 视图切换
    document.querySelectorAll('#viewswitch button').forEach((b) => {
      b.addEventListener('click', () => switchView(b.dataset.view));
    });

    // 元素库搜索
    $('#palette-search').addEventListener('input', (e) => { paletteFilter = e.target.value; renderPalette(); });

    // 元素库拖拽 + 点击添加
    paletteEl.addEventListener('dragstart', (e) => {
      const it = e.target.closest('.pitem');
      if (!it) return;
      e.dataTransfer.setData('text/plain', 'type:' + it.dataset.type);
      e.dataTransfer.effectAllowed = 'copy';
      it.classList.add('dragging');
      // 拖聚合节点时自动展开聚合统计区，保证落点可见
      if ((DEFS[it.dataset.type] || {}).cat === 'agg') {
        const sec = $('#aggs-sec');
        if (sec && sec.classList.contains('collapsed')) {
          sec.classList.remove('collapsed');
          $('#btn-aggs-toggle').title = '收起聚合统计区';
        }
      }
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
        // 分组抽屉：点击表头展开/收起（搜索中不切换，保持命中分组可见）
        if (paletteFilter.trim()) return;
        const box = e.target.closest('.pcat');
        const cat = CATS.find((c) => c.id === box.dataset.cat);
        if (cat) {
          collapsedCats[cat.id] = !collapsedCats[cat.id];
          box.classList.toggle('collapsed', !!collapsedCats[cat.id]);
        }
      } else if (it) {
        quickAdd(it.dataset.type);
      }
    });

    // 树节点拖拽（查询树 + 聚合树共用）
    function bindTreeEvents(container) {
      container.addEventListener('dragstart', (e) => {
        const nd = e.target.closest('.qnode');
        if (!nd) return;
        e.dataTransfer.setData('text/plain', 'node:' + nd.dataset.id);
        e.dataTransfer.effectAllowed = 'move';
        nd.classList.add('dragging');
      });
      container.addEventListener('dragend', (e) => {
        const nd = e.target.closest('.qnode');
        if (nd) nd.classList.remove('dragging');
        clearDropHints();
      });

      // 树点击：选中 / 操作 / 折叠
      container.addEventListener('click', (e) => {
        const caret = e.target.closest('[data-caret]');
        if (caret) {
          const loc = findAny(caret.dataset.caret);
          if (loc) { loc.node.collapsed = !loc.node.collapsed; renderAll(); save(); }
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
          renderAggsPanel();
          renderInspector();
          // 双击节点：选中并「弹出」属性面板（收起状态自动展开，焦点落到第一个字段）。
          // 注意：不能监听 dblclick——单击已把树整体重绘，dblclick 的两次点击目标
          // 对不上、事件只会落在容器上；第二次 click 的 e.detail === 2 才是可靠信号。
          if (e.detail >= 2) {
            if (inspPanel.classList.contains('collapsed')) setInspCollapsed(false);
            const first = $('#inspector input, #inspector select, #inspector textarea');
            if (first) first.focus();
          }
        }
      });
    }
    bindTreeEvents(treeEl);
    const aggsTreeEl = $('#aggs-tree');
    if (aggsTreeEl) bindTreeEvents(aggsTreeEl);
    // 聚合区头部「+ 新建聚合区」
    const btnAggsAdd = $('#btn-aggs-add');
    if (btnAggsAdd) btnAggsAdd.addEventListener('click', () => quickAdd('aggs'));

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
      } else if (zone.dataset.drop === 'aggsroot') {
        zone.classList.add('hover');
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
      } else if (zone.dataset.drop === 'aggsroot') {
        dropAt({ kind: 'aggsroot' }, kind, payload);
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
      if (!root && !aggsRoot) return;
      root = null; aggsRoot = null; selectedId = null; renderAll(); toast('画布已清空');
    });
    $('#btn-sample-top').addEventListener('click', () => {
      root = sampleTree(); selectedId = root.id; renderAll(); toast('已新建空 bool 查询');
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

    // 属性面板折叠：收起只剩标题栏（记住原高度，展开后恢复）
    const inspPanel = $('#inspector-panel');
    const INSP_DEFAULT_H = 225; // 与 CSS 默认高度保持一致
    let inspH = 0;
    function setInspCollapsed(collapsed) {
      const isCollapsed = inspPanel.classList.toggle('collapsed', !!collapsed);
      if (isCollapsed) {
        inspH = inspPanel.offsetHeight || INSP_DEFAULT_H;
        inspPanel.style.height = 'auto';
        $('#insp-resizer').hidden = true; // 折叠时不给拖
      } else {
        inspPanel.style.height = (inspH || INSP_DEFAULT_H) + 'px';
        $('#insp-resizer').hidden = false;
      }
      $('#btn-insp-toggle').title = isCollapsed ? '展开属性面板' : '收起属性面板';
    }
    $('#btn-insp-toggle').addEventListener('click', () => {
      setInspCollapsed(!inspPanel.classList.contains('collapsed'));
    });
    setInspCollapsed(true); // 节点属性面板默认收起（双击节点或点开关展开）

    // 聚合统计区折叠：只藏聚合树，标题栏与「新建聚合区」仍在
    const aggsSec = $('#aggs-sec');
    $('#btn-aggs-toggle').addEventListener('click', () => {
      const collapsed = aggsSec.classList.toggle('collapsed');
      $('#btn-aggs-toggle').title = collapsed ? '展开聚合统计区' : '收起聚合统计区';
    });

    // 查询元素库整体抽屉：收起后左列收缩为 46px 窄轨（标题竖排），只留展开按钮
    const palettePanel = $('#palette');
    function setPaletteCollapsed(collapsed) {
      palettePanel.classList.toggle('collapsed', collapsed);
      $('#main').classList.toggle('palette-collapsed', collapsed);
      $('#btn-palette-toggle').title = collapsed ? '展开元素库' : '收起元素库';
    }
    $('#btn-palette-toggle').addEventListener('click', () => {
      setPaletteCollapsed(!palettePanel.classList.contains('collapsed'));
    });
    // 收起态下整条窄轨都是热区，点哪都能展开（点展开按钮自身则交给上面的处理器）
    palettePanel.addEventListener('click', (e) => {
      if (!palettePanel.classList.contains('collapsed')) return;
      if (e.target.closest('#btn-palette-toggle')) return;
      setPaletteCollapsed(false);
    });

    // 分组一键展开/收起
    $('#btn-cats-toggle').addEventListener('click', () => {
      const collapse = !(!paletteFilter.trim() && CATS.every((c) => collapsedCats[c.id]));
      for (const c of CATS) collapsedCats[c.id] = collapse;
      renderPalette();
    });

    // 查询结果抽屉
    $('#btn-run').addEventListener('click', triggerRun);
    $('#rs-close').addEventListener('click', closeResultDrawer);
    $('#rs-copy').addEventListener('click', copyResult);
    $('#rs-csv').addEventListener('click', resultCsv);
    $('#rs-source').addEventListener('change', () => { fillIndexList(true); syncRunBarClear(); syncActiveFromRunBar(); });
    attachIndexSuggest($('#rs-index'));
    $('#rs-index').addEventListener('input', () => { syncRunBarClear(); scheduleSyncActive(); });
    $('#rs-index').addEventListener('change', syncActiveFromRunBar);
    $('#rs-index').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // 浮层开着且有候选：Enter 是「选中」，不是「运行」
        if (ix && ix.items && ix.items.length) { ixPick(ix.active); return; }
        runSearch();
      }
    });
    // 顶栏「数据源 / 索引」的一键清空
    $('#rs-source-x').addEventListener('click', () => {
      $('#rs-source').value = '';
      fillIndexList(true);
      syncRunBarClear();
      syncActiveFromRunBar();
    });
    // 数据源下拉：自绘浮层（替代原生 select 弹层，风格与索引选择一致）
    const srcBtn = $('#rs-source-trigger');
    srcBtn.addEventListener('click', () => { srcPop ? srcClose() : srcOpen(); });
    srcBtn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!srcPop) srcOpen(); else srcMoveActive(1);
      } else if (e.key === 'ArrowUp') {
        if (srcPop) { e.preventDefault(); srcMoveActive(-1); }
      } else if (e.key === 'Enter') {
        if (srcPop) {
          e.preventDefault();
          const on = srcPop.pop.querySelector('.fs-item.on');
          if (on) srcPick(Number(on.dataset.i));
        }
      } else if (e.key === 'Escape') {
        if (srcPop) { e.preventDefault(); srcClose(); }
      }
    });
    $('#rs-index-x').addEventListener('click', () => {
      const i = $('#rs-index');
      i.value = '';
      ixClose();
      ixPicked = Date.now(); // 清空后回焦点时别立刻弹浮层
      syncRunBarClear();
      syncActiveFromRunBar();
      i.focus();
    });
    $('#rs-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]');
      if (!b) return;
      rs.tab = b.dataset.tab;
      if (window.ESCols) window.ESCols.close();
      document.querySelectorAll('#rs-tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === rs.tab));
      renderResult();
    });
    // 结果表格「查看明细」：行内按钮委托点击
    $('#rs-body').addEventListener('click', (e) => {
      const v = e.target.closest('[data-act="hit-view"]');
      if (v) { openHitDetail(+v.dataset.i); }
    });
    // 单条明细弹窗：关闭 / 复制
    $('#hit-close').addEventListener('click', closeHitDetail);
    $('#hit-mask').addEventListener('click', (e) => { if (e.target === $('#hit-mask')) closeHitDetail(); });
    $('#hit-body').addEventListener('click', (e) => {
      if (e.target.closest('[data-act="hit-copy-all"]')) { copyHitDoc('all'); return; }
      if (e.target.closest('[data-act="hit-copy-src"]')) { copyHitDoc('src'); return; }
    });
    // 表格「选择列」：按索引记忆展示列
    if (window.ESCols) {
      ESCols.attach($('#rs-cols'), {
        getAll: rsAllCols,
        getSel: () => rsVisibleCols(rsAllCols()).cols,
        onApply: (cols) => {
          ESCols.setPref(rsIndexName(), cols);
          renderResult();
        },
        onReset: () => {
          ESCols.setPref(rsIndexName(), null);
          renderResult();
        }
      });
    }

    // 结果区高度拖拽
    const rz2 = $('#rs-resizer');
    rz2.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const panel = $('#result-drawer');
      const startY = e.clientY;
      const startH = panel.offsetHeight;
      function mv2(ev) {
        panel.style.height = Math.max(160, Math.min(window.innerHeight - 260, startH + startY - ev.clientY)) + 'px';
      }
      function up2() {
        document.removeEventListener('mousemove', mv2);
        document.removeEventListener('mouseup', up2);
        rz2.classList.remove('active');
        document.body.style.cursor = '';
      }
      document.addEventListener('mousemove', mv2);
      document.addEventListener('mouseup', up2);
      rz2.classList.add('active');
      document.body.style.cursor = 'row-resize';
    });

    // 键盘
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        triggerRun();
        return;
      }
      // 弹窗显示时 Esc 一律关闭（焦点在输入框 / textarea 内也生效，与其余 7 个弹窗一致）
      if ($('#modal-mask').classList.contains('show')) {
        if (e.key === 'Escape') { e.preventDefault(); closeImport(); }
        return;
      }
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedId) { deleteNode(selectedId); e.preventDefault(); }
      } else if (e.key === 'Escape') {
        if ($('#modal-mask').classList.contains('show')) closeImport();
        else if ($('#hit-mask').classList.contains('show')) closeHitDetail();
        else { selectedId = null; renderTree(); renderInspector(); }
      }
    });
  }

  function clearDropHints() {
    document.querySelectorAll('.slot-body.hover').forEach((x) => x.classList.remove('hover'));
    document.querySelectorAll('.qnode.insert-before').forEach((x) => x.classList.remove('insert-before'));
    document.querySelectorAll('[data-drop="aggsroot"].hover').forEach((x) => x.classList.remove('hover'));
    const em = $('#empty-state');
    if (em) em.classList.remove('hover');
    treeEl.classList.remove('drop-root');
  }

  /* ---------------- 查询结果 ---------------- */
  const rs = {
    open: false,
    ready: false,       // E.init() 是否已完成
    sources: [],
    tab: 'table',
    result: null,       // ES 原始响应
    request: null,      // 本次实际发送的 { index, body }
    error: null,
    running: false,
    elapsed: 0,
    stale: false,
  };

  function rsMode() { return window.ESDC ? window.ESDC.getMode() : 'direct'; }

  // 实际发给 ES 的请求体（补齐 size / track_total_hits 默认值）
  function requestBody() {
    const b = exportBody();
    if (!b.size) b.size = 10;
    if (b.track_total_hits === undefined) b.track_total_hits = true;
    return b;
  }

  function loadResultSources() {
    const E = window.ESDC;
    if (!E) return Promise.resolve([]);
    return (rs.ready ? Promise.resolve(rsMode()) : E.init().then((m) => { rs.ready = true; return m; }))
      .then(() => E.Sources.list())
      .catch(() => []);
  }

  // 顶栏数据源 / 索引的清空按钮：有值才显示
  function syncRunBarClear() {
    [['#rs-source', '#rs-source-x'], ['#rs-index', '#rs-index-x']].forEach(([sel, x]) => {
      const el = $(sel);
      const box = el && el.parentElement;
      if (box && box.classList.contains('ctl')) box.classList.toggle('has', !!el.value);
    });
    srcRenderTrigger(); // 自绘数据源下拉的显示文本跟着隐藏 select 走
    // 索引名长了会被截断，悬停看全文
    const idx = $('#rs-index');
    if (idx) idx.title = idx.value || '要查询的索引，支持 a,b 与 *';
  }

  function fillResultSources() {
    const sel = $('#rs-source');
    if (!sel) return;
    const keep = sel.value;
    sel.innerHTML = '';
    if (!rs.sources.length) {
      sel.innerHTML = '<option value="">（无数据源）</option>';
      syncRunBarClear();
      return;
    }
    // 占位项，让清空按钮可以把选择还原成"未选择"
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '（未选择）';
    sel.appendChild(blank);
    rs.sources.forEach((s) => {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name + (s.readonly ? '（只读）' : '');
      sel.appendChild(o);
    });
    if (keep && rs.sources.some((s) => s.id === keep)) sel.value = keep;
    else if (activeSourceId && rs.sources.some((s) => s.id === activeSourceId)) sel.value = activeSourceId;
    syncRunBarClear();
    fillIndexList();
  }

  /* -------- 数据源下拉（自绘浮层，替代原生 select 弹层） --------
     原生 select 仍留在 DOM 里（视觉隐藏）当数据载体，所有既有读写逻辑不变；
     触发器按钮 + fs-pop 浮层负责展示与交互，选中后同步回隐藏 select 并派发 change。 */
  let srcPop = null; // { pop, items }

  // 触发器显示文本 = 隐藏 select 当前选中项的文案（空选时为「（未选择）/（无数据源）」）
  function srcRenderTrigger() {
    const btn = $('#rs-source-trigger');
    const val = $('#rs-source-val');
    const sel = $('#rs-source');
    if (!btn || !val || !sel) return;
    const empty = !sel.value;
    const text = sel.selectedIndex >= 0 && sel.options[sel.selectedIndex]
      ? sel.options[sel.selectedIndex].textContent
      : '（未选择）';
    val.textContent = text;
    btn.classList.toggle('empty', empty);
    btn.title = empty ? '选择数据源' : text;
  }

  function srcClose() {
    if (!srcPop) return;
    srcPop.pop.remove();
    const ctl = $('#rs-source-ctl');
    if (ctl) ctl.classList.remove('open');
    window.removeEventListener('scroll', srcPosition, true);
    window.removeEventListener('resize', srcPosition);
    document.removeEventListener('mousedown', srcOutside, true);
    srcPop = null;
  }

  function srcOutside(e) {
    if (!srcPop) return;
    if (srcPop.pop.contains(e.target)) return;
    const ctl = $('#rs-source-ctl');
    if (ctl && ctl.contains(e.target)) return;
    srcClose();
  }

  function srcPosition() {
    if (!srcPop) return;
    const ctl = $('#rs-source-ctl');
    if (!ctl) return;
    const r = ctl.getBoundingClientRect();
    const w = Math.min(340, Math.max(200, r.width + 28));
    srcPop.pop.style.width = w + 'px';
    const h = srcPop.pop.offsetHeight || 240;
    let top = r.bottom + 5;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 5);
    srcPop.pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - w)) + 'px';
    srcPop.pop.style.top = top + 'px';
  }

  function srcRender() {
    if (!srcPop) return;
    const sel = $('#rs-source');
    const cur = sel ? sel.value : '';
    const items = [{ id: '', label: '（未选择）', none: true }].concat(
      (rs.sources || []).map((s) => ({ id: s.id, label: s.name, ro: !!s.readonly })));
    srcPop.items = items;
    if (!rs.sources.length) {
      srcPop.pop.innerHTML =
        '<div class="fs-empty">还没有数据源<br>去「索引管理」视图添加一个集群</div>';
      return;
    }
    srcPop.pop.innerHTML = items.map((it, i) =>
      '<button type="button" class="fs-item src-item' + (it.id && it.id === cur ? ' on' : '') + '" data-i="' + i + '" title="' +
      esc(it.label) + '">' +
      '<span class="src-check' + (it.id && it.id === cur ? ' on' : '') + '"></span>' +
      '<span class="fs-path">' + esc(it.label) + '</span>' +
      (it.ro ? '<span class="src-tag">只读</span>' : '') +
      '</button>').join('');
    srcPosition();
  }

  function srcPick(i) {
    if (!srcPop || !srcPop.items[i]) return;
    const it = srcPop.items[i];
    const sel = $('#rs-source');
    if (!sel) return;
    if (sel.value === it.id) { srcClose(); return; }
    sel.value = it.id;
    // 走既有 change 链路：拉索引列表 / 同步清空按钮 / 同步字段联动
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    srcClose();
  }

  function srcOpen() {
    if (srcPop) { srcRender(); return; }
    const ctl = $('#rs-source-ctl');
    if (!ctl) return;
    const pop = el('div', 'fs-pop src-pop');
    pop.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.fs-item');
      if (item) { e.preventDefault(); srcPick(Number(item.dataset.i)); }
    });
    pop.addEventListener('mouseover', (e) => {
      if (!srcPop) return;
      const item = e.target.closest('.fs-item');
      if (!item || item.classList.contains('on')) return;
      const prev = srcPop.pop.querySelector('.fs-item.on');
      if (prev) prev.classList.remove('on');
      item.classList.add('on');
    });
    document.body.appendChild(pop);
    srcPop = { pop: pop, items: [] };
    ctl.classList.add('open');
    window.addEventListener('scroll', srcPosition, true);
    window.addEventListener('resize', srcPosition);
    document.addEventListener('mousedown', srcOutside, true);
    srcRender();
    srcPosition();
  }

  // 键盘 ↑↓ 移动高亮（触发器保持焦点，浮层跟着亮）
  function srcMoveActive(delta) {
    if (!srcPop || !srcPop.items.length) return;
    const items = srcPop.pop.querySelectorAll('.fs-item');
    let idx = -1;
    items.forEach((n, i) => { if (n.classList.contains('on')) idx = i; });
    const next = Math.max(0, Math.min(items.length - 1, idx + delta));
    items.forEach((n, i) => n.classList.toggle('on', i === next));
    if (items[next]) items[next].scrollIntoView({ block: 'nearest' });
  }

  // 索引候选（按数据源缓存；原生 datalist 样式不可控，改用自绘浮层）
  let ixList = null; // { srcId, loading, rows, error }
  let ix = null;     // { pop, items, active }
  let ixPicked = 0;  // 刚选中一条的时刻，压制随后 focus 重开浮层

  function ixJustPicked() { return ixPicked && Date.now() - ixPicked < 250; }

  function ixBusy(on) {
    const ctl = $('#rs-index-ctl');
    if (ctl) ctl.classList.toggle('loading', !!on);
  }

  function fillIndexList(force) {
    const sel = $('#rs-source');
    if (!sel) return;
    const src = rs.sources.find((s) => s.id === sel.value);
    if (!src || !window.ESDC) {
      ixList = null;
      ixBusy(false);
      ixRender();
      return;
    }
    if (!force && ixList && ixList.srcId === src.id && (ixList.loading || ixList.rows || ixList.error)) {
      ixRender(); // 已有（或正在拉）数据，浮层照常刷新
      return;
    }
    ixList = { srcId: src.id, loading: true, rows: [], error: null };
    ixBusy(true);
    ixRender();
    window.ESDC.transport(src).list()
      .then((rows) => {
        if (!ixList || ixList.srcId !== src.id) return; // 数据源已切换，过期响应丢弃
        ixList.loading = false;
        ixList.rows = (rows || []).filter((r) => r.index && r.index.charAt(0) !== '.');
        ixBusy(false);
        ixRender();
      })
      .catch((e) => {
        if (!ixList || ixList.srcId !== src.id) return;
        ixList.loading = false;
        ixList.error = e || new Error('加载失败');
        ixBusy(false);
        ixRender();
      });
  }

  /* -------- 索引选择浮层（顶栏「索引」输入框专属） -------- */
  function fmtBytes(n) {
    if (n === null || n === undefined || isNaN(Number(n))) return '';
    const v = Number(n);
    if (v < 1024) return v + ' B';
    if (v < 1048576) return (v / 1024).toFixed(1) + ' KB';
    if (v < 1073741824) return (v / 1048576).toFixed(1) + ' MB';
    return (v / 1073741824).toFixed(2) + ' GB';
  }
  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(Number(n))) return '';
    return Number(n).toLocaleString('en-US');
  }
  function ixHealthDot(r) {
    const h = (r.health || '').toLowerCase();
    return '<span class="ix-dot' + (h ? ' h-' + esc(h) : '') + '" title="' +
      esc((r.health || '未知') + ' · ' + (r.status || '')) + '"></span>';
  }

  function ixClose() {
    if (!ix) return;
    ix.pop.remove();
    const ctl = $('#rs-index-ctl');
    if (ctl) ctl.classList.remove('open');
    window.removeEventListener('scroll', ixPosition, true);
    window.removeEventListener('resize', ixPosition);
    document.removeEventListener('mousedown', ixOutside, true);
    ix = null;
  }

  function ixOutside(e) {
    if (!ix) return;
    if (ix.pop.contains(e.target)) return;
    const ctl = $('#rs-index-ctl');
    if (ctl && ctl.contains(e.target)) return;
    ixClose();
  }

  function ixPosition() {
    if (!ix) return;
    const ctl = $('#rs-index-ctl');
    if (!ctl) return;
    const r = ctl.getBoundingClientRect();
    const w = Math.min(430, Math.max(280, r.width + 24));
    ix.pop.style.width = w + 'px';
    const h = ix.pop.offsetHeight || 288;
    let top = r.bottom + 5;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 5);
    ix.pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - w)) + 'px';
    ix.pop.style.top = top + 'px';
  }

  // 输入 "a,b" 时按最后一段过滤，方便继续补全第二个索引
  function ixLastToken() {
    const raw = ($('#rs-index').value || '').trim();
    return raw.split(',').pop().trim().toLowerCase();
  }

  function ixRender() {
    if (!ix) return;
    if (!ixList) {
      ix.pop.innerHTML = '<div class="fs-empty">先选好数据源，再挑索引</div>';
      ix.items = [];
      return;
    }
    if (ixList.loading) {
      ix.pop.innerHTML = '<div class="ix-note"><span class="spin"></span>正在获取索引列表…</div>';
      ix.items = [];
      return;
    }
    if (ixList.error) {
      ix.pop.innerHTML =
        '<div class="ix-note err">索引列表加载失败：' + esc(ixList.error.message || String(ixList.error)) +
        '<button type="button" class="btn sm" data-act="retry">重试</button></div>';
      ix.items = [];
      return;
    }
    const q = ixLastToken();
    const all = ixList.rows || [];
    const items = q
      ? all.filter((r) => r.index.toLowerCase().indexOf(q) !== -1)
      : all;
    const capped = items.slice(0, 60);
    ix.items = capped;
    if (ix.active >= capped.length) ix.active = 0;
    if (!capped.length) {
      ix.pop.innerHTML = '<div class="fs-empty">' +
        (q ? '没有匹配「' + esc(q) + '」的索引' : '该数据源下没有索引') + '</div>';
      return;
    }
    ix.pop.innerHTML = capped.map((r, i) =>
      '<button type="button" class="fs-item ix-item' + (i === ix.active ? ' on' : '') + '" data-i="' + i + '" title="' +
      esc(r.index) + '">' +
      ixHealthDot(r) +
      '<span class="fs-path">' + esc(r.index) + '</span>' +
      '<span class="ix-meta">' +
      (r.docs !== null && r.docs !== undefined ? fmtNum(r.docs) + ' docs' : '') +
      (r.sizeBytes ? ' · ' + fmtBytes(r.sizeBytes) : '') +
      '</span>' +
      '</button>').join('') +
      (items.length > 60 ? '<div class="fs-foot">共 ' + items.length + ' 个索引，仅显示前 60，输入可继续过滤</div>' : '');
    ixPosition();
  }

  function ixPick(i) {
    if (!ix || !ix.items[i]) return;
    const r = ix.items[i];
    const inp = $('#rs-index');
    const raw = (inp.value || '').trim();
    // "a," 的场景：补全的是最后一段而不是整串覆盖
    if (raw && raw.slice(-1) === ',') inp.value = raw + r.index;
    else inp.value = r.index;
    ixPicked = Date.now();
    ixClose();
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    inp.focus();
  }

  function ixOpen() {
    if (ix) { ixRender(); return; }
    const inp = $('#rs-index');
    if (!inp) return;
    fillIndexList(); // 顺带确保当前数据源的列表已在加载
    const pop = el('div', 'fs-pop ix-pop');
    pop.addEventListener('mousedown', (e) => {
      const it = e.target.closest('.fs-item');
      if (it) { e.preventDefault(); ixPick(Number(it.dataset.i)); return; }
      const retry = e.target.closest('[data-act="retry"]');
      if (retry) { e.preventDefault(); fillIndexList(true); }
    });
    pop.addEventListener('mouseover', (e) => {
      if (!ix) return;
      const it = e.target.closest('.fs-item');
      if (!it || it.classList.contains('on')) return;
      const prev = ix.pop.querySelector('.fs-item.on');
      if (prev) prev.classList.remove('on');
      it.classList.add('on');
      ix.active = Number(it.dataset.i);
    });
    document.body.appendChild(pop);
    ix = { pop: pop, items: [], active: 0 };
    const ctl = $('#rs-index-ctl');
    if (ctl) ctl.classList.add('open');
    window.addEventListener('scroll', ixPosition, true);
    window.addEventListener('resize', ixPosition);
    document.addEventListener('mousedown', ixOutside, true);
    ixRender();
    ixPosition();
  }

  function attachIndexSuggest(inp) {
    inp.addEventListener('focus', () => { if (!ixJustPicked()) ixOpen(); });
    // 点击输入框也弹列表（用户直觉：这是个下拉选择器）
    inp.addEventListener('click', () => { if (!ix && !ixJustPicked()) ixOpen(); });
    inp.addEventListener('input', () => { if (!ixJustPicked()) { if (ix) ixRender(); else ixOpen(); } });
    inp.addEventListener('blur', () => {
      setTimeout(() => { if (ix) ixClose(); }, 160);
    });
    inp.addEventListener('keydown', (e) => {
      if (!ix) {
        if (e.key === 'ArrowDown') { ixOpen(); e.preventDefault(); }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = ix.items.length;
        if (!n) return;
        ix.active = e.key === 'ArrowDown' ? (ix.active + 1) % n : (ix.active - 1 + n) % n;
        ixRender();
        const cur = ix.pop.querySelector('.fs-item.on');
        if (cur) cur.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        ixClose();
      }
    });
    // 输入框右侧的 ▾：浏览完整索引列表
    const dd = $('#rs-index-dd');
    if (dd) dd.addEventListener('click', () => {
      if (ix) ixClose(); else { ixOpen(); inp.focus(); }
    });
  }

  // 顶栏的数据源下拉要在进页面时就可用，不能等抽屉打开
  function primeRunBar() {
    loadResultSources().then((list) => {
      rs.sources = list || [];
      fillResultSources();
    });
  }

  function openResultDrawer(autoRun) {
    const drawer = $('#result-drawer');
    const rsz = $('#rs-resizer');
    if (!drawer) return;
    drawer.hidden = false;
    if (rsz) rsz.hidden = false;
    rs.open = true;
    const badge = $('#rs-target');
    if (badge) badge.textContent = '…';
    if (!$('#rs-index').value && activeIndex) $('#rs-index').value = activeIndex;
    syncRunBarClear();
    loadResultSources().then((list) => {
      rs.sources = list || [];
      fillResultSources();
      // 模式要在 init() 之后才准
      if (badge) badge.textContent = rsMode() === 'server' ? '服务端代理' : '浏览器直连';
      if (autoRun && $('#rs-index').value) runSearch();
    });
    renderResult();
  }

  // 顶栏「运行」/ Ctrl+Enter 的统一入口：抽屉没开就先开，开了就直接跑
  function triggerRun() {
    const idx = $('#rs-index');
    if (rs.open) {
      if (idx && idx.value.trim()) runSearch();
      else openResultDrawer(false);
    } else {
      openResultDrawer(!!(activeIndex || (idx && idx.value)));
    }
  }

  function closeResultDrawer() {
    const drawer = $('#result-drawer');
    const rsz = $('#rs-resizer');
    if (drawer) drawer.hidden = true;
    if (rsz) rsz.hidden = true;
    rs.open = false;
  }

  function currentSource() {
    const id = $('#rs-source') ? $('#rs-source').value : '';
    return rs.sources.find((s) => s.id === id) || null;
  }

  function runSearch() {
    const E = window.ESDC;
    const idxInput = $('#rs-index');
    const index = (idxInput.value || '').trim();
    if (!index) { toast('请先填写索引名'); idxInput.focus(); return; }
    const src = currentSource();
    if (!src) { toast('请先在索引管理里添加一个数据源'); return; }
    if (rs.running) return;

    const body = requestBody();
    rs.sentSig = JSON.stringify(body);

    rs.running = true;
    rs.error = null;
    rs.result = null;
    rs.request = { index: index, body: body };
    rs.stale = false;
    const btnRun = $('#btn-run');
    if (btnRun) btnRun.classList.add('busy');
    renderResult();

    const t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    E.transport(src).search(index, body)
      .then((data) => {
        const t1 = (window.performance && performance.now) ? performance.now() : Date.now();
        rs.elapsed = Math.round(t1 - t0);
        rs.result = data;
        // 带了聚合：或没有命中文档时，直接展示聚合页签
        const hasAggsReq = body.aggs !== undefined;
        if (data && data.aggregations && (hasAggsReq || !((data.hits && data.hits.hits) || []).length)) rs.tab = 'aggs';
        rs.running = false;
        if (btnRun) btnRun.classList.remove('busy');
        renderResult();
      })
      .catch((e) => {
        const t1 = (window.performance && performance.now) ? performance.now() : Date.now();
        rs.elapsed = Math.round(t1 - t0);
        rs.error = e;
        rs.running = false;
        if (btnRun) btnRun.classList.remove('busy');
        renderResult();
      });
  }

  function resultColumns(rows) {
    const seen = [];
    rows.forEach((r) => {
      Object.keys(flattenDoc(r.source)).forEach((k) => { if (seen.indexOf(k) < 0) seen.push(k); });
    });
    return { cols: seen, flat: rows.map((r) => flattenDoc(r.source)) };
  }

  // 当前查询目标索引名（列偏好按它记忆）
  function rsIndexName() {
    if (rs.request && rs.request.index) return rs.request.index;
    const i = $('#rs-index');
    return i ? i.value.trim() : '';
  }

  // 当前结果的全部可用列
  function rsAllCols() {
    const res = rs.result;
    if (!res || !(res.hits && res.hits.hits)) return [];
    return resultColumns(res.hits.hits.map((h2) => ({ id: h2._id, score: h2._score, source: h2._source || {} }))).cols;
  }

  // 表格当前展示列（偏好 → 默认前 14）
  function rsVisibleCols(allCols) {
    return ESCols.visible(allCols, rsIndexName());
  }

  function renderStatus() {
    const box = $('#rs-status');
    if (!box) return;
    if (rs.running) { box.innerHTML = '<span class="warn spin-row"><span class="spin-sm"></span>执行中…</span>'; return; }
    if (rs.error) {
      const e = rs.error;
      box.innerHTML = '<span class="bad">查询失败</span><span>' + esc(e.message || String(e)) + '</span>';
      return;
    }
    if (!rs.result) {
      box.innerHTML = '<span>填好索引后点「运行」，会用右侧生成的 DSL 直接查 ES</span>';
      return;
    }
    const h = rs.result.hits || {};
    const total = h.total === undefined ? 0 : (typeof h.total === 'object' ? h.total.value : h.total);
    const rel = (h.total && typeof h.total === 'object' && h.total.relation === 'gte') ? '≥ ' : '';
    const got = (h.hits || []).length;
    const sh = rs.result._shards || {};
    box.innerHTML =
      '<span>命中 <b>' + rel + Number(total || 0).toLocaleString('en-US') + '</b> 条</span>' +
      '<span>返回 <b>' + got + '</b> 条</span>' +
      '<span>最高分 <b>' + (h.max_score === null || h.max_score === undefined ? '—' : Number(h.max_score).toFixed(4)) + '</b></span>' +
      '<span>耗时 <b>' + (rs.result.took === undefined ? rs.elapsed : rs.result.took) + 'ms</b>' +
      (rs.elapsed ? '（含网络 ' + rs.elapsed + 'ms）' : '') + '</span>' +
      '<span>分片 <b>' + (sh.successful === undefined ? '—' : sh.successful + '/' + (sh.total || '—') + ' 成功') + '</b></span>' +
      (rs.result.timed_out ? '<span class="bad">timed_out</span>' : '') +
      (rs.stale ? '<span class="warn">● DSL 已修改，结果可能过期</span>' : '');
  }

  function renderResult() {
    const body = $('#rs-body');
    if (!body) return;
    // rs.tab 可能被运行结果自动切换（如带了聚合），这里同步按钮高亮
    document.querySelectorAll('#rs-tabs button[data-tab]').forEach((x) => x.classList.toggle('on', x.dataset.tab === rs.tab));
    renderStatus();
    syncColsBtn(null, 0); // 先隐藏，表格分支再按需点亮

    if (rs.running) {
      body.innerHTML = '<div class="rs-hint"><span class="spin big"></span><div class="big">执行中…</div>正在向 Elasticsearch 发送请求</div>';
      return;
    }

    if (rs.error) {
      const e = rs.error;
      let hint = '';
      if (e.kind === 'network') {
        hint = '直连模式下最常见的原因是 ES 未开启 CORS（elasticsearch.yml 里设置 http.cors.enabled: true 且 http.cors.allow-origin 包含本页地址）。改用 <code>python server.py</code> 启动即可彻底避开。';
      } else if (e.kind === 'timeout') {
        hint = '查询太慢或数据量过大。可调小 size、加过滤条件，或提高服务端超时：ESDSL_ES_TIMEOUT=60。';
      } else if (e.kind === 'auth') {
        hint = '服务端设置了访问令牌，在右上角或弹出的令牌框里填写 ESDSL_TOKEN。';
      }
      const payload = e.payload ? JSON.stringify(e.payload, null, 2) : '';
      body.innerHTML =
        '<div class="rs-err"><div class="t">查询失败</div>' +
        '<div>' + esc(e.message || String(e)) + '</div>' +
        (hint ? '<div style="margin-top:8px">' + hint + '</div>' : '') +
        (payload ? '<pre>' + esc(payload.slice(0, 2000)) + '</pre>' : '') +
        '</div>';
      return;
    }

    if (!rs.result) {
      body.innerHTML =
        '<div class="rs-hint"><div class="big">还没有结果</div>' +
        '选好数据源和索引，点「运行」就会把右侧的 DSL 原样发给 ES。<br>' +
        '快捷键 Ctrl+Enter。没有数据源？先去「索引管理」里添加一个。</div>';
      return;
    }

    const res = rs.result;
    if (rs.tab === 'raw') {
      body.innerHTML = '<pre class="rs-json">' + highlight(JSON.stringify(res, null, 2)) + '</pre>';
      return;
    }
    if (rs.tab === 'req') {
      body.innerHTML = '<pre class="rs-json">' + highlight(JSON.stringify(rs.request || {}, null, 2)) + '</pre>';
      return;
    }
    if (rs.tab === 'aggs') {
      const metrics = aggMetricList(res.aggregations);
      const rows = aggRows(res.aggregations);
      let h = '';
      // 指标卡片：单值 / stats / percentiles
      if (metrics.length) {
        h += '<div class="agg-cards">';
        metrics.forEach((m) => {
          h += '<div class="agg-card"><div class="agg-card-h">' + esc(m.name) + '</div><div class="agg-card-v">';
          m.values.forEach((v) => {
            h += '<span class="agg-kv"><b>' + esc(v.k) + '</b><i>' + esc(cellText(v.v)) + '</i></span>';
          });
          h += '</div></div>';
        });
        h += '</div>';
      }
      if (!rows.length) {
        if (!metrics.length) {
          body.innerHTML = '<div class="rs-empty">本次查询没有聚合结果。<br>在画布下方「聚合统计」区添加聚合节点（或点「导入 JSON」粘贴带 <code>aggs</code> 的 DSL），再运行。</div>';
          return;
        }
        body.innerHTML = h;
        return;
      }
      // 分布条：桶行按 doc_count 占最大值的比例
      const maxCount = rows.reduce((mx, r) => Math.max(mx, typeof r.count === 'number' ? r.count : 0), 0);
      h += '<table class="rs-table"><thead><tr><th>聚合</th><th>桶 / 值</th><th class="agbar-th">分布</th><th class="num">文档数</th></tr></thead><tbody>';
      rows.slice(0, 500).forEach((r) => {
        const bar = (typeof r.count === 'number' && maxCount > 0)
          ? '<div class="agbar" title="' + esc(r.count) + ' / ' + maxCount + '"><i style="width:' + (r.count / maxCount * 100).toFixed(1) + '%"></i></div>'
          : '';
        h += '<tr><td class="mono">' + esc(r.agg) + '</td><td>' + esc(cellText(r.key)) + '</td><td>' + bar + '</td><td class="num">' + esc(cellText(r.count)) + '</td></tr>';
      });
      h += '</tbody></table>';
      if (rows.length > 500) h += '<div class="rs-empty">仅显示前 500 行，共 ' + rows.length + ' 行</div>';
      body.innerHTML = h;
      return;
    }

    // 表格
    const hits = (res.hits && res.hits.hits) || [];
    if (!hits.length) {
      syncColsBtn(null, 0);
      body.innerHTML = '<div class="rs-empty">没有匹配的文档（hits 为空）</div>';
      return;
    }
    const rows = hits.map((h2) => ({ id: h2._id, score: h2._score, source: h2._source || {}, extra: h2 }));
    const info = resultColumns(rows);
    const vis = rsVisibleCols(info.cols);
    const cols = vis.cols;
    syncColsBtn(vis, info.cols.length);
    let h = '<table class="rs-table"><thead><tr><th>_id</th><th class="num">_score</th>';
    cols.forEach((c) => { h += '<th>' + esc(c) + '</th>'; });
    h += '<th class="hit-col">明细</th></tr></thead><tbody>';
    rows.forEach((r, i) => {
      h += '<tr><td class="mono">' + esc(r.id) + '</td><td class="num">' +
        (r.score === null || r.score === undefined ? '—' : Number(r.score).toFixed(4)) + '</td>';
      cols.forEach((c) => {
        const v = info.flat[i][c];
        const txt = v === undefined ? '' : cellText(v);
        h += '<td title="' + esc(txt) + '">' + (txt === '' ? '<span style="color:var(--faint)">—</span>' : esc(txt)) + '</td>';
      });
      h += '<td class="hit-col"><button class="rs-view" data-act="hit-view" data-i="' + i + '">查看</button></td>';
      h += '</tr>';
    });
    h += '</tbody></table>';
    if (vis.saved) {
      if (cols.length < info.cols.length) h += '<div class="rs-empty">已选 ' + cols.length + ' / ' + info.cols.length + ' 列（点「选择列」调整，设置按索引记忆）</div>';
      else h += '<div class="rs-empty">已展示全部 ' + info.cols.length + ' 列</div>';
    } else if (info.cols.length > ESCols.DEFAULT_N) {
      h += '<div class="rs-empty">字段较多，默认显示前 ' + ESCols.DEFAULT_N + ' 列（共 ' + info.cols.length + ' 列），点右上「选择列」可挑要看的</div>';
    }
    body.innerHTML = h;
  }

  // 结果抽屉「选择列」按钮：同步显隐与计数徽标
  function syncColsBtn(vis, allN) {
    const btn = $('#rs-cols');
    if (!btn) return;
    const show = rs.tab === 'table' && !!vis && allN > 0;
    btn.hidden = !show;
    if (show) ESCols.badge(btn, '选择列', vis.cols.length, allN);
  }

  // 查询结果：单条文档明细弹窗
  function hitMetaRows(hit) {
    const keys = ['_index', '_score', '_type', '_version', '_seq_no', '_primary_term', '_routing'];
    let h = '';
    keys.forEach((k) => {
      if (hit[k] === undefined || hit[k] === null) return;
      let val = hit[k];
      if (k === '_score' && val !== null) val = Number(val).toFixed(4);
      h += '<span class="hit-kv"><b>' + esc(k) + '</b><i class="mono">' + esc(String(val)) + '</i></span>';
    });
    return h;
  }

  function openHitDetail(i) {
    const res = rs.result;
    if (!res || !res.hits || !res.hits.hits) return;
    const hit = res.hits.hits[i];
    if (!hit) return;
    $('#hit-mask').dataset.idx = String(i);
    $('#hit-meta-id').textContent = hit._id || '(无 _id)';
    const meta = hitMetaRows(hit);
    $('#hit-body').innerHTML =
      '<div class="hit-meta">' + (meta || '<span class="dim">无额外元信息</span>') + '</div>' +
      '<div class="hit-actions">' +
        '<button class="btn sm" data-act="hit-copy-all">复制完整文档</button>' +
        '<button class="btn sm" data-act="hit-copy-src">仅复制 _source</button>' +
      '</div>' +
      '<pre class="json-view" id="hit-src">' + highlight(JSON.stringify(hit._source || {}, null, 2)) + '</pre>';
    $('#hit-mask').classList.add('show');
  }

  function closeHitDetail() { $('#hit-mask').classList.remove('show'); }

  function copyHitDoc(which) {
    const i = +($('#hit-mask').dataset.idx || '-1');
    const res = rs.result;
    if (!res || !res.hits || !res.hits.hits) return;
    const hit = res.hits.hits[i];
    if (!hit) return;
    const text = which === 'src'
      ? JSON.stringify(hit._source || {}, null, 2)
      : JSON.stringify(hit, null, 2);
    const done = () => toast(which === 'src' ? '已复制 _source' : '已复制完整文档');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }

  function resultCsv() {
    const res = rs.result;
    if (!res) { toast('还没有可导出的结果'); return; }
    let rows = [];
    let cols = [];
    if (rs.tab === 'aggs') {
      rows = aggRows(res.aggregations);
      cols = ['agg', 'key', 'count'];
    } else {
      const hits = (res.hits && res.hits.hits) || [];
      const info = resultColumns(hits.map((h2) => ({ id: h2._id, score: h2._score, source: h2._source || {} })));
      const vis = rsVisibleCols(info.cols).cols; // 与表格所见一致
      cols = ['_id', '_score'].concat(vis);
      rows = info.flat.map((f, i) => {
        const o = { _id: hits[i]._id, _score: hits[i]._score };
        vis.forEach((c) => { o[c] = f[c]; });
        return o;
      });
    }
    const q = (v) => {
      const s = v === undefined || v === null ? '' : cellText(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const text = [cols.map(q).join(',')].concat(rows.map((r) => cols.map((c) => q(r[c])).join(','))).join('\r\n');
    const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'es-result.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出 es-result.csv');
  }

  function copyResult() {
    if (!rs.result) { toast('还没有可复制的结果'); return; }
    const text = JSON.stringify(rs.result, null, 2);
    const done = () => toast('已复制响应 JSON');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }

  /* ---------------- 索引联动 ---------------- */
  let activeIndex = '';
  let activeSourceId = '';
  let activeSourceName = '';
  let chipSeq = 0;
  let chipTimer = 0;
  // 字段联想数据：[{path, type}]，带类型供下拉浮层展示
  let fieldHints = [];

  function normalizeFields(list) {
    return (list || []).map((f) => (typeof f === 'string' ? { path: f, type: '' } : { path: f.path, type: f.type || '' }));
  }

  // 清掉字段联想（chip + 下拉数据）；clearRunBar 为 true 时连顶栏索引一起清
  function clearActiveIndex(clearRunBar) {
    activeIndex = '';
    activeSourceId = '';
    activeSourceName = '';
    fieldHints = [];
    fsClose();
    const chip = $('#active-index-chip');
    if (chip) { chip.hidden = true; chip.innerHTML = ''; chip.classList.remove('loading'); }
    if (clearRunBar) {
      const rsIdx = $('#rs-index');
      if (rsIdx) rsIdx.value = '';
      syncRunBarClear();
    }
  }

  // 由索引管理视图调用：把选中索引的字段灌进联想数据，字段输入框即可联想；
  // 同时把顶栏「数据源 + 索引」同步成该索引 —— 两处永远指向同一个查询目标
  function setActiveIndex(info) {
    info = info || {};
    const chip = $('#active-index-chip');
    if (!chip) return;
    chip.classList.remove('loading'); // 从「读取中」占位切到正式内容
    activeIndex = info.index || '';
    activeSourceId = info.sourceId || '';
    activeSourceName = info.source || '';
    fieldHints = normalizeFields(info.fields);
    chipSeq++; // 外部设定优先，取消进行中的自动探测

    if (activeIndex) {
      chip.hidden = false;
      chip.title = (activeSourceName ? activeSourceName + ' / ' : '') + activeIndex +
        ' · 点击去索引管理查看，✕ 解除联动';
      chip.innerHTML =
        (activeSourceName ? `<span class="chip-k">${esc(activeSourceName)}</span>` : '') +
        `<b class="mono">${esc(activeIndex)}</b>` +
        `<span class="chip-n">${fieldHints.length} 字段</span>` +
        `<button class="chip-x" title="解除联动并清空">✕</button>`;
      chip.querySelector('.chip-x').addEventListener('click', (e) => {
        e.stopPropagation();
        clearActiveIndex(true);
        toast('已解除字段联想');
      });
      chip.onclick = () => {
        if (!activeSourceId || !activeIndex) return;
        switchView('index');
        const B = window.ESIndexBrowser;
        if (B && B.locate) B.locate(activeSourceId, activeIndex);
      };
    } else {
      chip.hidden = true;
    }

    // 反向同步顶栏运行目标：数据源下拉 + 索引输入
    const rsSrc = $('#rs-source');
    const rsIdx = $('#rs-index');
    if (rsSrc && activeSourceId) {
      const has = [].slice.call(rsSrc.options).some((o) => o.value === activeSourceId);
      if (has) rsSrc.value = activeSourceId;
    }
    if (rsIdx && activeIndex) rsIdx.value = activeIndex;
    syncRunBarClear();
  }

  // 反方向联动：顶栏改了 数据源 / 索引 → 自动拉取该索引的字段映射，
  // 灌进字段联想并点亮查询树头部的「当前索引」徽标；拉不到就安静地撤掉徽标
  function syncActiveFromRunBar() {
    const E = window.ESDC;
    const srcSel = $('#rs-source');
    const rsIdx = $('#rs-index');
    if (!E || !srcSel || !rsIdx) return;
    const srcId = srcSel.value;
    const raw = (rsIdx.value || '').trim();
    const index = raw.split(',')[0].trim();
    // 多索引 / 通配 / 没选数据源时无法定位唯一索引，只清字段联想，不动运行目标
    const usable = srcId && index && !/[,?*]/.test(raw);
    if (!usable) {
      if (activeIndex) clearActiveIndex(false);
      return;
    }
    if (activeSourceId === srcId && activeIndex === index) return;
    const src = rs.sources.find((s) => s.id === srcId);
    if (!src) { if (activeIndex) clearActiveIndex(false); return; }
    const seq = ++chipSeq;
    // 拉取映射期间先亮一个「读取中」的占位徽标，别让用户以为没反应
    const loadingChip = $('#active-index-chip');
    if (loadingChip) {
      loadingChip.hidden = false;
      loadingChip.classList.add('loading');
      loadingChip.title = '正在读取 ' + esc(index) + ' 的字段映射';
      loadingChip.innerHTML = '<span class="spin-sm"></span><span class="chip-n">读取 ' + esc(index) + ' 字段映射…</span>';
    }
    E.transport(src).detail(index).then((resp) => {
      if (seq !== chipSeq) return; // 期间用户又改了目标，过期响应丢弃
      const d = E.parseDetail(resp, index) || {};
      if (!(d.fields || []).length) { clearActiveIndex(false); return; }
      setActiveIndex({ index: index, source: src.name, sourceId: src.id, fields: d.fields });
    }).catch(() => {
      if (seq === chipSeq) clearActiveIndex(false);
    });
  }

  function scheduleSyncActive() {
    clearTimeout(chipTimer);
    chipTimer = setTimeout(syncActiveFromRunBar, 450);
  }

  /* ---------------- 字段联想浮层（带类型徽标） ---------------- */
  // 原生 datalist 只能显示纯文本，展示不了字段类型；这里用自绘浮层替代。
  // fieldEl() 里 field / fields / path 输入框统一挂 attachFieldSuggest(input)。
  let fs = null; // { inp, pop, items, active }
  let fsPicked = 0; // 刚完成一次选择的时刻，用于压制紧随其后的重开

  function fsJustPicked() { return fsPicked && Date.now() - fsPicked < 200; }

  function fsClose() {
    if (!fs) return;
    fs.pop.remove();
    window.removeEventListener('scroll', fsPosition, true);
    window.removeEventListener('resize', fsPosition);
    fs = null;
  }

  function fsPosition() {
    if (!fs) return;
    const r = fs.inp.getBoundingClientRect();
    const w = Math.min(440, Math.max(260, r.width));
    fs.pop.style.width = w + 'px';
    const h = fs.pop.offsetHeight || 288;
    // 下方放不下（属性面板贴屏幕底）就翻到输入框上方，别盖住输入框本身
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    fs.pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - w)) + 'px';
    fs.pop.style.top = top + 'px';
  }

  function fsTypeBadge(t) {
    const E = window.ESDC;
    const g = E && E.typeGroup ? E.typeGroup(t) : 'other';
    return '<span class="ftype g-' + g + '">' + esc(t || '—') + '</span>';
  }

  function fsMatches(q) {
    if (!q) return fieldHints.slice();
    const starts = [];
    const contains = [];
    for (const f of fieldHints) {
      const p = f.path.toLowerCase();
      const last = p.split('.').pop();
      if (p.startsWith(q) || last.startsWith(q)) starts.push(f);
      else if (p.indexOf(q) !== -1) contains.push(f); // 输入 name 也能联想 author.name
    }
    return starts.concat(contains);
  }

  function fsRender() {
    if (!fs) return;
    const q = fs.inp.value.trim().toLowerCase();
    const items = fsMatches(q);
    const capped = items.slice(0, 60);
    fs.items = capped;
    if (fs.active >= capped.length) fs.active = 0;
    if (!capped.length) {
      fs.pop.innerHTML = fieldHints.length
        ? '<div class="fs-empty">没有匹配「' + esc(fs.inp.value.trim()) + '」的字段</div>'
        : '<div class="fs-empty">先在顶栏选好数据源和索引，字段联想会自动出现</div>';
      return;
    }
    fs.pop.innerHTML = capped.map((f, i) =>
      '<button type="button" class="fs-item' + (i === fs.active ? ' on' : '') + '" data-i="' + i + '" title="' +
      esc(f.path) + (f.type ? ' · ' + esc(f.type) : '') + '">' +
      '<span class="fs-path">' + esc(f.path) + '</span>' + fsTypeBadge(f.type) +
      '</button>').join('') +
      (items.length > 60 ? '<div class="fs-foot">共 ' + items.length + ' 项，仅显示前 60，输入可继续过滤</div>' : '');
    fsPosition(); // 条目数变了高度也变，重新对位
  }

  function fsPick(i) {
    if (!fs || !fs.items[i]) return;
    const f = fs.items[i];
    const inp = fs.inp;
    inp.value = f.path;
    fsPicked = Date.now(); // 选完就收起，别被随后的 input/focus 事件又顶开
    fsClose();
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.focus();
  }

  function fsOpen(inp) {
    if (fs && fs.inp === inp) { fsRender(); return; }
    fsClose();
    if (!fieldHints.length) return; // 没有字段数据不弹空浮层
    const pop = el('div', 'fs-pop');
    pop.addEventListener('mousedown', (e) => {
      e.preventDefault(); // 抢在 blur 之前，点击不会让浮层先消失
      const it = e.target.closest('.fs-item');
      if (it) fsPick(Number(it.dataset.i));
    });
    pop.addEventListener('mouseover', (e) => {
      if (!fs) return;
      const it = e.target.closest('.fs-item');
      if (!it || it.classList.contains('on')) return;
      const prev = fs.pop.querySelector('.fs-item.on');
      if (prev) prev.classList.remove('on');
      it.classList.add('on');
      fs.active = Number(it.dataset.i);
    });
    document.body.appendChild(pop);
    fs = { inp: inp, pop: pop, items: [], active: 0 };
    window.addEventListener('scroll', fsPosition, true);
    window.addEventListener('resize', fsPosition);
    fsRender();
    fsPosition();
  }

  function attachFieldSuggest(inp) {
    inp.addEventListener('focus', () => { if (!fsJustPicked()) fsOpen(inp); });
    inp.addEventListener('focusin', () => { if (!fsJustPicked()) fsOpen(inp); });
    inp.addEventListener('input', () => {
      if (fsJustPicked()) return;
      if (fs && fs.inp === inp) fsRender(); else fsOpen(inp);
    });
    inp.addEventListener('blur', () => {
      // mousedown 已 preventDefault，正常点选不会触发；这里兜底收起
      setTimeout(() => { if (fs && fs.inp === inp) fsClose(); }, 160);
    });
    inp.addEventListener('keydown', (e) => {
      if (!fs || fs.inp !== inp) {
        if (e.key === 'ArrowDown' && fieldHints.length) { fsOpen(inp); e.preventDefault(); }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = fs.items.length;
        if (!n) return;
        fs.active = e.key === 'ArrowDown' ? (fs.active + 1) % n : (fs.active - 1 + n) % n;
        fsRender();
        const cur = fs.pop.querySelector('.fs-item.on');
        if (cur) cur.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        fsPick(fs.active);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        fsClose();
      }
    });
  }

  /* ---------------- 视图切换 ---------------- */
  function switchView(v) {
    const isIndex = v === 'index';
    ixClose(); // 顶栏运行目标在索引管理视图不可见，浮层一并收起
    document.body.classList.toggle('view-index', isIndex);
    document.querySelectorAll('#viewswitch button').forEach((b) => {
      b.classList.toggle('on', b.dataset.view === v);
    });
    try {
      const want = isIndex ? '#index' : '';
      if ((location.hash || '') !== want) {
        history.replaceState(null, '', want || (location.pathname + location.search));
      }
    } catch (e) { /* file:// 下忽略 */ }
    if (isIndex) {
      // index-browser.js 是独立脚本，可能尚未执行完；onShow 自带幂等保护
      if (window.ESIndexBrowser) window.ESIndexBrowser.onShow();
      else setTimeout(() => { if (window.ESIndexBrowser) window.ESIndexBrowser.onShow(); }, 60);
    }
  }

  window.ESStudio = { setActiveIndex, switchView };

  /* ---------------- 版本更新检查 ---------------- */
  // 请求与版本比较都在服务端做：浏览器端走 server.py、桌面端走 api.rs（esdsl://
  // 自定义协议的同一套 /api/* 路由），同名同构。前端 fetch 相对路径即可，
  // 不需要直连 api.github.com，也就没有跨域 / 限流问题。
  const RELEASES_URL = 'https://github.com/fireflyhoo/es-dsl-studio/releases';
  const UPDATE_CACHE_KEY = 'esdsl.update.v1';

  function applyUpdate(hasUpdate, latest) {
    const el = $('#update-indicator');
    if (!el) return;
    if (hasUpdate && latest) {
      el.classList.add('show');
      const tip = '发现新版本 ' + latest + '，点击前往下载';
      el.title = tip;
      el.setAttribute('aria-label', tip);
    } else {
      el.classList.remove('show');
    }
  }
  async function checkUpdate() {
    const el = $('#update-indicator');
    if (!el) return;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      window.open(RELEASES_URL, '_blank', 'noopener');
    });
    const now = Date.now();
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(UPDATE_CACHE_KEY) || 'null'); } catch (e) { cached = null; }
    if (cached) {
      const age = now - (cached.checkedAt || 0);
      if (cached.latest && age < 24 * 3600 * 1000) { applyUpdate(cached.hasUpdate, cached.latest); return; }
      if (!cached.latest && age < 3600 * 1000) return; // 失败 / 暂未发布，1h 内不再打扰
    }
    let latest = null, hasUpdate = false;
    try {
      const res = await fetch('/api/update-check', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data && data.ok) {
          latest = data.latest || null;
          hasUpdate = !!data.hasUpdate && !!latest;
        }
      }
    } catch (e) { /* 网络异常 / 服务端未实现该路由，静默忽略 */ }
    try {
      localStorage.setItem(UPDATE_CACHE_KEY, JSON.stringify({ checkedAt: now, latest, hasUpdate }));
    } catch (e) { /* 隐私模式忽略 */ }
    applyUpdate(hasUpdate, latest);
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
    primeRunBar();
    checkUpdate(); // 异步检查新版本，失败静默，不阻塞 UI
    // 支持 #index 深链；延后一拍等 index-browser.js 注册完成
    if (location.hash === '#index') setTimeout(() => switchView('index'), 0);
  }
  init();
})();
