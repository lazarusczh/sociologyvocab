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

// 生成简单唯一 id
export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
