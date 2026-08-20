import {
  createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode,
} from 'react';
import type { VocabItem, Progress, ContextPassage, ImportResult, CheckInState, WrongBook } from './types';
import {
  loadVocab, saveVocab, clearVocab,
  loadProgress, saveProgress, recordAnswer, setMastery,
  loadContexts, saveContexts, isConfigured, setConfigured,
  loadCheckIn, saveCheckIn, loadWrongBook, saveWrongBook,
} from './storage';
import {
  recordFormalAnswer, addStudySeconds, applyMakeup as applyMakeupCheck,
  applyWrongAnswer, emptyCheckIn,
} from './checkin';
import { parseExcelFiles } from './excelImport';

const STUDY_TICK_SECONDS = 10;

interface StoreValue {
  vocab: VocabItem[];
  progress: Progress;
  contexts: ContextPassage[];
  categories: string[];
  checkin: CheckInState;
  wrongBook: WrongBook;
  // 词库操作
  importFiles: (files: File[]) => Promise<ImportResult>;
  appendVocab: (items: VocabItem[]) => void;
  replaceVocab: (items: VocabItem[]) => void;
  clearAll: () => void;
  // 进度操作
  recordItem: (itemId: string, correct: boolean) => void;
  setItemMastery: (itemId: string, mastery: number) => void;
  resetProgress: () => void;
  // 打卡
  beginStudy: () => void;
  endStudy: () => void;
  applyMakeup: (dayKey: string) => boolean;
  // 范文
  saveContextList: (ctxs: ContextPassage[]) => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [vocab, setVocab] = useState<VocabItem[]>([]);
  const [progress, setProgress] = useState<Progress>({});
  const [contexts, setContexts] = useState<ContextPassage[]>([]);
  const [checkin, setCheckin] = useState<CheckInState>(emptyCheckIn());
  const [wrongBook, setWrongBook] = useState<WrongBook>({});
  const activeRef = useRef(0);

  useEffect(() => {
    setProgress(loadProgress());
    setContexts(loadContexts());
    setCheckin(loadCheckIn());
    setWrongBook(loadWrongBook());

    const local = loadVocab();
    if (local.length > 0) {
      setVocab(local);
    } else if (!isConfigured()) {
      // 首次使用：加载内置词库（public/vocab-data.json）
      fetch(`${import.meta.env.BASE_URL}vocab-data.json`)
        .then((r) => r.json())
        .then((data: VocabItem[]) => {
          if (data && data.length > 0) {
            setVocab(data);
            saveVocab(data);
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
    // 追加导入（按 term 去重）
    setConfigured();
    setVocab((prev) => {
      const existing = new Set(prev.map((i) => i.term.toLowerCase()));
      const fresh = items.filter((i) => !existing.has(i.term.toLowerCase()));
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

  // 记录一次正式练习结果：同时更新掌握度、当日打卡题数、错题本
  const recordItem = useCallback((itemId: string, correct: boolean) => {
    setProgress((prev) => {
      const next = recordAnswer(itemId, correct, prev);
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

  const setItemMastery = useCallback((itemId: string, mastery: number) => {
    setProgress((prev) => {
      const next = setMastery(itemId, mastery, prev);
      saveProgress(next);
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

  const categories = [...new Set(vocab.map((i) => i.category))].sort();

  const value: StoreValue = {
    vocab,
    progress,
    contexts,
    categories,
    checkin,
    wrongBook,
    importFiles,
    appendVocab,
    replaceVocab,
    clearAll,
    recordItem,
    setItemMastery,
    resetProgress,
    beginStudy,
    endStudy,
    applyMakeup,
    saveContextList,
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