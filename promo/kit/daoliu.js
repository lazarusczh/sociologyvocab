/* 宣传页导流组件：页尾二维码位 + 进店链接 + ?mode=poster 长图模式
 * 用法（放在页面动画脚本之前）：
 *   <script src="kit/daoliu.js" data-shop="店名" data-qr="img/qr.png(可选)" data-link="进店链接(可选)"></script>
 * 页尾放 <div class="dl-qr"></div>：有 data-qr 填二维码图，没有显示"二维码待替换"占位。
 * 需要进店按钮时放 <a class="dl-link">文字</a>：有 data-link 跳转，没有点了提示"进店链接待商家替换"。
 * 默认样式写在 head 最前面，页面里同名选择器可以覆盖。
 */
(function () {
  var s = document.currentScript, d = s.dataset;
  var poster = new URLSearchParams(location.search).get('mode') === 'poster';
  if (poster) {
    document.documentElement.classList.add('poster');
    var orig = window.matchMedia.bind(window);
    window.matchMedia = function (q) {
      if (/prefers-reduced-motion/.test(q)) {
        var noop = function () {};
        return { matches: /:\s*reduce/.test(q), media: q, onchange: null, addListener: noop, removeListener: noop, addEventListener: noop, removeEventListener: noop };
      }
      return orig(q);
    };
  }
  var css = [
    '.dl-qr{width:132px;height:132px;box-sizing:border-box;padding:6px;background:#fff;flex:0 0 auto}',
    '.dl-qr img{display:block;width:100%;height:100%;object-fit:contain}',
    '.dl-qr .dl-qr0{display:grid;place-items:center;width:100%;height:100%;box-sizing:border-box;border:1px dashed #999;color:#666;font-size:13px;line-height:1.5;text-align:center}',
    '.dl-link{cursor:pointer}',
    '.dl-toast{position:fixed;left:50%;bottom:32px;z-index:91;transform:translate(-50%,12px);opacity:0;background:rgba(20,20,20,.88);color:#fff;font-size:14px;padding:10px 16px;border-radius:8px;transition:opacity .2s,transform .2s;pointer-events:none;white-space:nowrap}',
    '.dl-toast.on{opacity:1;transform:translate(-50%,0)}',
    'html.poster .dl-link,html.poster .dl-toast{display:none}'
  ].join('\n');
  function freezeViewportUnits() {
    var vh = window.innerHeight / 100, vw = window.innerWidth / 100;
    document.querySelectorAll('style').forEach(function (el) {
      el.textContent = el.textContent.replace(/(-?\d*\.?\d+)(s|d|l)?v(h|w)\b/g, function (m, n, k, axis) {
        return (parseFloat(n) * (axis === 'h' ? vh : vw)).toFixed(2) + 'px';
      });
    });
  }
  function build() {
    if (poster) freezeViewportUnits();
    var st = document.createElement('style'); st.textContent = css; document.head.insertBefore(st, document.head.firstChild);
    var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    document.querySelectorAll('.dl-qr').forEach(function (el) {
      el.innerHTML = d.qr ? '<img src="' + esc(d.qr) + '" alt="' + esc(d.shop || '店铺') + '二维码">' : '<span class="dl-qr0">二维码<br>待替换</span>';
    });
    var ok = d.link && /^(https?:|weixin:)/i.test(d.link);
    var toast = document.createElement('div'); toast.className = 'dl-toast'; toast.textContent = '进店链接待商家替换' + (d.shop ? '：「' + d.shop + '」' : '');
    document.body.appendChild(toast);
    var t;
    document.querySelectorAll('.dl-link').forEach(function (a) {
      if (ok) { a.setAttribute('href', d.link); return; }
      a.removeAttribute('href'); a.setAttribute('role', 'button');
      a.addEventListener('click', function (e) { e.preventDefault(); toast.classList.add('on'); clearTimeout(t); t = setTimeout(function () { toast.classList.remove('on'); }, 1600); });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
