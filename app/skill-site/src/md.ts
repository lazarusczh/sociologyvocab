// 教材问答回答的极简 markdown 分块解析（与渲染解耦，便于测试）。
//
// 两类会让「列表编号全部变成 1.」的情况，这里都处理掉：
// 1) 列表项之间夹空行（"1. …\n\n2. …"）——按空行切块会得到多个单元素 <ol>，各自从 1 开始；
// 2) 项内带缩进子项（"1. **功能主义**：\n   - 传递共同价值"）——子列表若另起一个块，
//    同样会把父列表切碎。这里把更深的缩进视为「当前项的子项」。
// 另外保留源编号（num），渲染时直接显示模型给的序号，不再依赖 <ol> 自动计数。
//
// 模型常用「整行加粗」当小标题（**核心机制**），识别为标题块交给样式统一渲染。
export interface MdListItem {
  num?: string;    // 有序项的源编号（"1" / "2"…），渲染时原样显示
  text: string;
  subs: string[];  // 缩进更深、作为该项子项的行
}

export type MdBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'ul'; items: MdListItem[] }
  | { kind: 'ol'; items: MdListItem[] }
  | { kind: 'p'; text: string };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^[-*•]\s+(.*)$/;
const OL_RE = /^(\d+)[.)]\s+(.*)$/;
// 整行加粗（可带尾部冒号）且不含其它正文，如 "**机制**" / "**4. 评价：**"
const BOLD_LINE_RE = /^\*\*([^*]{2,60})\*\*[：:]?$/;

interface ListState {
  type: 'ul' | 'ol';
  indent: number;
  items: MdListItem[];
}

/**
 * 计算有序列表每项要显示的编号：
 * 源编号连续递增（1,2,3…）时沿用源编号；不连续（兜底档模型常把每项都写成 1.）时改用自增，
 * 保证列表无论如何都是 1. 2. 3.。
 */
export function orderedLabels(items: MdListItem[]): string[] {
  const src = items.map((i) => Number.parseInt(i.num ?? '', 10));
  const sequential = src.every((n, k) =>
    Number.isFinite(n) && (k === 0 ? n > 0 : n === src[k - 1] + 1),
  );
  let auto = 0;
  return items.map((_it, k) => (sequential ? String(src[k]) : String(++auto)));
}

export function parseBlocks(text: string): MdBlock[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: ListState | null = null;

  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: 'p', text: para.join(' ') });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push(
        list.type === 'ul' ? { kind: 'ul', items: list.items } : { kind: 'ol', items: list.items },
      );
      list = null;
    }
  };

  for (const raw of lines) {
    const t = raw.trim();
    if (!t) {
      flushPara();      // 空行结束段落，但不结束列表（列表项之间常有空行）
      continue;
    }

    const indent = raw.length - raw.replace(/^\s*/, '').length;

    const h = t.match(HEADING_RE);
    if (h) {
      flushPara();
      flushList();
      blocks.push({ kind: 'heading', level: h[1].length, text: h[2].trim() });
      continue;
    }

    // 整行加粗 → 小标题（优先于「列表延续」：列表中途的小标题也要能识别）
    const b = t.match(BOLD_LINE_RE);
    if (b) {
      flushPara();
      flushList();
      blocks.push({ kind: 'heading', level: 4, text: b[1].trim() });
      continue;
    }

    const ol = t.match(OL_RE);
    const ul = t.match(UL_RE);
    if (ol || ul) {
      const itemText = (ol ? ol[2] : ul![1]).trim();
      const type: 'ul' | 'ol' = ol ? 'ol' : 'ul';
      const num = ol ? ol[1] : undefined;

      // 缩进更深 → 当前项的子项（不新起列表，父列表因此保持完整）
      if (list && indent > list.indent && list.items.length) {
        list.items[list.items.length - 1].subs.push(num ? `${num}. ${itemText}` : itemText);
        continue;
      }

      flushPara();
      if (list && (indent < list.indent || (indent === list.indent && list.type !== type))) {
        flushList();
      }
      if (!list) list = { type, indent, items: [] };
      list.items.push({ num, text: itemText, subs: [] });
      continue;
    }

    flushList();
    para.push(t);
  }
  flushPara();
  flushList();
  return blocks;
}
