// 人设投喂：拼提示词 + 校验模型返回
//
// 口径（见《模拟调研人设卡.md》第二、四节）：
//   · 一次调用同时产出「答案」与「内心」，但落库分两张表（RPC 在同一事务里写）
//   · 卡里的选项字母只对应**当时那版试点问卷**；真实问卷是学生当场写的，
//     所以必须按选项文字的意思对应，不能照抄卡里的字母 —— 这是最容易静默答错的一处
//   · 内心不得自曝「问卷 / 题目 / 选项 / 设计 / 测量 / 效度 / 样本 / 代表性」
//   · 客户端不传 system：卡片内容只来自云端 sim_personas（teacher-only），本文件不含任何卡片正文
import { parseJsonLoose } from './ai';
import type { SimPaperItem, SimPersona, SimQType } from './sim';

export interface PersonaAnswer {
  qid: string;
  value?: unknown;
  skipped?: boolean;
}

export interface PersonaResult {
  answers: PersonaAnswer[];
  inner: { qid: string; text: string }[];
  closing: string;
}

const QT_LABEL: Record<SimQType, string> = {
  single: '单选（选一个）',
  multi: '多选（可选多个）',
  scale: '程度量表（数字）',
};

// 自曝检查：出现这些词说明模型在点评题目/方法，整节课的教学点会当场报废
const BANNED = ['问卷', '题目', '选项', '设计', '测量', '效度', '样本', '代表性'];

const nonEmpty = (s: unknown): string => (typeof s === 'string' ? s.trim() : '');

export function buildPersonaPrompt(card: SimPersona['card'], items: SimPaperItem[], name: string): string {
  const person = [
    `姓名：${name}`,
    card.who ? `身份：${card.who}` : '',
    card.scene ? `作答场景：${card.scene}` : '',
    card.facts ? `事实内核（只能依据这里，不要新增事实）：\n${card.facts}` : '',
    card.voice ? `语言指纹：${card.voice}` : '',
    card.surface ? `表层呈现规则（决定勾什么）：\n${card.surface}` : '',
    card.inner ? `内心规则（决定心里那句是什么）：\n${card.inner}` : '',
    card.extra ? `红线与补充：\n${card.extra}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const paper = items
    .map((it, i) => {
      const opts = it.options.map((o) => `${o.key}. ${o.label || '（只有数字，无文字）'}`).join('\n   ');
      return `第 ${i + 1} 题（qid=${it.qid}，${QT_LABEL[it.qtype]}）
   题干：${it.stem}
   选项：
   ${opts}`;
    })
    .join('\n\n');

  return `你要完全代入下面这个人，填一份封闭式问卷。你不是助手，不要解释，不要跳出角色。

【人物卡】
${person}

【问卷】（共 ${items.length} 题，全部是封闭题）
${paper}

【怎么答】
1. 每一题都必须作答。只有人物卡里**明确写了会留空**的题，才允许写成 {"qid":"…","skipped":true}。
2. 单选：给选项字母（字符串，如 "B"）；多选：给字母数组（如 ["A","D"]，至少 1 项）；量表：给该题编号里的一个整数（从 1 到该题的点数）。
3. **卡里如果写了具体字母（例如"只勾 A、D、H"），那是对另一版试点问卷说的，不要照抄。** 必须按选项文字的**意思**重新对应到本卷的字母。
4. 答案必须是本卷出现过的字母/数字，不能自己造选项，不能写选项文字。
5. 另外写「内心」：只挑**有东西没说出口**的题（含所有留空的题），一题一句，第一人称口语，不超过 30 字，只讲"我为什么这么勾 / 哪里没说出来"，不要复述选项。
6. 内心与收尾**绝不能**出现这些词：${BANNED.join('、')}。也不要评价这次调查本身。
7. closing：一句收尾的心里话，第一人称，不超过 60 字，不提问卷、不升华。
8. 不引入人物卡之外的新事实（新的人、病、收入、事件都不行）。

只输出 JSON，不要 markdown、不要解释：
{"answers":[{"qid":"…","value":"A"}],"inner":[{"qid":"…","text":"…"}],"closing":"…"}`;
}

export interface ParseOutcome {
  result: PersonaResult | null;
  error: string | null;
}

/** 校验并归一化模型返回；不合格整份丢弃（由调用方重试） */
export function parsePersonaResult(text: string, items: SimPaperItem[]): ParseOutcome {
  const raw = parseJsonLoose<{ answers?: unknown; inner?: unknown; closing?: unknown }>(text);
  if (!raw) return { result: null, error: '模型没有返回合法 JSON' };

  const list = Array.isArray(raw.answers) ? raw.answers : [];
  const byQid = new Map<string, { value?: unknown; skipped?: boolean }>();
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const rec = a as Record<string, unknown>;
    const qid = nonEmpty(rec.qid);
    if (!qid) continue;
    byQid.set(qid, { value: rec.value, skipped: rec.skipped === true });
  }

  const bad: string[] = [];
  const answers: PersonaAnswer[] = [];

  for (const it of items) {
    const got = byQid.get(it.qid);
    const label = `第 ${items.indexOf(it) + 1} 题`;
    if (!got) {
      bad.push(`${label}（${it.qid}）没有答案`);
      continue;
    }
    if (got.skipped) {
      answers.push({ qid: it.qid, skipped: true });
      continue;
    }
    const keys = it.options.map((o) => o.key);
    // 模型偶尔会把选项文字当答案返回：能对上就换算成字母，对不上才算不合格
    const toKey = (x: unknown): string => {
      const s = nonEmpty(x);
      if (keys.includes(s)) return s;
      const byLabel = it.options.find((o) => o.label && o.label === s);
      return byLabel ? byLabel.key : s;
    };
    if (it.qtype === 'single') {
      const v = toKey(got.value);
      if (!keys.includes(v)) {
        bad.push(`${label} 的答案「${String(got.value)}」不在选项内`);
        continue;
      }
      answers.push({ qid: it.qid, value: v });
    } else if (it.qtype === 'multi') {
      const arr = Array.isArray(got.value) ? got.value : typeof got.value === 'string' ? [got.value] : [];
      const vals = arr.map(toKey).filter(Boolean);
      if (vals.length === 0 || vals.some((v) => !keys.includes(v))) {
        bad.push(`${label} 的多选答案不在选项内`);
        continue;
      }
      answers.push({ qid: it.qid, value: Array.from(new Set(vals)) });
    } else {
      const n = typeof got.value === 'number' ? got.value : Number(nonEmpty(got.value));
      if (!Number.isInteger(n) || n < 1 || n > it.options.length) {
        bad.push(`${label} 的量表答案「${String(got.value)}」应为 1–${it.options.length} 的整数`);
        continue;
      }
      answers.push({ qid: it.qid, value: n });
    }
  }

  if (bad.length) return { result: null, error: `作答不完整：${bad.join('；')}` };

  const innerRaw = Array.isArray(raw.inner) ? raw.inner : [];
  const qids = new Set(items.map((x) => x.qid));
  const inner = innerRaw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({ qid: nonEmpty(x.qid), text: nonEmpty(x.text) }))
    .filter((x) => x.qid && x.text && qids.has(x.qid));

  const skipped = answers.filter((a) => a.skipped).map((a) => a.qid);
  const innerQids = new Set(inner.map((x) => x.qid));
  const missed = skipped.filter((qid) => !innerQids.has(qid));
  if (missed.length) return { result: null, error: '留空的题必须在内心里给出理由' };

  const closing = nonEmpty(raw.closing);
  if (!closing) return { result: null, error: '缺少收尾（closing）' };

  const blob = `${inner.map((x) => x.text).join('')}${closing}`;
  const hit = BANNED.find((w) => blob.includes(w));
  if (hit) return { result: null, error: `内心自曝了「${hit}」—— 不能说题目/方法的事` };

  return { result: { answers, inner, closing }, error: null };
}
