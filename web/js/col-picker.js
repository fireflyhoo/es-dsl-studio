/* ============================================================
 * ESCols · 表格展示列选择器（查询结果 + 索引管理样本数据共用）
 * 偏好按「索引名」保存在 localStorage（esdsl.cols.v1），
 * 未设置时默认展示前 14 列。
 * ============================================================ */
(function () {
  'use strict';

  const KEY = 'esdsl.cols.v1';
  const DEFAULT_N = 14;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function loadAll() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY));
      return (v && typeof v === 'object') ? v : {};
    } catch (e) { return {}; }
  }

  function pref(index) {
    if (!index) return null;
    const all = loadAll();
    return Array.isArray(all[index]) ? all[index] : null;
  }

  function setPref(index, cols) {
    if (!index) return;
    const all = loadAll();
    if (!cols || !cols.length) delete all[index];
    else all[index] = cols.slice();
    try { localStorage.setItem(KEY, JSON.stringify(all)); } catch (e) { /* 忽略配额 */ }
  }

  // 计算展示列：有偏好用偏好（剔除已消失的列），否则取前 DEFAULT_N 列
  function visible(allCols, index) {
    allCols = allCols || [];
    const saved = pref(index);
    if (saved && saved.length) {
      const set = {};
      saved.forEach((c) => { set[c] = 1; });
      const cols = allCols.filter((c) => set[c]);
      if (cols.length) return { cols: cols, saved: true };
    }
    return { cols: allCols.slice(0, DEFAULT_N), saved: false };
  }

  /* ---------------- 弹出式选择浮层 ---------------- */
  let pop = null;
  let popBtn = null;

  function closePicker() {
    if (pop) { pop.remove(); pop = null; popBtn = null; }
    document.removeEventListener('mousedown', onDocDown, true);
    window.removeEventListener('resize', closePicker);
    window.removeEventListener('scroll', closePicker, true);
  }

  function onDocDown(e) {
    if (pop && !pop.contains(e.target) && e.target !== popBtn) closePicker();
  }

  function position() {
    if (!pop || !popBtn) return;
    const r = popBtn.getBoundingClientRect();
    const w = Math.min(300, Math.max(240, r.width + 60));
    pop.style.width = w + 'px';
    let left = r.right - w;
    if (left < 8) left = Math.max(8, r.left);
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w);
    pop.style.left = left + 'px';
    // 下方放不下就翻到按钮上方
    const h = pop.offsetHeight;
    let top = r.bottom + 5;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 5);
    pop.style.top = top + 'px';
  }

  /**
   * 绑定触发按钮。
   * opts: {
   *   getAll(): string[]      全部可用列（打开时求值）
   *   getSel(): string[]      当前选中列（打开时求值）
   *   onApply(cols): void     勾选变化时回调（实时生效）
   * }
   */
  function attach(btn, opts) {
    btn.classList.add('cp-btn');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pop && popBtn === btn) { closePicker(); return; }
      closePicker();
      pop = build(opts);
      popBtn = btn;
      document.body.appendChild(pop);
      position();
      document.addEventListener('mousedown', onDocDown, true);
      window.addEventListener('resize', closePicker);
      window.addEventListener('scroll', closePicker, true);
      const s = pop.querySelector('.cp-search input');
      if (s) s.focus();
    });
  }

  function build(opts) {
    const all = opts.getAll() || [];
    const sel = opts.getSel() || [];
    const selSet = {};
    sel.forEach((c) => { selSet[c] = 1; });

    const box = document.createElement('div');
    box.className = 'cp-pop';
    box.innerHTML =
      '<div class="cp-search">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>' +
      '<input type="text" placeholder="搜索字段…">' +
      '</div>' +
      '<div class="cp-list"></div>' +
      '<div class="cp-foot">' +
      '<span class="cp-count"></span><span style="flex:1"></span>' +
      '<button type="button" class="cp-act" data-act="all">全选</button>' +
      '<button type="button" class="cp-act" data-act="reset">恢复默认前 ' + DEFAULT_N + '</button>' +
      '</div>';

    const list = box.querySelector('.cp-list');
    const count = box.querySelector('.cp-count');
    const search = box.querySelector('.cp-search input');

    function apply(next) {
      opts.onApply(next.slice());
      syncCount(next.length);
    }

    function currentSel() {
      return [].slice.call(list.querySelectorAll('.cp-item input:checked')).map((i) => i.value);
    }

    function syncCount(n) {
      count.textContent = '已选 ' + n + ' / ' + all.length;
    }

    function renderList(kw) {
      kw = (kw || '').trim().toLowerCase();
      list.innerHTML = '';
      all.forEach((c) => {
        if (kw && c.toLowerCase().indexOf(kw) < 0) return;
        const lab = document.createElement('label');
        lab.className = 'cp-item';
        lab.innerHTML = '<input type="checkbox" value="' + esc(c) + '"' + (selSet[c] ? ' checked' : '') + '>' +
          '<span class="cp-name">' + esc(c) + '</span>';
        lab.querySelector('input').addEventListener('change', () => apply(currentSel()));
        list.appendChild(lab);
      });
      if (!list.children.length) list.innerHTML = '<div class="cp-none">没有匹配的字段</div>';
      syncCount(currentSel().length);
      position();
    }

    search.addEventListener('input', () => renderList(search.value));
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePicker();
      if (e.key === 'ArrowDown') {
        const first = list.querySelector('.cp-item input');
        if (first) { e.preventDefault(); first.focus(); }
      }
    });

    box.querySelector('.cp-foot').addEventListener('click', (e) => {
      const act = e.target && e.target.dataset ? e.target.dataset.act : '';
      if (act === 'all') {
        [].slice.call(list.querySelectorAll('.cp-item input')).forEach((i) => { i.checked = true; });
        apply(currentSel());
      } else if (act === 'reset') {
        // 恢复默认 = 清除偏好，回到「前 14 列」的动态默认
        if (opts.onReset) opts.onReset();
        else apply(all.slice(0, DEFAULT_N));
        closePicker();
      }
    });

    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      closePicker();
    });

    renderList('');
    return box;
  }

  // 更新触发按钮上的计数徽标：btn 文本 = 基础文案 + 已选/总数
  function badge(btn, base, selN, allN) {
    if (!btn) return;
    btn.innerHTML = esc(base) + (allN > 0 ? ' <b>' + selN + '/' + allN + '</b>' : '');
  }

  window.ESCols = {
    DEFAULT_N: DEFAULT_N,
    pref: pref,
    setPref: setPref,
    visible: visible,
    attach: attach,
    badge: badge,
    close: closePicker
  };
})();
