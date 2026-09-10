// 教材问答回答的极简 markdown 分块解析（与渲染解耦，便于测试）。
//
// 为什么不能按空行粗暴切块：
//   模型常在列表项之间插入空行（"1. …\n\n2. …"），若按 \n{2,} 切片，
//   每个列表项都会变成独立的单元素 <ol>，浏览器各自从 1 开始编号
//   —— 这正是「每个编号都是 1.」的原因。这里改为按行扫描、跨空行合并列表项。
//
// 另外，模型常用「整行加粗」当小标题（**核心机制**），这里识别为标题块，
// 交给样式统一渲染，避免与正文段落视觉上无法区分。
export type MdBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'p'; text: string };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^[-*•]\s+(.*)$/;
const OL_RE = /^\d+[.)]\s+(.*)$/;
// 整行加粗（可带尾部冒号）且不含其它正文，如 "**机制**" / "**4. 评价：**"
const BOLD_LINE_RE = /^\*\*([^*]{2,60})\*\*[：:]?$/;

export function parseBlocks(text: string): MdBlock[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;

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

    const ul = t.match(UL_RE);
    if (ul) {
      flushPara();
      if (list && list.type !== 'ul') flushList();
      if (!list) list = { type: 'ul', items: [] };
      list.items.push(ul[1].trim());
      continue;
    }

    const ol = t.match(OL_RE);
    if (ol) {
      flushPara();
      if (list && list.type !== 'ol') flushList();
      if (!list) list = { type: 'ol', items: [] };
      list.items.push(ol[1].trim());
      continue;
    }

    flushList();
    para.push(t);
  }
  flushPara();
  flushList();
  return blocks;
}
