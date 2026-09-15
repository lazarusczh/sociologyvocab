// 复制文本到剪贴板：多级回退，适配 IDE 内置预览 / WebView / 非安全上下文
//   ① Clipboard API（需安全上下文 + 权限；IDE webview 常被拒）
//   ② execCommand('copy')（旧路径，部分 webview 仍可用）
//   ③ 都失败 → 返回 'failed'，由调用方展示"可手动 Ctrl+C"的文本框
//
// ⚠️ 2026-09-15 踩坑记录：navigator.clipboard 存在 ≠ 可用。
// 旧实现是 `await navigator.clipboard.writeText(text); return;` —— writeText 因权限被拒抛错后
// 函数直接中断，后面的 execCommand 回退**永远走不到**，表现为
// "复制失败：Failed to execute 'writeText' on 'Clipboard': Write permission denied."
// 因此必须 try/catch 后再回退。

export type CopyMethod = 'clipboard' | 'exec' | 'failed';

export async function copyText(text: string): Promise<CopyMethod> {
  // ① Clipboard API
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return 'clipboard';
    } catch {
      /* 权限被拒 / 非用户手势 / 宿主 webview 限制 → 继续回退 */
    }
  }
  // ② execCommand('copy')
  try {
    if (legacyCopy(text)) return 'exec';
  } catch {
    /* 继续回退 */
  }
  return 'failed';
}

/** 旧式复制：临时 textarea + 选中 + execCommand。返回是否成功。 */
function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');   // 避免移动端弹键盘
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);

  const sel = document.getSelection();
  const saved = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;

  ta.select();
  ta.setSelectionRange(0, ta.value.length); // iOS 需显式设范围才认

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }

  ta.remove();
  // 还原用户原来的选区，避免打断阅读
  if (saved && sel) {
    sel.removeAllRanges();
    sel.addRange(saved);
  }
  return ok;
}
