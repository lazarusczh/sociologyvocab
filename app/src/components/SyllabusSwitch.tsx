import { SYLLABUS_OPTIONS, type SyllabusId } from '../lib/syllabus';

interface Props {
  value: SyllabusId;
  onChange: (s: SyllabusId) => void;
  disabled?: boolean;
}

/**
 * 词库视图切换器（分段控件）。
 *
 * 三件事按用户要求做的：
 * 1. 不用字符 ✓ 标记选中 —— 勾号与页面其它地方的字形语言不一致；
 * 2. 选中项只用一块浅蓝底（--c-primary-bg，与用户名按钮同色）标出来，且这块
 *    底色是独立滑块，切换时靠 transform 上下滑过去（不是两个按钮各自改底色，
 *    那样只能瞬间硬切，看不到"移动"）；容器本身不铺底色，保持下拉菜单的白；
 * 3. 按钮文字只留大纲四位数编号，不再跟 "AS/A Level" 这种长备注 ——
 *    长备注会把下拉菜单撑宽，页面上表现为往右凸出一小节。
 *
 * 滑块位移用 `index * (--syl-item-h + --syl-gap)`：选项高度与行间距都由 CSS
 * 变量给出（和上方"个人中心"等条目同一套尺寸），所以不需要 JS 量高度，
 * 窗口缩放或窄屏换高度都不会错位。
 */
export default function SyllabusSwitch({ value, onChange, disabled = false }: Props) {
  const index = Math.max(0, SYLLABUS_OPTIONS.findIndex((o) => o.value === value));

  return (
    <div className="syl-switch" role="group" aria-label="词库视图">
      <span
        className="syl-switch__thumb"
        style={{ transform: `translateY(calc(${index} * (var(--syl-item-h) + var(--syl-gap))))` }}
        aria-hidden="true"
      />
      {SYLLABUS_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`syl-switch__opt${opt.value === value ? ' is-active' : ''}`}
          onClick={() => onChange(opt.value)}
          disabled={disabled}
          aria-pressed={opt.value === value}
          aria-label={opt.label}
          title={opt.label}
        >
          {opt.value}
        </button>
      ))}
    </div>
  );
}
