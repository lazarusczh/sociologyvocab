// 与 app/scripts/skill-md-json.mjs 输出结构一致的类型定义

export interface Section {
  heading: string;
  lines: string[];
}

export interface Chapter {
  id: string;      // 如 'ch01-introduction'（文件去 .md）
  file: string;
  title: string;
  tagline: string;
  sections: Section[];
}

export interface GlossaryEntry {
  term: string;
  zh: string;
  def: string;
  chapters: string[];
}

// 一本教材/教辅 = 一个 book-to-skill 产物。纯文本与词汇表按本分开存放（重复无所谓），
// AI 问答则跨全部 books 检索（集大成）。
export interface Book {
  slug: string;
  label: string;
  kind: string;
  /** 仅进 AI 问答检索、不在侧栏/目录公开浏览（如真题评分视角语料） */
  aiOnly?: boolean;
  chapters: Chapter[];
  glossary: GlossaryEntry[];
  patterns: Section[];
  cheatsheet: Section[];
}

export interface SkillData {
  generated: string;
  books?: Book[];
  // 兼容旧版扁平结构（线上 v1 数据）
  chapters?: Chapter[];
  glossary?: GlossaryEntry[];
  patterns?: Section[];
  cheatsheet?: Section[];
}

// 统一取「本」列表：新结构是 books；旧结构（无 books）包成单本
export function booksOf(skill: SkillData): Book[] {
  if (skill.books && skill.books.length) return skill.books;
  return [
    {
      slug: 'textbook',
      label: '教材',
      kind: '教材',
      chapters: skill.chapters ?? [],
      glossary: skill.glossary ?? [],
      patterns: skill.patterns ?? [],
      cheatsheet: skill.cheatsheet ?? [],
    },
  ];
}
