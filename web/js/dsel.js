/* ============================================================
 * ES DSL Studio - 自绘下拉（原生 select 的统一替代）
 *
 * 机制：原生 select 仍留在 DOM 里（视觉隐藏）当数据载体，所有既有
 * change 事件链路不变；触发器按钮 + fs-pop 浮层负责展示与交互，
 * 选中后同步回隐藏 select 并派发 change。
 *
 * 容器重绘会重建 DOM，浮层跟随失效，故每次重绘所在容器先 close 再 upgrade。
 *
 * 覆盖位置（kind → 场景）：
 *   field  数据 tab 筛选-字段        op   数据 tab 筛选-操作符
 *   logic  数据 tab 筛选-AND/OR      size 数据 tab 筛选-每页条数
 *   type   字段映射页类型筛选 / 批量字段编辑-新增行类型
 *   bool   记录弹窗-布尔字段         param 查询构建器-参数下拉（SEL，预留）
 *   form   表单通栏下拉（数据源弹窗-认证方式 / 新建索引弹窗-数据源）
 *   tth    DSL 工具栏-total_hits
 * ============================================================ */
(function () {
  'use strict';

  const SELECTOR = [
    'select.data-cond-field', 'select.data-cond-op', 'select.data-logic',
    'select.data-size', 'select#fld-type', 'select.doc-bool', 'select.be-type',
    'select.qp-select', 'select#ds-auth', 'select#ix-source', 'select#set-tth',
  ].join(', ');

  function h(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 选项类型徽标渲染器由 index-browser 注册（字段下拉浮层用；其余场景无徽标）
  let badgeRenderer = null;
  function setBadgeRenderer(fn) { badgeRenderer = fn; }

  let pop = null; // { pop, wrap, sel, btn, items, minW }

  function kindOf(sel) {
    if (sel.id === 'fld-type') return 'type';
    if (sel.id === 'ds-auth' || sel.id === 'ix-source') return 'form';
    if (sel.id === 'set-tth') return 'tth';
    if (sel.classList.contains('data-cond-field')) return 'field';
    if (sel.classList.contains('data-cond-op')) return 'op';
    if (sel.classList.contains('data-logic')) return 'logic';
    if (sel.classList.contains('be-type')) return 'type';
    if (sel.classList.contains('doc-bool')) return 'bool';
    if (sel.classList.contains('qp-select')) return 'param';
    return 'size';
  }

  function itemsOf(sel) {
    return Array.prototype.map.call(sel.options, (o) => ({
      value: o.value,
      label: o.textContent,
      sel: o.selected,
      type: o.dataset.type || '',
    }));
  }

  function close() {
    if (!pop) return;
    pop.pop.remove();
    pop.wrap.classList.remove('open');
    window.removeEventListener('scroll', position, true);
    window.removeEventListener('resize', position);
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', key, true);
    pop = null;
  }

  function outside(e) {
    if (!pop) return;
    if (pop.pop.contains(e.target)) return;
    if (pop.wrap.contains(e.target)) return;
    close();
  }

  function position() {
    if (!pop) return;
    const r = pop.btn.getBoundingClientRect();
    const w = Math.max(r.width, pop.minW);
    pop.pop.style.width = w + 'px';
    const hgt = pop.pop.offsetHeight || 220;
    let top = r.bottom + 5;
    if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 5);
    pop.pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - w)) + 'px';
    pop.pop.style.top = top + 'px';
  }

  function render() {
    if (!pop) return;
    pop.items = itemsOf(pop.sel);
    if (!pop.items.length) {
      pop.pop.innerHTML = '<div class="fs-empty">没有可选项</div>';
      position();
      return;
    }
    pop.pop.innerHTML = pop.items.map((it, i) =>
      '<button type="button" class="fs-item dsel-item' + (it.sel ? ' on' : '') + '" data-i="' + i + '" title="' + esc(it.label) + '">' +
      '<span class="dsel-check' + (it.sel ? ' on' : '') + '"></span>' +
      '<span class="fs-path' + (it.value === '' ? ' dim' : '') + '">' + esc(it.label) + '</span>' +
      (it.type && badgeRenderer ? badgeRenderer(it.type) : '') +
      '</button>').join('');
    position();
  }

  function pick(i) {
    if (!pop || !pop.items[i]) return;
    const it = pop.items[i];
    const sel = pop.sel;
    if (sel.value === it.value) { close(); return; }
    sel.value = it.value;
    // 先同步触发器文案再收起（close 后 pop 引用即失效）
    const o = sel.options[sel.selectedIndex];
    const label = o ? o.textContent : '';
    pop.btn.querySelector('.dsel-val').textContent = label;
    pop.btn.classList.toggle('is-empty', !sel.value);
    pop.btn.title = label;
    close();
    // 走既有 change 链路（改条件 / 改每页条数 / 改逻辑关系 / 改参数都会触发重绘或重查）
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function moveActive(delta) {
    if (!pop) return;
    const items = pop.pop.querySelectorAll('.fs-item');
    const n = items.length;
    if (!n) return;
    let idx = -1;
    items.forEach((node, i) => { if (node.classList.contains('kbon')) idx = i; });
    highlight(delta > 0 ? (idx + 1) % n : (idx - 1 + n) % n);
  }

  function key(e) {
    if (!pop) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cur = pop.pop.querySelector('.fs-item.kbon');
      if (cur) pick(Number(cur.dataset.i));
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }

  function highlight(i) {
    if (!pop) return;
    const items = pop.pop.querySelectorAll('.fs-item');
    items.forEach((node, idx) => node.classList.toggle('kbon', idx === i));
    if (items[i]) items[i].scrollIntoView({ block: 'nearest' });
  }

  function open(wrap) {
    const sel = wrap.querySelector('select');
    const btn = wrap.querySelector('.dsel-btn');
    if (!sel || !btn) return;
    if (pop && pop.wrap === wrap) { close(); return; }
    close();
    const el = h('div', 'fs-pop dsel-pop');
    el.addEventListener('mousedown', (e) => {
      e.preventDefault(); // 抢在 blur / 重绘之前，点选稳定生效
      const item = e.target.closest('.fs-item');
      if (item) pick(Number(item.dataset.i));
    });
    document.body.appendChild(el);
    // 类型下拉选项文案长（如「keyword（精确值 / 聚合 / 排序）」），浮层给足最小宽度，避免省略号
    pop = {
      pop: el, wrap: wrap, sel: sel, btn: btn, items: [],
      minW: wrap.dataset.kind === 'type' ? 240 : 132,
    };
    wrap.classList.add('open');
    window.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', key, true);
    render();
    // 默认高亮当前选中项（无选中则第一项）
    const selIdx = pop.items.findIndex((it) => it.sel);
    highlight(selIdx >= 0 ? selIdx : 0);
  }

  // 把容器里的目标 select 升级为自绘下拉（幂等：已包 .dsel 的跳过）
  function upgrade(root) {
    (root || document).querySelectorAll(SELECTOR).forEach((sel) => {
      if (sel.parentElement && sel.parentElement.classList.contains('dsel')) return;
      const wrap = document.createElement('span');
      wrap.className = 'dsel';
      wrap.dataset.kind = kindOf(sel);
      sel.parentNode.insertBefore(wrap, sel);
      wrap.appendChild(sel);
      const btn = h('button', 'dsel-btn');
      btn.type = 'button';
      btn.innerHTML = '<span class="dsel-val"></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        open(wrap);
      });
      wrap.appendChild(btn);
      sync(sel);
    });
  }

  // 程序化修改 select 值后（如表单回填、一键清空），把触发器文案同步过去
  function sync(sel) {
    const wrap = sel.closest ? sel.closest('.dsel') : null;
    if (!wrap) return;
    const btn = wrap.querySelector('.dsel-btn');
    if (!btn) return;
    const o = sel.options[sel.selectedIndex];
    const label = o ? o.textContent : '';
    btn.querySelector('.dsel-val').textContent = label;
    btn.classList.toggle('is-empty', !sel.value);
    btn.title = label;
  }

  window.ESDSEL = { SELECTOR: SELECTOR, upgrade: upgrade, close: close, sync: sync, setBadgeRenderer: setBadgeRenderer };

  // 页面静态 HTML 里的目标 select（如数据源弹窗的 #ds-auth）在加载时统一升级；
  // 动态渲染的容器由各渲染函数自行调用 upgrade。
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => upgrade(document));
  else upgrade(document);
})();
