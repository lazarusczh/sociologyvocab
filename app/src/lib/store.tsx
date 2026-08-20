import {
  createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode,
} from 'react';
import type { VocabItem, Progress, ContextPassage, ImportResult, CheckInState, WrongBook, StudentIdentity, PracticeMode } from './types';
import {
  loadVocab, saveVocab, clearVocab,
  loadProgress, saveProgress, recordAnswer, resetMastery, PAPER_ORDER,
  loadContexts, saveContexts, isConfigured, setConfigured,
  loadCheckIn, saveCheckIn, loadWrongBook, saveWrongBook,
} from './storage';
import {
  recordFormalAnswer, addStudySeconds, applyMakeup as applyMakeupCheck,
  applyWrongAnswer, emptyCheckIn,
} from './checkin';
import { parseExcelFiles, migrateVocabItems } from './excelImport';
import { loadIdentity, saveIdentity, exportBackupJson, performImport } from './backup';

const STUDY_TICK_SECONDS = 10;

const MASTERY_V2_KEY = 'socio_vocab_mastery_v2';

// 掌握度模型 v2 上线后做一次性迁移：把旧版离散档位掌握度重置为 0
function migrateProgressOnce(): Progress {
  if (localStorage.getItem(MASTERY_V2_KEY)) return loadProgress();
  const reset = resetMastery(loadProgress());
  saveProgress(reset);
  localStorage.setItem(MASTERY_V2_KEY, '1');
  return reset;
}

interface StoreValue {
  vocab: VocabItem[];
  progress: Progress;
  contexts: ContextPassage[];
  categories: string[];
  papers: string[];
  checkin: CheckInState;
  wrongBook: WrongBook;
  // 词库操作
  importFiles: (files: File[]) => Promise<ImportResult>;
  appendVocab: (items: VocabItem[]) => void;
  replaceVocab: (items: VocabItem[]) => void;
  clearAll: () => void;
  // 进度操作
  recordItem: (itemId: string, correct: boolean, mode: PracticeMode) => void;
  resetProgress: () => void;
  // 打卡
  beginStudy: () => void;
  endStudy: () => void;
  applyMakeup: (dayKey: string) => boolean;
  // 范文
  saveContextList: (ctxs: ContextPassage[]) => void;
  // 身份与备份
  identity: StudentIdentity | null;
  skipped: boolean; // 本次会话是否跳过了身份绑定（不持久化，刷新后重新弹绑定）
  setIdentity: (studentId: string, name: string) => void;
  skipIdentity: () => void;
  exportBackup: () => Promise<string | null>;
  importBackup: (text: string, resetCode?: string) => Promise<string>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [vocab, setVocab] = useState<VocabItem[]>([]);
  const [progress, setProgress] = useState<Progress>({});
  const [contexts, setContexts] = useState<ContextPassage[]>([]);
  const [checkin, setCheckin] = useState<CheckInState>(emptyCheckIn());
  const [wrongBook, setWrongBook] = useState<WrongBook>({});
  const [identity, setIdentityState] = useState<StudentIdentity | null>(null);
  const [skipped, setSkipped] = useState(false);
  const activeRef = useRef(0);

  useEffect(() => {
    setProgress(migrateProgressOnce());
    setContexts(loadContexts());
    setCheckin(loadCheckIn());
    setWrongBook(loadWrongBook());
    setIdentityState(loadIdentity());

    const local = migrateVocabItems(loadVocab());
    if (local.length > 0) {
      setVocab(local);
      saveVocab(local); // 旧词库可能缺少 paper 字段，迁移后回写
    } else if (!isConfigured()) {
      // 首次使用：加载内置词库（public/vocab-data.json）
      fetch(`${import.meta.env.BASE_URL}vocab-data.json`)
        .then((r) => r.json())
        .then((data: VocabItem[]) => {
          if (data && data.length > 0) {
            const migrated = migrateVocabItems(data);
            setVocab(migrated);
            saveVocab(migrated);
            setConfigured();
          }
        })
        .catch(() => {
          // 内置词库加载失败时保持空，用户可手动导入
        });
    }
  }, []);

  // 学习计时：每 10 秒累计一次，仅在处于正式练习（选择题/拼写/匹配/错题）时计数
  useEffect(() => {
    const id = setInterval(() => {
      if (activeRef.current > 0) {
        setCheckin((prev) => {
          const next = addStudySeconds(prev, STUDY_TICK_SECONDS);
          saveCheckIn(next);
          return next;
        });
      }
    }, STUDY_TICK_SECONDS * 1000);
    return () => clearInterval(id);
  }, []);

  const persistVocab = useCallback((items: VocabItem[]) => {
    saveVocab(items);
    setVocab(items);
  }, []);

  const importFiles = useCallback(async (files: File[]): Promise<ImportResult> => {
    const result = await parseExcelFiles(files);
    return result;
  }, []);

  const appendVocab = useCallback((items: VocabItem[]) => {
    // 追加导入（按「类型 + 术语名 + 考卷 + 主题」去重，
    // 同名学者在不同单元有不同学术贡献时属于不同条目，不应合并）
    setConfigured();
    setVocab((prev) => {
      const key = (i: VocabItem) =>
        [i.type, i.term.trim().toLowerCase(), i.paper, i.category].join('||');
      const existing = new Set(prev.map(key));
      const fresh = items.filter((i) => !existing.has(key(i)));
      const next = [...prev, ...fresh];
      saveVocab(next);
      return next;
    });
  }, []);

  const replaceVocab = useCallback((items: VocabItem[]) => {
    setConfigured();
    persistVocab(items);
  }, [persistVocab]);

  const clearAll = useCallback(() => {
    setConfigured();
    clearVocab();
    setVocab([]);
  }, []);

  // 记录一次正式练习结果：同时更新掌握度（按模式权重）、当日打卡题数、错题本
  const recordItem = useCallback((itemId: string, correct: boolean, mode: PracticeMode) => {
    setProgress((prev) => {
      const next = recordAnswer(itemId, correct, mode, prev);
      saveProgress(next);
      return next;
    });
    setCheckin((prev) => {
      const next = recordFormalAnswer(prev, correct);
      saveCheckIn(next);
      return next;
    });
    setWrongBook((prev) => {
      const next = applyWrongAnswer(prev, itemId, correct);
      saveWrongBook(next);
      return next;
    });
  }, []);

  const resetProgress = useCallback(() => {
    setProgress({});
    saveProgress({});
  }, []);

  const beginStudy = useCallback(() => {
    activeRef.current += 1;
  }, []);

  const endStudy = useCallback(() => {
    activeRef.current = Math.max(0, activeRef.current - 1);
  }, []);

  const applyMakeup = useCallback((dayKey: string): boolean => {
    const next = applyMakeupCheck(checkin, dayKey);
    if (next === checkin) return false;
    setCheckin(next);
    saveCheckIn(next);
    return true;
  }, [checkin]);

  const saveContextList = useCallback((ctxs: ContextPassage[]) => {
    saveContexts(ctxs);
    setContexts(ctxs);
  }, []);

  const setIdentity = useCallback((studentId: string, name: string) => {
    const ident: StudentIdentity = {
      studentId: studentId.trim(),
      name: name.trim(),
      lockedAt: Date.now(),
    };
    saveIdentity(ident);
    setIdentityState(ident);
  }, []);

  const skipIdentity = useCallback(() => {
    setSkipped(true);
  }, []);

  const exportBackup = useCallback(async (): Promise<string | null> => {
    if (!identity) return null;
    return exportBackupJson(identity, checkin, progress, wrongBook);
  }, [identity, checkin, progress, wrongBook]);

  const importBackup = useCallback(async (text: string, resetCode?: string): Promise<string> => {
    const res = await performImport(text, resetCode || null);
    if (res.ok) {
      setCheckin(loadCheckIn());
      setProgress(loadProgress());
      setWrongBook(loadWrongBook());
      setIdentityState(loadIdentity());
    }
    return res.message;
  }, []);

  const categories = [...new Set(vocab.map((i) => i.category).filter(Boolean))].sort();
  const papers = PAPER_ORDER.filter((p) => vocab.some((v) => v.paper === p));

  const value: StoreValue = {
    vocab,
    progress,
    contexts,
    categories,
    papers,
    checkin,
    wrongBook,
    importFiles,
    appendVocab,
    replaceVocab,
    clearAll,
    recordItem,
    resetProgress,
    beginStudy,
    endStudy,
    applyMakeup,
    saveContextList,
    identity,
    skipped,
    setIdentity,
    skipIdentity,
    exportBackup,
    importBackup,
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用');
  return ctx;
}

// 用于正式练习组件的学习计时：挂载开始计时，卸载停止
export function useStudySession(): void {
  const { beginStudy, endStudy } = useStore();
  useEffect(() => {
    beginStudy();
    return () => endStudy();
  }, [beginStudy, endStudy]);
}