// ============================================================================
// 打卡数据审计脚本（**只读**，不修改任何数据）
// ----------------------------------------------------------------------------
// 用法：用**教师账号**登录 9699vocab.cn 后 → F12 → Console → 粘贴本文件全文 → 回车。
//
// 它会做两件事：
//   ① 在控制台打印一张「学生打卡概况」表（方便你当场看一眼）
//   ② **自动下载一个 JSON 文件**（`checkin-xp-audit-YYYY-MM-DD.json`，默认在「下载」文件夹）
//      —— 里面是每位学生的**逐日原始数据**（题数/秒数/答对数），
//         把文件的完整路径告诉我，我直接读取分析，你不用复制粘贴。
//
// 为什么必须在浏览器里跑：
//   student_data 表受 RLS 保护，只有教师登录态能读全部学生。本地脚本没有 session，
//   实测 anon key 直连返回 `[]`（被 RLS 过滤成空），拿不到任何数据。
//
// 若下载被浏览器拦截，两个兜底：
//   · 允许本站下载后重跑；或
//   · 在控制台执行 `copy(window.__checkinAudit)`，再粘贴给我（文本较大，优先用下载）。
//
// 安全说明：下面的 SUPABASE_URL 与 anon key 都是**公开值**（前端 bundle 里本来就有），
//          真正起作用的是你浏览器里的登录 token，脚本只用它在本地发只读请求。
//          ⚠ 下载的 JSON 含学生姓名/邮箱/打卡记录，属于个人信息，传输完可自行删除。
// ============================================================================
(async () => {
  const SB_URL = 'https://spb-olltk79n0rjrawe5.supabase.opentrust.net';
  const SB_ANON = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiIsInJlZiI6InNwYi1vbGx0azc5bjByanJhd2U1IiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE3ODczMDM0MTEsImV4cCI6MjEwMjg3OTQxMX0.RfvoKkHN8inwV3FXbfaH3tJm21HD5DmR899fPtQ6TlU';

  // 打卡达标线（与 checkin.ts 的 CHECKIN_DAY_GOAL_* 一致，用于区分「有记录」与「已达标」）
  const GOAL_SECONDS = 10 * 60;
  const GOAL_QUESTIONS = 20;

  // ---- 1) 取当前登录 token ----
  let token = '';
  for (const k of Object.keys(localStorage)) {
    if (!/auth-token/.test(k)) continue;
    try {
      const v = JSON.parse(localStorage.getItem(k) || '{}');
      const t = v?.access_token || v?.currentSession?.access_token || v?.session?.access_token;
      if (t) { token = t; break; }
    } catch { /* 非 JSON，跳过 */ }
  }
  if (!token) return console.error('[审计] 没找到登录 session —— 请先用教师账号登录本页，再跑一次。');
  console.log('[审计] 已找到登录 session，正在拉取 student_data …');

  // ---- 2) 拉全部学生数据（直连优先，失败回退同源 /sb 代理）----
  const query = '/rest/v1/student_data?select=user_id,email,data,updated_at&order=email&limit=1000';
  const headers = { apikey: SB_ANON, Authorization: `Bearer ${token}` };
  const candidates = [`${SB_URL}${query}`, `${location.origin}/sb${query}`];
  let rows = null;
  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers });
      if (r.ok) { rows = await r.json(); break; }
      console.warn(`[审计] 通道失败（HTTP ${r.status}）：${url}`);
    } catch (e) {
      console.warn(`[审计] 通道异常（${e.message}）：${url}`);
    }
  }
  if (!rows) return console.error('[审计] 两条通道都没成功。请确认已登录教师账号、且网络可访问。');
  console.log(`[审计] 收到 ${rows.length} 条记录`);

  // ---- 3) 组装导出数据（只做原样搬运与基础汇总，XP 估算留到本地做）----
  const now = new Date();
  const people = [];
  for (const r of rows) {
    const checkin = r.data?.checkin;
    const study = checkin?.study || {};
    const makeup = checkin?.makeup || {};
    const days = Object.keys(study).sort();
    if (days.length === 0 && Object.keys(makeup).length === 0) continue;

    const daily = days.map((d) => ({
      date: d,
      questions: study[d].questions ?? 0,
      seconds: study[d].seconds ?? 0,
      correct: study[d].correct ?? 0,
      checked: (study[d].seconds ?? 0) >= GOAL_SECONDS && (study[d].questions ?? 0) >= GOAL_QUESTIONS,
    }));
    const q = daily.reduce((a, x) => a + x.questions, 0);
    const sec = daily.reduce((a, x) => a + x.seconds, 0);
    const corr = daily.reduce((a, x) => a + x.correct, 0);
    const checkedDays = daily.filter((x) => x.checked).length;

    people.push({
      name: r.data?.name || '',
      email: r.email,
      userId: r.user_id,
      // ⚠⚠ `updatedAt` 是**死字段，不要用它判断活跃**（2026-09-23 同一坑踩了两次）：
      //   `student_data` 上**没有任何 trigger**，`updated_at` 无人维护 ——
      //   实测它停在 `2026-09-01` 不动的这三周里，学生**每天**都有练习记录
      //   （09-22 有 2 人、09-21 有 7 人、09-19 有 8 人）。
      //   ⇒ 判断活跃请用下面的 `lastDay` / `recordedDays`（都源自 `checkin.study`）。
      updatedAt: r.updated_at ?? '',
      // 汇总
      recordedDays: days.length,            // 有练习记录的天数
      checkedDays,                          // 达到打卡线的天数（10 分钟 + 20 题）
      makeupDays: Object.keys(makeup).length, // 补签天数
      bestStreak: checkin?.bestStreak ?? 0,
      firstDay: days[0] ?? '',
      lastDay: days[days.length - 1] ?? '',
      totalQuestions: q,
      totalSeconds: sec,
      totalCorrect: corr,
      avgQuestions: days.length ? Math.round(q / days.length) : 0,
      maxQuestions: daily.length ? Math.max(...daily.map((x) => x.questions)) : 0,
      avgMinutes: days.length ? Math.round(sec / days.length / 60) : 0,
      // 原始逐日
      daily,
    });
  }
  people.sort((a, b) => b.recordedDays - a.recordedDays);

  // ---- 4) 控制台概况表（当场可看）----
  console.log('\n===== 学生打卡概况（按有记录天数降序）=====');
  console.table(people.map((p) => ({
    姓名: p.name || '(未填名)',
    邮箱: p.email,
    记录天: p.recordedDays,
    达标天: p.checkedDays,
    补签: p.makeupDays,
    最长连续: p.bestStreak,
    首日: p.firstDay,
    末日: p.lastDay,
    总题数: p.totalQuestions,
    日均题: p.avgQuestions,
    单日最多: p.maxQuestions,
    日均分钟: p.avgMinutes,
  })));

  // ---- 5) 下载 JSON（我用它做 XP 触顶分析）----
  const payload = {
    generatedAt: now.toISOString(),
    source: location.origin,
    goal: { seconds: GOAL_SECONDS, questions: GOAL_QUESTIONS },
    note: '逐日原始数据（questions/seconds/correct/checked）；XP 估算在本地按 XP 表计算',
    people,
  };
  const text = JSON.stringify(payload, null, 2);
  const fname = `checkin-xp-audit-${now.toISOString().slice(0, 10)}.json`;

  if (people.length === 0) {
    console.warn('[审计] 没有拿到任何学生记录（可能都被 RLS 过滤了）。请确认当前登录的是教师账号。');
  }

  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    console.log(`\n[审计] ✅ 已触发下载：${fname}（默认在「下载」文件夹，约 ${(text.length / 1024).toFixed(1)} KB）`);
    console.log('[审计] 把该文件的完整路径发我即可（或告诉我文件名，我去下载目录找）。');
  } catch (e) {
    console.warn('[审计] 自动下载失败：', e);
  }

  window.__checkinAudit = text; // 兜底：copy(window.__checkinAudit)
  console.log(`[审计] 兜底：控制台执行 copy(window.__checkinAudit) 可复制全部数据（${(text.length / 1024).toFixed(1)} KB）`);
})();
