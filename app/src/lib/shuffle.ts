// 随机打乱数组（Fisher-Yates）
export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 从数组中随机取 n 个不同元素
export function sample<T>(arr: T[], n: number): T[] {
  return shuffle(arr).slice(0, n);
}

// 清理文本：去除多余空白、换行符规范化
export function cleanText(s: string): string {
  if (s == null) return '';
  return String(s)
    .replace(/\r\n/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 邮箱脱敏：用户名只保留首尾字母，中间用 * 隐去；域名（含 @）完整保留
export function maskEmail(email: string): string {
  if (!email) return email;
  const at = email.indexOf('@');
  if (at <= 0) return email; // 无 @ 或异常格式，原样返回
  const user = email.slice(0, at);
  const domain = email.slice(at); // 含 @
  if (user.length <= 2) return email; // 用户名过短无需脱敏
  return user[0] + '*'.repeat(user.length - 2) + user[user.length - 1] + domain;
}

// 生成简单唯一 id
export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 确定性 id：根据 类型 + 术语名 + 考卷 + 主题 生成稳定 id
// （同一词条永远同一 id，保证教师改词/重发布后学生进度仍对得上）
export function stableId(type: 'term' | 'scholar', term: string, paper: string, category: string, units?: string[]): string {
  // unit 加入 key：Paper 1 存在同名 "Cultural deprivation"（deviance 版 vs identity 版），
  // 其 term/paper/category 相同、仅 unit 不同，需靠 unit 区分
  const unitKey = units && units.length ? units.slice().sort().join(',') : '';
  const key = [type, term.trim().toLowerCase(), paper, category, unitKey].join('||');
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = (Math.imul(h1, 33) + c) >>> 0;
    h2 = (Math.imul(h2, 31) + c) >>> 0;
  }
  return `${type === 'scholar' ? 'sch' : 'term'}_${h1.toString(36)}${h2.toString(36)}`;
}
