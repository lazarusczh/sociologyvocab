// ManageBac 分数同步：短码 / 成绩册 URL / 名单 xlsx —— 纯函数，不碰云端
// 约定与流程见仓库根目录《分数同步到ManageBac方案.md》；表结构见 db-migration-mb-sync.sql
import * as XLSX from 'xlsx';

// 短码的年级位。
//
// 9699（A Level）分 A1 / A2：A1 学 Paper 1-2、A2 学 Paper 3-4。
// 0495（IGCSE）**没有 A1/A2 之分**，只有一张证书；但学校实际按 G1 / G2 两个年级分开教，
// 所以短码前缀需要 G1 / G2 两个位（2026-11-10 用户确认：实际存在 G1 与 G2 年级）。
//
// ⚠ 0495 的 G1/G2 **无法自动推断**：Paper 1 与 Paper 2 是同一张证书、同一场考试，
// 卷号推不出年级；班级名也只能说明「这是 G1 班」，不知道这条记录该发给谁。
// 因此 0495 一律由教师在下拉里手选（见 needsManualGrade），这里不做任何猜测。
// 早期实现只有 'A1' | 'A2'，0495 的卷子会被 `paper <= 2` 判成 A1，
// 短码就和 A1 班撞在同一个前缀上，教师按短码去 ManageBac 找 task 时会对到错的成绩册。
// 详见 db-migration-run-syllabus.sql —— 归属落在行上，不靠界面当前状态。
export type Grade = 'A1' | 'A2' | 'G1' | 'G2';

/** 年级下拉的选项（顺序即展示顺序）；0495 只会用到 G1 / G2 */
export const GRADE_OPTIONS: { value: Grade; label: string }[] = [
  { value: 'A1', label: 'A1' },
  { value: 'A2', label: 'A2' },
  { value: 'G1', label: 'G1' },
  { value: 'G2', label: 'G2' },
];

// 班级名与年级的别名（与 PaperResults.tsx 的 GROUP_ALIASES 同口径：学校目前把 A1 班登记为 AS）
const GROUP_ALIASES: Record<Grade, string[]> = {
  A1: ['A1', 'AS'],
  A2: ['A2'],
  // IGCSE 班按年级登记为 "G1 Sociology" / "G2 Sociology"
  G1: ['G1'],
  G2: ['G2'],
};

/**
 * 该大纲的年级位是否必须由教师手选（0495 → G1/G2 无法推断）。
 * 调用点用它决定：下拉是否留空等选、自动生成短码是否跳过。
 */
export function needsManualGrade(syllabus?: string | null): boolean {
  return (syllabus || '') === '0495';
}

/**
 * 从班级名认出年级（G1 / G2 / AS→A1 / A2），认不出返回 null。
 * 只用于「这位教师教的班」推默认筛选口径 —— 短码那边仍然是手选或按卷号推断，
 * 不要拿它替代 inferGrade。
 */
export function gradeFromClassName(className: string): Grade | null {
  for (const opt of GRADE_OPTIONS) {
    if (classMatchesGrade(className, opt.value)) return opt.value;
  }
  return null;
}

/** 把任意字符串收窄成 Grade（短码前缀、下拉值都用它兜底）；认不出返回 null */
export function asGrade(v: unknown): Grade | null {
  const s = String(v ?? '').trim().toUpperCase();
  return GRADE_OPTIONS.find((o) => o.value === s)?.value ?? null;
}

const norm = (s: string) => (s || '').replace(/\s+/g, '').toUpperCase();

/**
 * 年级位：优先采信卷名里写明的 AS/A1/A2/G1/G2；否则按卷号推。
 *
 * ⚠ 0495 在卷名没写年级时返回 `null`（推不出）：它只有一张证书，
 * G1/G2 是教学年级而不是考试层级，卷号给不出答案 —— 必须由教师在下拉里手选，
 * 见 `needsManualGrade`。
 *
 * `syllabus` 缺省视为 9699 —— 保持历史行为不变（调用点都是既有代码）。
 */
export function inferGrade(title: string, paper: number, syllabus?: string | null): Grade | null {
  const t = (title || '').toUpperCase();
  // 卷名里明写的优先：教师写 "G2 家庭" / "A2 家庭" 比自动推断更可靠，两个大纲都照此
  if (/\bG\s*2\b/.test(t)) return 'G2';
  if (/\bG\s*1\b/.test(t)) return 'G1';
  if (/\bAS\b/.test(t) || /\bA\s*1\b/.test(t)) return 'A1';
  if (/\bA\s*2\b/.test(t)) return 'A2';
  // 0495 其余情况一律不猜：G1/G2 只能靠人
  if (needsManualGrade(syllabus)) return null;
  return paper <= 2 ? 'A1' : 'A2';
}

/** 班级名是否属于某年级（A1 与 AS 同义） */
export function classMatchesGrade(className: string, grade: Grade): boolean {
  const n = norm(className);
  return GROUP_ALIASES[grade].some((a) => n.includes(a));
}

/** 取 papers 里第一个可用 paper 号（1–4）；取不到返回 0 */
export function firstPaperNumber(papers: string[] | null | undefined): number {
  for (const p of papers ?? []) {
    const m = /(\d+)/.exec(String(p ?? ''));
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 4) return n;
    }
  }
  return 0;
}

/**
 * 从 papers 推年级位（P1/P2 → A1、P3/P4 → A2）；推不出返回 null。
 * ⚠️ 2026-09-15 踩坑：`quizzes.papers` 实际存的是 **"Paper 3"** 这种写法
 * （见 QuizManager 的 `papers: [draft.paper]`，draft.paper 取值 'Paper N'）。
 * 早期实现只 `replace(/^P/,'')` → "APER 3" → Number() 得 NaN → 判定推不出 → 兜底成 A1 ✗。
 * 因此这里改为**取字符串里的数字**，兼容 '3' / 'P3' / 'Paper 3' / 'paper3' 等写法。
 *
 * ⚠ 0495 传 syllabus 进来时**直接返回 null**：它只有一张证书，G1/G2 是教学年级而非考试层级，
 * 卷号里没有这个信息（见 `needsManualGrade`）。
 */
export function gradeFromPapers(papers: string[] | null | undefined, syllabus?: string | null): Grade | null {
  if (needsManualGrade(syllabus)) return null;
  const nums = (papers ?? [])
    .map((p) => {
      const m = /(\d+)/.exec(String(p ?? ''));
      return m ? Number(m[1]) : NaN;
    })
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 4);
  if (nums.length === 0) return null;
  return Math.max(...nums) <= 2 ? 'A1' : 'A2';
}

/** 短码主体（不含冲突后缀）：A1-0712 */
export function shortCodeBase(grade: Grade, d: Date = new Date()): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${grade}-${mm}${dd}`;
}

const CONFLICT_SUFFIX = 'bcdefghijklmnopqrstuvwxyz';

/** 在已占用集合里挑一个没占用的短码：A1-0712 → A1-0712b → A1-0712c */
export function pickShortCode(base: string, taken: Iterable<string>): string {
  const set = new Set(Array.from(taken, (t) => (t ?? '').toUpperCase()));
  if (!set.has(base.toUpperCase())) return base;
  for (const s of CONFLICT_SUFFIX) {
    const cand = `${base}${s}`;
    if (!set.has(cand.toUpperCase())) return cand;
  }
  // 极端兜底：保证一定能生成（正常一年内不可能走到这里）
  return `${base}${Date.now().toString(36)}`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 严格匹配用：task 名里的「[短码]」（方括号内可带空格） */
export function shortCodePattern(code: string): RegExp {
  return new RegExp(`\\[\\s*${escapeRe(code)}\\s*\\]`, 'i');
}

/** 从 task 名里提取短码（用于反查与提示，不做任何猜测性匹配） */
export function extractShortCode(taskName: string): string | null {
  const m = /\[\s*([A-Za-z]\d-\d{4}[a-z]?)\s*\]/.exec(taskName ?? '');
  return m ? m[1].toUpperCase() : null;
}

/** 在 task 名列表里按短码精确找出唯一命中；0 个或多个都返回空（绝不猜） */
export function findTaskByShortCode<T>(
  tasks: T[],
  code: string,
  nameOf: (t: T) => string,
): { hit: T | null; matches: T[] } {
  const re = shortCodePattern(code);
  const matches = tasks.filter((t) => re.test(nameOf(t)));
  return { hit: matches.length === 1 ? matches[0] : null, matches };
}

// ---------------- 成绩册 URL ----------------

export type ClassUrlParse =
  | { ok: true; classId: string; host: string }
  | { ok: false; reason: string };

/**
 * 解析 ManageBac 成绩册 URL → 班级号。
 * 接受 .../gradebook/core_tasks（全部任务）或 .../gradebook/term/<id>（某学期）等形态，只要求前缀一致。
 */
export function parseMbClassUrl(input: string): ClassUrlParse {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: false, reason: '请先粘贴 ManageBac 成绩册链接' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: '不是合法链接（需以 https:// 开头）' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: '必须是以 https:// 开头的链接' };
  const host = u.hostname.toLowerCase();
  if (!/(^|\.)managebac\.(cn|com)$/.test(host)) {
    return { ok: false, reason: `不是 ManageBac 域名（当前是 ${host}）` };
  }
  const m = /^\/teacher\/classes\/(\d+)\/gradebook(\/|$)/.exec(u.pathname);
  if (!m) {
    return { ok: false, reason: '链接里没有班级成绩册路径（应形如 /teacher/classes/<数字>/gradebook/...）' };
  }
  return { ok: true, classId: m[1], host };
}

// ---------------- 名单 xlsx ----------------

export interface RosterEntry {
  email: string;   // 统一小写
  mbName: string;  // ManageBac 成绩册里的显示名
}

export interface RosterParse {
  entries: RosterEntry[];
  skipped: number;      // 有邮箱但缺姓名、或行不完整而跳过的行数
  emailHeader: string;  // 识别到的表头（便于教师核对列认得对不对）
  nameHeader: string;
  sheets: string[];
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * 解析 ManageBac 导出的班级名单 xlsx（姓名 + 邮箱）。
 *
 * 两个已踩过的坑（2026-09-16 教师给出真实表头后修正）：
 *   ① **表头不在第一行** —— 导出文件前面有几行标题，真实表头在第 5 行左右。原先固定取第 1 行，
 *      读到的是标题行，邮箱列与姓名列都认不出来；兜底规则又取了第一列，于是把 Student ID 当成了姓名。
 *   ② **姓名是拆开的** —— 表头形如 `Student ID | First Name | Middle Name | Last Name |
 *      Preferred Name | … | E-mail Address | …`，没有单独的 Name 列；而成绩册页面上显示的是
 *      `Last, First (Preferred) | 中文名`。所以这里按同样格式拼名字，才能与页面上的行对上。
 *
 * 认不出姓名列时**宁可跳过并计数，也不猜**——猜错会让整份名单静默错位（就是上面那个坑）。
 * 多个 sheet 会合并并按邮箱去重（同一邮箱只留第一次出现的姓名）。
 */
export function parseRosterSheet(buf: ArrayBuffer): RosterParse {
  const wb = XLSX.read(buf, { type: 'array' });
  const entries: RosterEntry[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let emailHeader = '';
  let nameHeader = '';
  const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' });
    if (raw.length === 0) continue;
    const rows = raw.map((r) => (r ?? []).map(clean));

    // ① 在前 20 行里定位表头行：优先「含邮箱字样」的行；找不到再退一步用「含 @ 单元格」的行
    let hi = -1;
    let headerIsHeader = true;
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      if (rows[i].some((c) => /e-?mail|邮箱|电子邮件/i.test(c))) {
        hi = i;
        break;
      }
    }
    if (hi < 0) {
      for (let i = 0; i < Math.min(rows.length, 20); i++) {
        if (rows[i].some((c) => EMAIL_RE.test(c))) {
          hi = i;
          headerIsHeader = false;
          break;
        }
      }
    }
    if (hi < 0) continue; // 这个 sheet 里没有邮箱

    const head = rows[hi];
    const body = headerIsHeader ? rows.slice(hi + 1) : rows.slice(hi);
    const ei = headerIsHeader
      ? head.findIndex((h) => /e-?mail|邮箱|电子邮件/i.test(h))
      : head.findIndex((c) => EMAIL_RE.test(c));
    if (ei < 0) continue;

    // ② 姓名：Last + First（+ Preferred）拼成与成绩册一致的 `Last, First (Preferred)`
    const li = head.findIndex((h) => /^last\s*name$|^surname$|^family\s*name$|^姓$/i.test(h));
    const fi = head.findIndex((h) => /^first\s*name$|^given\s*name$|^名$/i.test(h));
    const pi = head.findIndex((h) => /^preferred\s*name$|^preferred$/i.test(h));
    const ni = head.findIndex((h) => /^(student\s*)?name$|姓名|学生姓名|full\s*name/i.test(h));

    if (headerIsHeader) {
      if (li >= 0 && fi >= 0) {
        nameHeader = nameHeader || [head[li], head[fi], pi >= 0 ? head[pi] : ''].filter(Boolean).join(' + ');
      } else if (ni >= 0) {
        nameHeader = nameHeader || head[ni];
      }
      if (head[ei]) emailHeader = emailHeader || head[ei];
    }

    const nameOf = (r: string[]): string => {
      if (li >= 0 && fi >= 0) {
        const last = r[li] ?? '';
        const first = r[fi] ?? '';
        const pref = pi >= 0 ? r[pi] ?? '' : '';
        if (last && first) return `${last}, ${first}${pref ? ` (${pref})` : ''}`;
      }
      if (ni >= 0) return r[ni] ?? '';
      return '';
    };

    for (const r of body) {
      const email = (r[ei] ?? '').toLowerCase();
      if (!EMAIL_RE.test(email)) continue;
      const mbName = nameOf(r);
      if (!mbName) {
        skipped++;
        continue;
      }
      if (seen.has(email)) continue;
      seen.add(email);
      entries.push({ email, mbName });
    }
  }

  return { entries, skipped, emailHeader, nameHeader, sheets: wb.SheetNames.slice() };
}
