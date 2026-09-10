// 组卷导出 Word（对照 teacher 的 Mock Exam draft 版式复刻）
// 版式规格（来自 Materials/25-26 A1/A2 Mock Exam Paper 1-4 - Draft.docx）：
//   A4；边距 上/下 1″、左/右 1.25″；正文 Calibri 12pt；
//   Section 大标题 / 作答说明 居中 14pt；题目逐段，分值以 [n] 右对齐置于行末；
//   小问 (a)/(b) 用悬挂缩进（换行与小问题干文字对齐）；二选一槽以 EITHER / OR 分隔。
import {
  AlignmentType, Document, Packer, Paragraph, Tab, TabStopType, TextRun,
} from 'docx';
import type { AssembleSlot, BankItem } from './grouper';

export interface ExportOpts {
  title: string;              // 下载文件名与文档内部题头（无则省略题头）
  mode: 'template' | 'single' | 'free';
  paper: number;
  templateLabel: string | null; // mode=template 时模板名（决定 Section 结构用 template 槽序）
  topic: string | null;
  slots: AssembleSlot[];      // single 模式传构造好的单槽
  extraNote?: string | null;  // 顶部附加说明（如 P4 全局指令），可为空
}

const CALIBRI = 'Calibri';
const BODY = 24;   // 12pt（半磅）
const HEAD = 28;   // 14pt

// —— 版式缩进/制表位（twips）——
const NUM_POS = 420;                       // 题目正文起始位（题号固定在 0）
const SUB_LABEL = 420;                     // 小问 (a)/(b) 标签起始位
const SUB_TEXT = 840;                      // 小问正文起始位（换行对齐到这里）
const RIGHT_POS = 11906 - 1800 - 1800;     // 正文区右边界（分值右对齐）
const Q_GAP = 240;                         // 题目之间：段后留白（隔行感）
const SEC_GAP = 720;                       // Section 之间：段前留白

// 转义题库文本中的内引号：外层统一用弯引号（题库偶有 ASCII 直引号残留）
const tidy = (t: string) => t.replace(/'/g, '’').replace(/(^|[^(])\x27/g, '$1’');

// 观点句加弯引号（statement 无外层引号，stem 可能带，去重）
const quoted = (it: BankItem) => {
  const s = (it.statement?.trim() || it.stem.replace(/^[‘’'"]+|[’'"”]+$/g, '').trim());
  return `‘${tidy(s)}’`;
};

// 题干最终文本：能直接用 stem 就直接用；缺作答指令的观点题补官方套语
function questionText(it: BankItem): string {
  const stem = (it.stem ?? '').trim();
  if (/Describe|Explain|Evaluate|Using|Outline|Assess|Identify/i.test(stem)) return stem;
  if (it.kind === 'statement') {
    if (it.marks === '12') return `${quoted(it)} Using sociological material, give two arguments against this view.`;
    if (it.marks === '35') return `${quoted(it)} Evaluate this view.`;
    return quoted(it);
  }
  return stem;
}

// 一道“大题”的若干答题行
//  - plain：单问，一行
//  - ab：q2a/q2b 合并为同一题 2 (a)/(b)
//  - sp：观点题（statement-pair），陈述独占一行，其后为 (a)/(b) 作答指令
interface Line {
  sub?: string;      // 'a' | 'b'
  text: string;
  marks: number;
}
interface Unit {
  kind: 'plain' | 'ab' | 'sp';
  lines: Line[];
}

function slotToUnits(slots: AssembleSlot[], mergeAb = false): Unit[] {
  const units: Unit[] = [];
  const push = (s: AssembleSlot) => {
    for (const it of s.items) {
      if (it.kind === 'statement-pair' && it.parts) {
        const a = it.parts.find((p) => p.part === 'a');
        const b = it.parts.find((p) => p.part === 'b');
        // 陈述单独成行（不加分值），随后两条作答指令按 (a)/(b) 缩进排列
        units.push({
          kind: 'sp',
          lines: [
            { text: quoted(it), marks: 0 },
            { sub: 'a', text: 'Explain this view.', marks: a?.marks ?? 10 },
            { sub: 'b', text: 'Using sociological material, give one argument against this view.', marks: b?.marks ?? 6 },
          ],
        });
      } else {
        units.push({ kind: 'plain', lines: [{ text: questionText(it), marks: it.marksTotal }] });
      }
    }
  };
  if (!mergeAb) { slots.forEach(push); return units; }
  // q2a / q2b 两槽视为同一道题 2 (a)/(b)
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const next = slots[i + 1];
    const m = /^(.*)a$/.exec(s.spec.key ?? '');
    if (m && next && next.spec.key === `${m[1]}b` && s.items[0] && next.items[0]) {
      units.push({
        kind: 'ab',
        lines: [
          { sub: 'a', text: questionText(s.items[0]), marks: s.items[0].marksTotal },
          { sub: 'b', text: questionText(next.items[0]), marks: next.items[0].marksTotal },
        ],
      });
      i++;
    } else {
      push(s);
    }
  }
  return units;
}

// 正文行内元素：文本 或 制表位
type Run = { text: string; bold?: boolean } | { tab: true };

interface Block {
  runs: Run[];
  center?: boolean;
  size?: number;
  before?: number;                                     // 段前间距（twips）
  after?: number;                                      // 段后间距（twips）
  indent?: { left?: number; hanging?: number };
  tabStops?: { type: 'left' | 'right'; pos: number }[];
}

// 题干中的数量词（数字 one..ten + all）导出时加粗
const QTY_RE = /\b(all|one|two|three|four|five|six|seven|eight|nine|ten)\b/gi;

/** 纯文本 → runs，其中数量词加粗 */
function textRuns(text: string): Run[] {
  const runs: Run[] = [];
  let last = 0;
  QTY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QTY_RE.exec(text)) !== null) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    runs.push({ text: m[0], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length ? runs : [{ text }];
}

// 分值：先制表跳到行末右对齐位，再输出 [n]
const marksRuns = (m: number): Run[] => [{ tab: true }, { text: `[${m}]` }];

// 题号计数器（Section B 的选项续 Section A 的序号）
interface Counter { n: number }

// 题号 + 正文：题号在最左，正文从 NUM_POS 起；换行与正文对齐，分值贴右
function mainLine(n: number, text: string, marks: number): Block {
  const runs: Run[] = [{ text: `${n}`, bold: true }, { tab: true }, ...textRuns(text)];
  if (marks > 0) runs.push(...marksRuns(marks));
  return {
    runs,
    indent: { left: NUM_POS, hanging: NUM_POS },
    tabStops: [{ type: 'left', pos: NUM_POS }, { type: 'right', pos: RIGHT_POS }],
    after: Q_GAP,
  };
}

// 题号 + 小问标签同处首行：号在最左、(a) 在小问位、正文从小问文字位起（换行与之对齐）
function abFirstLine(n: number, label: string, text: string, marks: number): Block {
  const runs: Run[] = [
    { text: `${n}`, bold: true }, { tab: true },
    { text: `(${label}) `, bold: true }, { tab: true },
    ...textRuns(text),
  ];
  if (marks > 0) runs.push(...marksRuns(marks));
  return {
    runs,
    indent: { left: SUB_TEXT, hanging: SUB_TEXT },
    tabStops: [
      { type: 'left', pos: NUM_POS },
      { type: 'left', pos: SUB_TEXT },
      { type: 'right', pos: RIGHT_POS },
    ],
    after: Q_GAP,
  };
}

// 小问行：(a)/(b) 标签在小问位，正文从小问文字位起；换行与正文对齐
function subLine(label: string, text: string, marks: number): Block {
  const runs: Run[] = [{ text: `(${label}) `, bold: true }, { tab: true }, ...textRuns(text)];
  if (marks > 0) runs.push(...marksRuns(marks));
  return {
    runs,
    indent: { left: SUB_TEXT, hanging: SUB_TEXT - SUB_LABEL },
    tabStops: [{ type: 'left', pos: SUB_TEXT }, { type: 'right', pos: RIGHT_POS }],
    after: Q_GAP,
  };
}

// 居中作答说明（Section 大标题下方）；与首题之间拉开距离（after 可覆盖）
const instruction = (text: string, after = 480): Block =>
  ({ runs: textRuns(text), center: true, size: HEAD, after });

// 普通槽（Section A / P3 / 凑分）：题号连续编号
function numberedBlocks(units: Unit[], c: Counter): Block[] {
  const blocks: Block[] = [];
  for (const u of units) {
    const n = c.n++;
    if (u.kind === 'plain') {
      blocks.push(mainLine(n, u.lines[0].text, u.lines[0].marks));
    } else if (u.kind === 'ab') {
      blocks.push(abFirstLine(n, u.lines[0].sub ?? 'a', u.lines[0].text, u.lines[0].marks));
      for (const l of u.lines.slice(1)) blocks.push(subLine(l.sub ?? 'b', l.text, l.marks));
    } else {
      // sp：陈述行带题号、不带分值；随后 (a)/(b) 作答指令
      blocks.push(mainLine(n, u.lines[0].text, 0));
      for (const l of u.lines.slice(1)) blocks.push(subLine(l.sub ?? 'a', l.text, l.marks));
    }
  }
  return blocks;
}

// 二选一槽：EITHER / OR 各占一行（加粗），题目续编号（接 Section A 序号）
function eitherBlocks(slot: AssembleSlot, c: Counter): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < slot.items.length; i++) {
    const it = slot.items[i];
    const word = i === 0 ? 'EITHER' : 'OR';
    blocks.push({ runs: [{ text: word, bold: true }], before: 240 });
    blocks.push(mainLine(c.n++, questionText(it), it.marksTotal));
  }
  return blocks;
}

// 版本差异：P1/P2 两套；正文排版统一；返回段落数组
export function buildBlocks(o: ExportOpts): Block[] {
  const blocks: Block[] = [];
  const isTemplate = o.mode === 'template' && o.slots.length > 0;
  const c: Counter = { n: 1 };

  const addSectionHeader = (text: string, before = blocks.length ? SEC_GAP : 0) => {
    blocks.push({ runs: [{ text, bold: true }], center: true, size: HEAD, before });
  };

  if (isTemplate && o.paper === 4) {
    // P4：Section A（Globalisation）/ Section B（Media）各一个二选一 35 分槽
    // 顶部提示与 Section A 之间按常规行距（不拉大）；Section 之间仍拉开
    if (o.extraNote) blocks.push(instruction(o.extraNote, Q_GAP));
    o.slots.forEach((slot, i) => {
      const theme = slot.spec.unit === 'media' ? 'Media' : slot.spec.unit === 'globalisation' ? 'Globalisation' : null;
      const header = `Section ${String.fromCharCode(65 + i)}${theme ? `: ${theme}` : ''}`;
      addSectionHeader(header, i === 0 ? 0 : SEC_GAP);
      blocks.push(...eitherBlocks(slot, c));
    });
    return blocks;
  }

  const plainSlots = o.slots.filter((s) => !s.spec.eitherOr);
  const eitherSlots = o.slots.filter((s) => s.spec.eitherOr);
  const hasEither = eitherSlots.length > 0;

  if (isTemplate && (o.paper === 1 || o.paper === 2)) {
    // Section A：全部作答的小分题（q1..q3）
    addSectionHeader('Section A');
    blocks.push(instruction('Answer all questions in this section.'));
    blocks.push(...numberedBlocks(slotToUnits(plainSlots, true), c));
    if (hasEither) {
      addSectionHeader('Section B');
      blocks.push(instruction('Answer one question in this section.'));
      for (const s of eitherSlots) blocks.push(...eitherBlocks(s, c));
    }
    return blocks;
  }

  if (isTemplate && o.paper === 3) {
    // P3：全卷作答，无 Section 分节（对照 draft）
    blocks.push(instruction('Answer all questions.'));
    blocks.push(...numberedBlocks(slotToUnits(plainSlots, true), c));
    return blocks;
  }

  // 自由 / 目标凑分 / 单题：不加 Section，从 1 连续编号
  blocks.push(...numberedBlocks(slotToUnits(o.slots, false), c));
  return blocks;
}

const sanitizeName = (t: string) => t.replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 80);

export async function exportPaperToDocx(o: ExportOpts): Promise<void> {
  const blocks = buildBlocks(o);
  const paras = blocks.map((b) => new Paragraph({
    alignment: b.center ? AlignmentType.CENTER : AlignmentType.LEFT,
    spacing: { before: b.before ?? 0, after: b.after ?? 60, line: 276 },
    indent: b.indent,
    tabStops: b.tabStops?.map((t) => ({
      type: t.type === 'left' ? TabStopType.LEFT : TabStopType.RIGHT,
      position: t.pos,
    })),
    children: b.runs.map((r) => ('tab' in r
      ? new TextRun({ children: [new Tab()] })
      : new TextRun({ text: r.text, bold: r.bold, font: CALIBRI, size: b.size ?? BODY }))),
  }));

  const doc = new Document({
    styles: {
      default: { document: { run: { font: CALIBRI, size: BODY } } },
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 }, // A4
          margin: { top: 1440, bottom: 1440, left: 1800, right: 1800 },
        },
      },
      children: paras,
    }],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeName(o.title)}.docx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
