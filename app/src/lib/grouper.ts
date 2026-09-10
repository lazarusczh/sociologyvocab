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
  unit?: 'globalisation' | 'media'; // P4 专用：该槽候选限定来自哪个真题语料
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
      { key: 'sec1', label: 'Section A（Globalisation）35 二选一', marks: '35', marksTotal: 35, count: 2, eitherOr: true, unit: 'globalisation' },
      { key: 'sec2', label: 'Section B（Media）35 二选一', marks: '35', marksTotal: 35, count: 2, eitherOr: true, unit: 'media' },
    ],
  },
];

/** P4 语料归属：按题目的主主题（topics[0]）判定来自 Globalisation 还是 Media 真题卷
 *  Media 卷主主题均含 'media'（media effects / media representations / …），Globalisation 卷主主题不含；
 *  两卷互斥、无交集（经 question-bank.json P4 全部 124 道 35 分题核验，60 vs 64）。 */
export function p4UnitOf(it: Pick<BankItem, 'topics'>): 'globalisation' | 'media' {
  return (it.topics[0] ?? '').toLowerCase().includes('media') ? 'media' : 'globalisation';
}

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

/** 按模板组卷：每槽从候选池洗牌抽 count 题（eitherOr 槽为展示 2 道候选，二者不重复即可）
 *  topicFilters 为多选考点：命中任一即入池；空数组/未传 = 不限 */
export function assembleTemplate(bank: BankItem[], template: Template, topicFilters?: string[], usedQids?: Set<string>): AssembleResult {
  const pool = topicFilters && topicFilters.length
    ? bank.filter((it) => it.source.paper === template.paper && it.topics.some((t) => topicFilters.includes(t)))
    : bank.filter((it) => it.source.paper === template.paper);
  const used = usedQids ? new Set(usedQids) : new Set<string>();
  const slots: AssembleSlot[] = [];
  for (const spec of template.slots) {
    // P4：槽位带 unit 时，只在该语料（Globalisation/Media）内抽候选，保证一对候选同语料、两对分属两语料
    let cands = shuffle(pool.filter((it) =>
      compatible(it, spec) && !used.has(it.qid) && (!spec.unit || p4UnitOf(it) === spec.unit),
    ));
    if (spec.eitherOr) cands = cands.slice(0, spec.count); // 二选一：取 count 道不同候选
    else cands = cands.slice(0, spec.count);
    for (const it of cands) used.add(it.qid);
    slots.push({ spec, items: cands });
  }
  const total = slots.reduce((s, x) => s + x.spec.marksTotal, 0);
  return { template, slots, total, usedQids: used };
}

/** 单题布置：从某卷/某考点按题号或分值取一题（topics 为多选考点，命中任一即可） */
export function pickSingle(bank: BankItem[], paper: PaperId, opts: { q?: string; marks?: string; topics?: string[]; session?: string }): BankItem | undefined {
  return shuffle(bank.filter((it) =>
    it.source.paper === paper &&
    (!opts.q || it.source.q === opts.q) &&
    (!opts.marks || it.marks === opts.marks) &&
    (!opts.session || it.source.session === opts.session) &&
    (!opts.topics || opts.topics.length === 0 || it.topics.some((t) => opts.topics!.includes(t))),
  ))[0];
}

/** 凑分（作业减量）：从可用题池中选若干题使 marksTotal 之和恰为 target（≤4 题，深度受限回溯）
 *  topicFilters 为多选考点：命中任一即入池；空数组/未传 = 不限 */
export function assembleToTarget(bank: BankItem[], target: number, topicFilters?: string[], maxItems = 6): AssembleSlot[] | null {
  const units = shuffle(topicFilters && topicFilters.length
    ? bank.filter((it) => it.topics.some((t) => topicFilters.includes(t)))
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

// ===== 历史重复检测（新组卷时比对已保存卷面） =====
// 判据（教师确认口径）：
//  - 已出过：同一题（qid 完全相同）
//  - 近考点：非同一题，但最细考点（topics 末层叶子标题）相同 → 保守提醒，少打扰
export type DupKind = 'exact' | 'similar';

export interface DupIndex {
  qids: Set<string>;       // 历史出现过的所有题目 id
  leafTopics: Set<string>; // 历史出现过的所有最细考点
}

export const EMPTY_DUP_INDEX: DupIndex = { qids: new Set(), leafTopics: new Set() };

/** 题目最细考点（topics 末元素，无则空串） */
export const leafTopicOf = (it: Pick<BankItem, 'topics'>): string => it.topics.length ? it.topics[it.topics.length - 1] : '';

/** 从历史卷面快照（grouper_runs.slots）构建去重索引；入参宽松，兼容脏数据 */
export function buildDupIndex(runs: { slots: unknown }[]): DupIndex {
  const qids = new Set<string>();
  const leafTopics = new Set<string>();
  for (const run of runs) {
    const slots = Array.isArray(run.slots) ? (run.slots as AssembleSlot[]) : [];
    for (const s of slots) {
      for (const it of s?.items ?? []) {
        if (it?.qid) qids.add(it.qid);
        const leaf = leafTopicOf(it);
        if (leaf) leafTopics.add(leaf);
      }
    }
  }
  return { qids, leafTopics };
}

/** 判定某题是否与历史重复：exact 优先于 similar；无重复返回 null */
export function dupKindOf(it: BankItem, idx: DupIndex): DupKind | null {
  if (idx.qids.has(it.qid)) return 'exact';
  const leaf = leafTopicOf(it);
  if (leaf && idx.leafTopics.has(leaf)) return 'similar';
  return null;
}
