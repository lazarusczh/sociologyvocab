import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import type { VocabItem, Progress, ContextPassage, ImportResult } from './types';
import {
  loadVocab, saveVocab, clearVocab,
  loadProgress, saveProgress, recordAnswer, setMastery,
  loadContexts, saveContexts, isConfigured, setConfigured,
} from './storage';
import { parseExcelFiles } from './excelImport';

interface StoreValue {
  vocab: VocabItem[];
  progress: Progress;
  contexts: ContextPassage[];
  categories: string[];
  // 词库操作
  importFiles: (files: File[]) => Promise<ImportResult>;
  appendVocab: (items: VocabItem[]) => void;
  replaceVocab: (items: VocabItem[]) => void;
  clearAll: () => void;
  // 进度操作
  recordItem: (itemId: string, correct: boolean) => void;
  setItemMastery: (itemId: string, mastery: number) => void;
  resetProgress: () => void;
  // 范文
  saveContextList: (ctxs: ContextPassage[]) => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [vocab, setVocab] = useState<VocabItem[]>([]);
  const [progress, setProgress] = useState<Progress>({});
  const [contexts, setContexts] = useState<ContextPassage[]>([]);

  useEffect(() => {
    setProgress(loadProgress());
    setContexts(loadContexts());

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

  const recordItem = useCallback((itemId: string, correct: boolean) => {
    setProgress((prev) => {
      const next = recordAnswer(itemId, correct, prev);
      saveProgress(next);
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
    importFiles,
    appendVocab,
    replaceVocab,
    clearAll,
    recordItem,
    setItemMastery,
    resetProgress,
    saveContextList,
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用');
  return ctx;
}
