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

export interface SkillData {
  generated: string;
  chapters: Chapter[];
  glossary: GlossaryEntry[];
  patterns: Section[];
  cheatsheet: Section[];
}
