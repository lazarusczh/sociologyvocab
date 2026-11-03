/**
 * 「站内最终分变了，ManageBac 上还是旧分」的判定 —— **纯计算，不依赖网络**。
 *
 * 存在理由与 `levelRewards.ts` / `xpLevel.ts` 同级：可独立测试、可被教师端复用，
 * 不引入 supabase 副作用（连 cloud.ts 的类型都不 import，避免把 supabase 拖进来）。
 *
 * 数据来源：`mb_write_log`（登分快照，见 `db-migration-mb-write-log.sql`）
 *   + `quiz_submissions`（当前最终分）。
 *
 * ⚠ 本模块**不抓 ManageBac**。它只回答「站内分数相比上次登分时有没有变」，
 *   是给卷列表用的**零额度粗略提示**。真正的权威对比仍然是点进卷里的
 *   `previewSync`（实时抓 ManageBac 逐行比对）。两者分工：
 *     本模块说「该去看一眼了」，previewSync 说「具体哪行要写」。
 */

/** 判定所需的答卷最小形状（只取用到的字段，便于单测构造） */
export interface StaleSub {
  user_id: string;
  status: string;
  score: number;
  submitted_at: string | null;
  /** 允许 undefined —— 与 `QuizSubmission.grading` 的形状保持一致 */
  grading?: { final_score?: number | null } | null;
}

/** 判定所需的登分快照最小形状 */
export interface StaleSnapshot {
  /** { "<user_id>": "<写入的分数>" } */
  scores: Record<string, string>;
  written_at: string;
  source: 'auto' | 'manual';
}

/** 站内「当前最终分」的口径 —— 必须与写入 ManageBac 的口径一致。 */
export function finalScoreOf(s: Pick<StaleSub, 'score' | 'grading'>): number {
  return s.grading?.final_score != null ? s.grading.final_score : s.score;
}

/**
 * 把答卷列表聚合成「每个学生一行，取最近一次交卷」。
 *
 * ⚠ 必须与 `previewSync`（QuizManager.tsx）用同一套聚合，否则两处会给出不同结论。
 *   那里的做法是：只取 `status === 'submitted'`、有邮箱、排除 developer 测试账号，
 *   同一学生多次交卷取 `submitted_at` 最新的那次。
 *   本函数只负责「同一学生取最近一次」与 status 过滤，其余过滤由调用方预先做好。
 */
export function latestPerUser<T extends StaleSub>(subs: T[]): Map<string, T> {
  const byUser = new Map<string, T>();
  for (const s of subs) {
    if (s.status !== 'submitted') continue;
    const prev = byUser.get(s.user_id);
    if (!prev || (s.submitted_at ?? '') > (prev.submitted_at ?? '')) byUser.set(s.user_id, s);
  }
  return byUser;
}

export interface StaleResult {
  /** 该卷是否有学生的分数在上次登分之后变了 */
  stale: boolean;
  /** 变了的学生数（同一学生只计一次） */
  changedCount: number;
  /** 上次登分时刻；null = 该卷从未记录过登分 */
  lastWrittenAt: string | null;
  /** 上次登分是站内写入还是教师手动标记；null = 从未记录 */
  lastSource: 'auto' | 'manual' | null;
}

/**
 * 判定某份卷「是否需要重新登分」。
 *
 * @param subs     该卷的交卷记录（未过滤也行，内部按 status 过滤）
 * @param snapshot 该卷最新的登分快照；null/undefined = 从未记录
 *
 * 判定规则：
 *   只看**上次真登过的那些学生**（快照里有的 user_id）。
 *   他们的当前最终分与快照值不同 ⇒ 计为「变了」。
 *
 * ⚠ 刻意不把「快照里没有的学生」算作变了：教师可能只勾了部分行写入，
 *   没登过的行不该假装「本来登过、现在要重登」。
 * ⚠ 也刻意不把「学生后来才交卷」算作变了：那不是「分数改了」，
 *   而是「新登了一个人」，由 previewSync 的 `empty` / `noscore` 状态去覆盖。
 */
export function staleAgainstSnapshot(
  subs: StaleSub[],
  snapshot: StaleSnapshot | null | undefined,
): StaleResult {
  if (!snapshot) {
    return { stale: false, changedCount: 0, lastWrittenAt: null, lastSource: null };
  }
  const byUser = latestPerUser(subs);
  let changed = 0;
  for (const [userId, writtenScore] of Object.entries(snapshot.scores ?? {})) {
    const sub = byUser.get(userId);
    if (!sub) continue; // 该学生已不在交卷列表里（记录被删等）⇒ 不提示
    if (String(finalScoreOf(sub)) !== String(writtenScore)) changed += 1;
  }
  return {
    stale: changed > 0,
    changedCount: changed,
    lastWrittenAt: snapshot.written_at,
    lastSource: snapshot.source,
  };
}

/** 人类可读的「需重新登分」文案（卷列表徽章用）。 */
export function staleLabel(r: StaleResult): string {
  if (!r.lastWrittenAt) return '未记录登分';
  if (r.stale) return `需重新登分 ${r.changedCount} 人`;
  return '已同步';
}
