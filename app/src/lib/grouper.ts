// 组卷器核心引擎（P0）：模板/槽位定义 + 从题库自动选配 + 凑分
// 口径见《组卷器方案.md》与《组卷器数据模型初稿.md》§2/§5
// 纯函数、无 React 依赖，便于测试与复用。

export interface BankItem {
  qid: string;
  source: { session: string; paper: number; variant: number; comp: string; q: string | null };
  stem: string;
  statement: string | null;
  marks: string;
  marksTotal: number;
  kind: 'plain' | 'statement' | 'statement-pair';
  parts?: { part: string; marks: number; side: string }[];
  topics: string[];
}
export type PaperId = 1 | 2 | 3 | 4;

export interface SlotSpec {
  key: string;            // 'q1[4]' / 'q2a[8]' / 'q45[26]x2'…
  label: string;
  marks: string;          // 分值块：'4'/'8'/'6'/'10+6'/'12'/'26'/'35'
  marksTotal: number;
  count: number;          // 该槽要放几题
  kind?: BankItem['kind'];
  eitherOr?: boolean;     // 二选一展示（Q4/Q5、P4 每对）：多选一候选题放在同一槽
  sides?: boolean;        // statement-pair 成对（10+6）
}
export interface Template {
  id: string;
  label: string;
  paper: PaperId;
  slots: SlotSpec[];
}
export interface AssembleSlot {
  spec: SlotSpec;
  items: BankItem[];      // count=1→单题；eitherOr→2 道候选
}
export interface AssembleResult {
  template: Template;
  slots: AssembleSlot[];
  total: number;
  usedQids: Set<string>;
}

export const markTotal = (s: string) => (s.match(/\d+/g) || []).reduce((a, b) => a + Number(b), 0);

// —— 真题卷面模板（《组卷器方案.md》§1.1）——
export const TEMPLATES: Template[] = [
  {
    id: 'p1', label: 'Paper 1 全卷（60）', paper: 1,
    slots: [
      { key: 'q1', label: 'Q1 描述', marks: '4', marksTotal: 4, count: 1 },
      { key: 'q2a', label: 'Q2(a) 解释×2', marks: '8', marksTotal: 8, count: 1 },
      { key: 'q2b', label: 'Q2(b) 一强一弱', marks: '6', marksTotal: 6, count: 1 },
      { key: 'q3', label: 'Q3 观点陈述（成对 10+6）', marks: '10+6', marksTotal: 16, count: 1, kind: 'statement-pair', sides: true },
      { key: 'q45', label: 'Q4/Q5 论述（二选一）', marks: '26', marksTotal: 26, count: 2, eitherOr: true },
    ],
  },
  {
    id: 'p2', label: 'Paper 2 全卷（60）', paper: 2,
    slots: [
      { key: 'q1', label: 'Q1 描述', marks: '4', marksTotal: 4, count: 1 },
      { key: 'q2a', label: 'Q2(a) 解释×2', marks: '8', marksTotal: 8, count: 1 },
      { key: 'q2b', label: 'Q2(b) 一强一弱', marks: '6', marksTotal: 6, count: 1 },
      { key: 'q3', label: 'Q3 观点陈述（成对 10+6）', marks: '10+6', marksTotal: 16, count: 1, kind: 'statement-pair', sides: true },
      { key: 'q45', label: 'Q4/Q5 论述（二选一）', marks: '26', marksTotal: 26, count: 2, eitherOr: true },
    ],
  },
  {
    id: 'p3', label: 'Paper 3 全卷（50）', paper: 3,
    slots: [
      { key: 'q1', label: 'Q1 描述', marks: '4', marksTotal: 4, count: 1 },
      { key: 'q2', label: 'Q2 解释×2', marks: '8', marksTotal: 8, count: 1 },
      { key: 'q3', label: 'Q3 观点反驳（12）', marks: '12', marksTotal: 12, count: 1 },
      { key: 'q4', label: 'Q4 论述', marks: '26', marksTotal: 26, count: 1 },
    ],
  },
  {
    id: 'p4', label: 'Paper 4 全卷（70）', paper: 4,
    slots: [
      { key: 'sec1', label: 'Section 一对 35（二选一）', marks: '35', marksTotal: 35, count: 2, eitherOr: true },
      { key: 'sec2', label: 'Section 二对 35（二选一）', marks: '35', marksTotal: 35, count: 2, eitherOr: true },
    ],
  },
];

const shuffle = <T,>(a: T[], seed = Date.now()) => {
  const arr = [...a];
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

// 题目是否可用：kind 与 marks 口径匹配（含 statement-pair 成对与 P4 单题 35）
function compatible(it: BankItem, spec: SlotSpec): boolean {
  if (spec.kind && it.kind !== spec.kind) return false;
  if (it.marks !== spec.marks) return false;
  return true;
}

/** 按模板组卷：每槽从候选池洗牌抽 count 题（eitherOr 槽为展示 2 道候选，二者不重复即可） */
export function assembleTemplate(bank: BankItem[], template: Template, topicFilter?: string, usedQids?: Set<string>): AssembleResult {
  const pool = topicFilter
    ? bank.filter((it) => it.source.paper === template.paper && it.topics.some((t) => t === topicFilter))
    : bank.filter((it) => it.source.paper === template.paper);
  const used = usedQids ? new Set(usedQids) : new Set<string>();
  const slots: AssembleSlot[] = [];
  for (const spec of template.slots) {
    let cands = shuffle(pool.filter((it) => compatible(it, spec) && !used.has(it.qid)));
    if (spec.eitherOr) cands = cands.slice(0, spec.count); // 二选一：取 count 道不同候选
    else cands = cands.slice(0, spec.count);
    for (const it of cands) used.add(it.qid);
    slots.push({ spec, items: cands });
  }
  const total = slots.reduce((s, x) => s + x.spec.marksTotal, 0);
  return { template, slots, total, usedQids: used };
}

/** 单题布置：从某卷/某考点按题号或分值取一题 */
export function pickSingle(bank: BankItem[], paper: PaperId, opts: { q?: string; marks?: string; topic?: string; session?: string }): BankItem | undefined {
  return shuffle(bank.filter((it) =>
    it.source.paper === paper &&
    (!opts.q || it.source.q === opts.q) &&
    (!opts.marks || it.marks === opts.marks) &&
    (!opts.session || it.source.session === opts.session) &&
    (!opts.topic || it.topics.includes(opts.topic)),
  ))[0];
}

/** 凑分（作业减量）：从可用题池中选若干题使 marksTotal 之和恰为 target（≤4 题，深度受限回溯） */
export function assembleToTarget(bank: BankItem[], target: number, topicFilter?: string, maxItems = 6): AssembleSlot[] | null {
  const units = shuffle(topicFilter
    ? bank.filter((it) => it.topics.some((t) => t === topicFilter))
    : bank);
  const used = new Set<string>();
  // 分值块候选（含 10+6 单侧抽题的减量允许；statement-pair 成对仍整体 16）
  const items: { it: BankItem; v: number }[] = [];
  for (const it of units) {
    if (it.marksTotal <= target) items.push({ it, v: it.marksTotal });
  }
  const n = items.length;
  const chosen: { it: BankItem; v: number }[] = [];
  const dfs = (start: number, sum: number, depth: number): boolean => {
    if (sum === target) return true;
    if (sum > target || depth >= maxItems) return false;
    for (let i = start; i < n; i++) {
      if (used.has(items[i].it.qid)) continue;
      used.add(items[i].it.qid);
      chosen.push(items[i]);
      if (dfs(i + 1, sum + items[i].v, depth + 1)) return true;
      chosen.pop();
      used.delete(items[i].it.qid);
    }
    return false;
  };
  if (!dfs(0, 0, 0)) return null;
  const byMarks = new Map<string, BankItem[]>();
  for (const c of chosen) {
    const k = c.it.marks;
    byMarks.set(k, [...(byMarks.get(k) || []), c.it]);
  }
  return [...byMarks.entries()].map(([marks, arr]) => ({
    spec: { key: `free[${marks}]`, label: `自由组题 ${marks} 分`, marks, marksTotal: markTotal(marks), count: arr.length },
    items: arr,
  }));
}
