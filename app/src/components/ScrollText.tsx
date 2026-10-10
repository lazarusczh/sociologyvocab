/**
 * 长文本「裁剪 + 跑马灯」—— 为表格冻结首列限宽而生（2026-10-09 教师反馈）。
 *
 * 背景：`.check-table` 的首列是 `position: sticky; left: 0` 的冻结列，而单元格是
 *   `white-space: nowrap`。手机窄屏上标题一长，首列被撑到几乎占满视口
 *   ⇒ **右侧的列既点不到、也划不动**（真实 Chrome 实测：390px 容器里首列 367px，
 *   第二列被首列盖住 108px）。
 *
 * 修法分两层，本文件负责第 ②：
 *   ① **限宽**（CSS，见 `index.css` 的 `.scroll-text`）
 *      `width: max-content; max-width: var(--first-col-max)` —— 短标题按内容收缩、
 *      长标题截住；上限宽屏 `22rem`、窄屏 `46vw`。于是列宽 = min(标题宽, 上限)，
 *      首列永远小于视口 ⇒ 右侧始终留出一段可点区域。
 *   ② **溢出才滚动**（本组件）：量到文字宽 > 容器宽时，才打 `.is-scroll` 并把
 *      超出的距离交给 CSS 动画来回平移。不溢出就完全不动 —— 短标题不该无谓地晃。
 *
 * 无障碍：`prefers-reduced-motion: reduce` 时 CSS 会关掉动画（退化为纯裁剪）；
 *   同时始终挂 `title`，桌面端可悬停看全文。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

export default function ScrollText({ text, className = '' }: { text: string; className?: string }) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const runRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);

  const measure = useCallback(() => {
    const box = boxRef.current;
    const run = runRef.current;
    if (!box || !run) return;
    // ⚠ 量「文字自然宽度」要用 scrollWidth —— getBoundingClientRect 会被动画的
    //   transform 影响，量出来的是"当前平移后的位置"，不是宽度。
    const distance = run.scrollWidth - box.clientWidth;
    setShift(distance > 1 ? -distance : 0);
  }, []);

  useEffect(() => {
    measure();
    // 字体晚到会改变文字宽度，等它就绪再量一次
    if (typeof document !== 'undefined' && document.fonts) {
      void document.fonts.ready.then(measure).catch(() => undefined);
    }
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    // 上限是 `46vw` ⇒ **旋屏 / 改窗口大小都会改变溢出与否**，必须重量
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [measure, text]);

  const seconds = Math.max(4, Math.round(Math.abs(shift) / 25)); // 约 25px/秒，长文本不至于一闪而过
  const style = {
    '--shift': `${shift}px`,
    animationDuration: `${seconds}s`,
  } as CSSProperties;

  return (
    <span
      ref={boxRef}
      className={`scroll-text${shift ? ' is-scroll' : ''}${className ? ` ${className}` : ''}`}
      title={text}
    >
      <span ref={runRef} className="scroll-text__run" style={style}>
        {text}
      </span>
    </span>
  );
}
