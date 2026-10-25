/* ============================================================
 * 通用弹窗拖动（window 级别，自动绑定所有弹窗）
 * 拖动 .m-h（标题栏）移动弹窗；关闭后重新打开自动回到居中。
 * 覆盖：#modal-mask（导入 DSL）+ 7 个 .mask（数据源 / 新建索引 /
 * DSL / 别名 / 记录 / 确认 / 令牌）。
 * 实现要点：
 *  - pointer events + setPointerCapture：鼠标移出窗口也不丢拖动
 *  - 拖动瞬间把弹窗从 flex 居中切换为 fixed + left/top（pop 动画清掉）
 *  - 边界钳制：至少留 80px 在视口内，保证拖回来；顶部不越界
 *  - 4px 阈值区分点击与拖动；拖动结束吞掉紧随的 click
 *    （从标题拖到遮罩上松手，click 的共同祖先是 mask，会误触发关闭）
 *  - MutationObserver 监听 mask 的 class：关闭即清 inline 位置
 * ============================================================ */
(function () {
  'use strict';

  var THRESHOLD = 4;      // px：超过才算拖动
  var MIN_VISIBLE = 80;   // px：弹窗至少保留在视口内的宽度（抓得回来）
  var MIN_TOP = 48;       // px：底部至少留一点，标题栏永远可抓

  function bind(mask) {
    var modal = mask.firstElementChild;
    if (!modal) return;
    var head = modal.querySelector('.m-h');
    if (!head) return;

    var drag = null;

    function applyMove(clientX, clientY) {
      if (!drag) return;
      var dx = clientX - drag.sx;
      var dy = clientY - drag.sy;
      if (!drag.moved && Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return;
      drag.moved = true;
      var w = modal.offsetWidth;
      var left = Math.min(Math.max(drag.ox + dx, MIN_VISIBLE - w), window.innerWidth - MIN_VISIBLE);
      var top = Math.min(Math.max(drag.oy + dy, 0), window.innerHeight - MIN_TOP);
      modal.style.left = left + 'px';
      modal.style.top = top + 'px';
    }

    head.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      // 头部里的交互元素（关闭按钮等）不启动拖动
      if (e.target.closest('button, a, input, select, textarea, [contenteditable]')) return;
      e.preventDefault(); // 阻止文本选中 / 焦点抢占
      var r = modal.getBoundingClientRect();
      // flex 居中 → fixed 定位（pop 动画的 transform 一并清掉）
      modal.style.animation = 'none';
      modal.style.position = 'fixed';
      modal.style.margin = '0';
      modal.style.transform = 'none';
      modal.style.left = r.left + 'px';
      modal.style.top = r.top + 'px';
      drag = { pid: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
      try { head.setPointerCapture(e.pointerId); } catch (err) { /* 老 webview 退化为 window 监听 */ }
      document.body.classList.add('modal-dragging');
    });

    // capture 成功时事件目标仍是 head（冒泡到 window 会重复触发，applyMove 幂等无害）；
    // capture 失败时靠 window 兜底，鼠标移出窗口也不丢拖动。
    head.addEventListener('pointermove', function (e) {
      if (drag && e.pointerId === drag.pid) applyMove(e.clientX, e.clientY);
    });
    window.addEventListener('pointermove', function (e) {
      if (drag) applyMove(e.clientX, e.clientY);
    });

    function endDrag(e) {
      if (!drag) return;
      if (e && e.pointerId !== undefined && e.pointerId !== drag.pid) return;
      var moved = drag.moved;
      drag = null;
      document.body.classList.remove('modal-dragging');
      if (moved) {
        // 吞掉拖动结束后紧跟的那一次 click（防止误触「点遮罩关闭」）
        var swallow = function (ev) { ev.stopPropagation(); ev.preventDefault(); };
        mask.addEventListener('click', swallow, true);
        setTimeout(function () { mask.removeEventListener('click', swallow, true); }, 0);
      }
    }
    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);
    window.addEventListener('pointerup', function (e) {
      if (drag && (e.pointerId === undefined || e.pointerId === drag.pid)) endDrag(e);
    });

    // 关闭（.show 移除）后清掉 inline 位置，下次打开回到居中
    new MutationObserver(function () {
      if (!mask.classList.contains('show')) {
        modal.style.position = '';
        modal.style.left = '';
        modal.style.top = '';
        modal.style.margin = '';
        modal.style.transform = '';
        modal.style.animation = '';
      }
    }).observe(mask, { attributes: true, attributeFilter: ['class'] });
  }

  function init() {
    document.querySelectorAll('#modal-mask, .mask').forEach(bind);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
