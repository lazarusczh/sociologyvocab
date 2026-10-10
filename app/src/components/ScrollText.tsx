/**
 * 长文本「裁剪 + 单方向跑马灯 + 可手动拖动」—— 为表格冻结首列限宽而生
 * （2026-10-09 教师反馈限宽与跑马灯；2026-10-10 追加手动拖动）。
 *
 * 背景：`.check-table` 的首列是 `position: sticky; left: 0` 的冻结列，而单元格是
 *   `white-space: nowrap`。手机窄屏上标题一长，首列被撑到几乎占满视口
 *   ⇒ **右侧的列既点不到、也划不动**（真实 Chrome 实测：390px 容器里首列 367px，
 *   第二列被首列盖住 108px）。
 *
 * 三件事各归其位：
 *   ① **限宽**（CSS `.scroll-text`）：`width: max-content; max-width: var(--first-col-max)`
 *      —— 短标题按内容收缩、长标题截住；上限宽屏 `22rem`、窄屏 `46vw`。
 *   ② **自动滚动**（CSS `@keyframes`）：只在真的溢出时才动，单方向、两端各留 12% 停顿。
 *   ③ **手动拖动**（本文件）：按住标题横拖可以直接把滚动进度拨到任意位置
 *      —— 教师 2026-10-10：标题很长时自动滚动太慢，"想直接拖到结尾看关键信息"。
 *
 * ⚠ 手动拖动的实现要点：**不去另做一套位移，而是直接 seek 那个 CSS 动画**
 *   （`animation.currentTime`）。理由：
 *     · 位置只有一个来源 ⇒ 松手后动画**从你拖到的位置接着走**，不会跳回起点；
 *     · 不用写 inline transform —— 运行中的 CSS 动画优先级高于 inline style，
 *       用 inline 覆盖得先 `animation: none` 拆掉动画，再恢复时又要重建实例，
 *       中间那一帧容易闪。
 *   `Animation.pause()` / `play()` / `currentTime` 都是标准 Web Animations API，
 *   Chrome / Safari / Firefox 全支持；拿不到动画实例时（极老浏览器）拖动直接不生效，
 *   自动滚动不受影响 —— 退化成"只能看自动的"。
 *
 * 无障碍：`prefers-reduced-motion: reduce` 时 CSS 把动画改成 **`animation-play-state: paused`**
 *   （**不是 `animation: none`**）—— 这样自动滚动不跑，但**动画实例依然存在**
 *   ⇒ **手动拖动照样可用**，位置完全交给你。⚠ 所以松手时也**不要**调 `play()`
 *   （那会绕开"减少动态效果"的偏好）。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';

/** ⚠ 必须与 `index.css` 里 `@keyframes scroll-text-marquee` 的两个断点一致：
 *  0%~12% 停在开头、12%~88% 单向走完、88%~100% 停在末尾。
 *  改 CSS 记得同步改这里，否则拖动松手时位置会偏。 */
const LEAD = 0.12;
const TAIL = 0.88;

/** 是否启用了「减少动态效果」*/
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function ScrollText({ text, className = '' }: { text: string; className?: string }) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const runRef = useRef<HTMLSpanElement>(null);
  /** 负值 = 需要向左滚动的距离；0 = 放得下、不需要跑马灯 */
  const [shift, setShift] = useState(0);
  const [dragging, setDragging] = useState(false);
  /** 拖动起点：手指 x 与当时的位移 */
  const grab = useRef<{ x: number; offset: number } | null>(null);

  /** 当前那个 CSS 动画实例（没有动画就没有拖动） */
  const anim = (): Animation | undefined => (runRef.current?.getAnimations() ?? [])[0];

  /** 动画时长（毫秒）—— 组件按距离算好写在 inline style 上，这里读回来 */
  const durMs = (): number => {
    const run = runRef.current;
    if (!run) return 0;
    return parseFloat(getComputedStyle(run).animationDuration || '0') * 1000;
  };

  /** 进度（0~1）→ 位移（px） */
  const offsetAt = (p: number): number => {
    if (p <= LEAD) return 0;
    if (p >= TAIL) return shift;
    return shift * ((p - LEAD) / (TAIL - LEAD));
  };

  /** 位移（px）→ 进度（0~1） */
  const progressAt = (x: number): number => (shift ? LEAD + (TAIL - LEAD) * (x / shift) : 0);

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

  const onPointerDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (!shift) return; // 放得下就别抢手势
    const a = anim();
    const dur = durMs();
    const p = a && dur ? Number(a.currentTime ?? 0) / dur : 0;
    grab.current = { x: e.clientX, offset: offsetAt(p) };
    setDragging(true);
    a?.pause(); // 按住期间暂停自动滚动；松手再续
    // 桌面端横拖会顺手选中文字，挡掉（`touch-action: pan-y` 已挡住触摸端的横滑）
    e.preventDefault();
    // 指针捕获是"尽力而为"：合成事件、或指针已被释放时会抛 —— 失败就退化成
    // "手指移出标题就不再跟随"，拖动本身仍然可用，不影响其它功能。
    try {
      boxRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const g = grab.current;
    if (!g) return;
    const next = Math.max(shift, Math.min(0, g.offset + (e.clientX - g.x)));
    const a = anim();
    const dur = durMs();
    if (a && dur) {
      a.currentTime = Math.min(1, Math.max(0, progressAt(next))) * dur;
    }
  };

  const endDrag = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (!grab.current) return;
    grab.current = null;
    setDragging(false);
    try {
      boxRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略：没捕获成功时释放也会抛 */
    }
    const a = anim();
    // ⚠ 「减少动态效果」时**不要** play() —— CSS 那句是 `animation-play-state: paused`，
    //   手动拖到的位置停在那儿才是正确行为。
    if (a && !prefersReducedMotion()) a.play();
  };

  const seconds = Math.max(4, Math.round(Math.abs(shift) / 25)); // 约 25px/秒，长文本不至于一闪而过
  const style = {
    '--shift': `${shift}px`,
    animationDuration: `${seconds}s`,
  } as CSSProperties;

  const cls = ['scroll-text'];
  if (shift) cls.push('is-scroll');
  if (dragging) cls.push('is-dragging');
  if (className) cls.push(className);

  return (
    <span
      ref={boxRef}
      className={cls.join(' ')}
      title={text}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <span ref={runRef} className="scroll-text__run" style={style}>
        {text}
      </span>
    </span>
  );
}
