// 组卷导出 Word（对照 teacher 的 Mock Exam draft 版式复刻）
// 版式规格（来自 Materials/25-26 A1/A2 Mock Exam Paper 1-4 - Draft.docx）：
//   A4；边距 上/下 1″、左/右 1.25″；正文 Calibri 12pt；
//   Section 大标题 / 作答说明 居中 14pt；题目逐段，分值以 [n] 置于句末；
//   二选一槽以 EITHER / OR 分隔；statement 观点用弯引号；不含题源/ms 标注。
import {
  AlignmentType, Document, Packer, Paragraph, TextRun,
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

// 一道“大题”的若干答题行（pair 与 q2a/q2b 会拆成 (a)(b) 两行）
interface Line {
  sub?: string;      // 'a' | 'b'
  text: string;
  marks: number;
}
interface Unit { lines: Line[] }

function slotToUnits(slots: AssembleSlot[], mergeAb = false): Unit[] {
  const units: Unit[] = [];
  const push = (s: AssembleSlot) => {
    for (const it of s.items) {
      if (it.kind === 'statement-pair' && it.parts) {
        const a = it.parts.find((p) => p.part === 'a');
        const b = it.parts.find((p) => p.part === 'b');
        units.push({
          lines: [
            { sub: 'a', text: `${quoted(it)} Explain this view.`, marks: a?.marks ?? 10 },
            { sub: 'b', text: 'Using sociological material, give one argument against this view.', marks: b?.marks ?? 6 },
          ],
        });
      } else {
        units.push({ lines: [{ text: questionText(it), marks: it.marksTotal }] });
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

interface Block {
  runs: { text: string; bold?: boolean }[];
  center?: boolean;
  size?: number;
  gapBefore?: number;
}

const plain = (text: string, size?: number): Block => ({ runs: [{ text }], size });

const marksSuffix = (marks: number) => ` [${marks}]`;

// 普通槽：逐题编号
function numberedBlocks(units: Unit[], start: number): { blocks: Block[]; next: number } {
  const blocks: Block[] = [];
  let n = start;
  for (const u of units) {
    if (u.lines.length === 1) {
      blocks.push(plain(`${n} ${u.lines[0].text}${marksSuffix(u.lines[0].marks)}`));
    } else {
      for (const l of u.lines) {
        blocks.push(plain(`${n} (${l.sub}) ${l.text}${marksSuffix(l.marks)}`));
      }
    }
    n++;
  }
  return { blocks, next: n };
}

// 二选一槽：EITHER / OR
function eitherBlocks(slot: AssembleSlot): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < slot.items.length; i++) {
    const it = slot.items[i];
    const word = i === 0 ? 'EITHER' : 'OR';
    blocks.push({ runs: [{ text: `${word} `, bold: true }, { text: `${questionText(it)}${marksSuffix(it.marksTotal)}` }], gapBefore: i === 0 ? 1 : 0 });
  }
  return blocks;
}

// 版本差异：P1/P2 两套；正文排版统一；返回段落数组
export function buildBlocks(o: ExportOpts): Block[] {
  const blocks: Block[] = [];
  const isTemplate = o.mode === 'template' && o.slots.length > 0;

  const addSectionHeader = (text: string) => {
    blocks.push({ runs: [{ text, bold: true }], center: true, size: HEAD });
  };

  if (isTemplate && o.paper === 4) {
    // P4：Section A/B 各一个二选一 35 分槽
    if (o.extraNote) blocks.push(plain(o.extraNote, HEAD));
    o.slots.forEach((slot, i) => {
      const header = `Section ${String.fromCharCode(65 + i)}`;
      addSectionHeader(header);
      blocks.push(...eitherBlocks(slot));
    });
    return blocks;
  }

  const plainSlots = o.slots.filter((s) => !s.spec.eitherOr);
  const eitherSlots = o.slots.filter((s) => s.spec.eitherOr);
  const hasEither = eitherSlots.length > 0;

  if (isTemplate && (o.paper === 1 || o.paper === 2)) {
    // Section A：全部作答的小分题（q1..q3）
    addSectionHeader('Section A');
    blocks.push(plain('Answer all questions in this section.', HEAD));
    const { blocks: qb } = numberedBlocks(slotToUnits(plainSlots, true), 1);
    blocks.push(...qb);
    if (hasEither) {
      addSectionHeader('Section B');
      blocks.push(plain('Answer one question in this section.', HEAD));
      for (const s of eitherSlots) blocks.push(...eitherBlocks(s));
    }
    return blocks;
  }

  if (isTemplate && o.paper === 3) {
    // P3：全卷作答，无 Section 分节（对照 draft）
    blocks.push(plain('Answer all questions.', HEAD));
    const { blocks: qb } = numberedBlocks(slotToUnits(plainSlots, true), 1);
    blocks.push(...qb);
    return blocks;
  }

  // 自由 / 目标凑分 / 单题：不加 Section，连续编号（pair 仍拆 a/b）
  const { blocks: qb } = numberedBlocks(slotToUnits(o.slots, false), 1);
  blocks.push(...qb);
  return blocks;
}

const sanitizeName = (t: string) => t.replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 80);

export async function exportPaperToDocx(o: ExportOpts): Promise<void> {
  const blocks = buildBlocks(o);
  const paras = blocks.map((b) => new Paragraph({
    alignment: b.center ? AlignmentType.CENTER : AlignmentType.LEFT,
    spacing: { after: 60, before: b.gapBefore ? 120 : 0, line: 276 },
    children: b.runs.map((r) => new TextRun({
      text: r.text,
      bold: r.bold,
      font: CALIBRI,
      size: b.size ?? BODY,
    })),
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
