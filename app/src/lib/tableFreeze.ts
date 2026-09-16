// 横向滚动表格「首列冻结」的投影开关（样式见 index.css 的 .check-table:first-child::after）
//
// 需求（教师 2026-09-15）：冻结列的投影**只在真正横向滚动时出现** —— 静止时它就是普通一列，
// 只有当你往右滑、下面的列钻到它底下时，才浮起一层柔和投影。
//
// 实现要点：**scroll 事件不冒泡**，所以如果逐张表去挂监听，得改 9 处表格组件（代价太大）。
// 这里改为在 document 上挂**一次捕获阶段**监听（`capture = true`），
// 命中"某个可横滚容器滚动"后，给其中的 `.check-table` 打上/摘掉 `is-scrolled` 类，
// CSS 依据该类把投影的 opacity 在 0/1 之间切换。
//
// 判据用 scrollLeft > 0（滑回最左即摘掉类 ⇒ 投影消失）；失败也只是没有投影，不影响功能。

/** 给某个容器判定并同步它内部表格的 is-scrolled 类 */
function sync(container: HTMLElement): void {
  const table = container.querySelector(':scope > .check-table') as HTMLElement | null;
  if (!table) return;
  table.classList.toggle('is-scrolled', container.scrollLeft > 0);
}

/** 全量同步一次（用于挂载时把已处于滚动状态（如浏览器恢复滚动位置）的表格补齐） */
export function syncAllTables(): void {
  document.querySelectorAll<HTMLElement>('.check-table').forEach((table) => {
    const box = table.parentElement;
    if (box) table.classList.toggle('is-scrolled', box.scrollLeft > 0);
  });
}

/**
 * 安装全局监听（在 App 挂载时调用一次）。返回卸载函数，供 useEffect 清理。
 */
export function installTableFreeze(): () => void {
  const onScroll = (e: Event) => {
    const t = e.target;
    // 只处理元素级滚动：document / window 的滚动没有 scrollLeft 语义
    if (!(t instanceof HTMLElement)) return;
    sync(t);
  };
  document.addEventListener('scroll', onScroll, true);
  // 窗口尺寸变化会让"能否横向滚动/当前是否已滚动"改变，重新同步一遍
  const onResize = () => syncAllTables();
  window.addEventListener('resize', onResize);
  syncAllTables();
  return () => {
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
  };
}
