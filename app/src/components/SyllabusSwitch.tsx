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
 * 2. 选中项用与用户名按钮同色（--c-primary-bg）的浅蓝底，且这块底色是一个
 *    独立的滑块，切换时靠 transform 上下滑过去（不是两个按钮各自改底色，
 *    那样只能瞬间硬切，看不到"移动"）；
 * 3. 按钮文字只留大纲四位数编号，不再跟 "AS/A Level" 这种长备注 ——
 *    长备注会把下拉菜单撑宽，页面上表现为往右凸出一小节。
 *
 * 滑块的位移用 `index * 100%`：每个按钮高度相同（--syl-item-h），
 * 百分比是相对滑块自身高度算的，所以不需要 JS 量高度，窗口缩放也不会错位。
 */
export default function SyllabusSwitch({ value, onChange, disabled = false }: Props) {
  const index = Math.max(0, SYLLABUS_OPTIONS.findIndex((o) => o.value === value));

  return (
    <div className="syl-switch" role="group" aria-label="词库视图">
      <span
        className="syl-switch__thumb"
        style={{ transform: `translateY(${index * 100}%)` }}
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
