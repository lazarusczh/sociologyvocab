import {
  createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode,
} from 'react';
import type { VocabItem, Progress, ContextPassage, ImportResult, CheckInState, WrongBook, PracticeMode, SurnameOverrides, AuthUser } from './types';
import {
  loadVocab, saveVocab, clearVocab,
  loadProgress, saveProgress, recordAnswer, resetMastery, PAPER_ORDER,
  loadContexts, saveContexts, isConfigured, setConfigured,
  loadCheckIn, saveCheckIn, loadWrongBook, saveWrongBook,
  loadSurnameOverrides, saveSurnameOverrides,
} from './storage';
import {
  recordFormalAnswer, addStudySeconds, applyMakeup as applyMakeupCheck,
  applyWrongAnswer, emptyCheckIn, todayKey, isDayChecked,
} from './checkin';
import { parseExcelFiles, migrateVocabItems } from './excelImport';
import { exportBackupJson, performImport } from './backup';
import { supabase } from './supabase';
import { pullCloudData, pushCloudData, mergeStudentData, type CloudStudentData } from './cloud';

const STUDY_TICK_SECONDS = 10;

// 记录「打卡成功」弹窗当天已展示过的日期，避免同一天重复弹出
const CELEBRATED_KEY = 'socio_vocab_celebrated';

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
  surnameOverrides: SurnameOverrides;
  // 词库操作
  importFiles: (files: File[]) => Promise<ImportResult>;
  appendVocab: (items: VocabItem[]) => void;
  replaceVocab: (items: VocabItem[]) => void;
  clearAll: () => void;
  setSurnameOverride: (term: string, surname: string) => void;
  removeSurnameOverride: (term: string) => void;
  // 进度操作
  recordItem: (itemId: string, correct: boolean, mode: PracticeMode) => void;
  resetProgress: () => void;
  // 打卡
  beginStudy: () => void;
  endStudy: () => void;
  applyMakeup: (dayKey: string) => boolean;
  checkinCelebration: boolean;
  celebrateCheckIn: () => void;
  dismissCelebration: () => void;
  // 范文
  saveContextList: (ctxs: ContextPassage[]) => void;
  // 离线备份
  skipped: boolean; // 本次会话是否跳过了登录（不持久化，刷新后重新弹登录）
  skipIdentity: () => void;
  exportBackup: () => Promise<string | null>;
  importBackup: (text: string) => Promise<string>;
  // 云端登录与同步
  authUser: AuthUser | null;
  isTeacher: boolean;
  signIn: (email: string, password: string) => Promise<string>;
  signUp: (email: string, password: string, name: string) => Promise<string>;
  signOut: () => Promise<void>;
  changePassword: (newPassword: string) => Promise<string>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [vocab, setVocab] = useState<VocabItem[]>([]);
  const [progress, setProgress] = useState<Progress>({});
  const [contexts, setContexts] = useState<ContextPassage[]>([]);
  const [checkin, setCheckin] = useState<CheckInState>(emptyCheckIn());
  const [wrongBook, setWrongBook] = useState<WrongBook>({});
  const [skipped, setSkipped] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [isTeacher, setIsTeacher] = useState(false);
  const [surnameOverrides, setSurnameOverrides] = useState<SurnameOverrides>({});
  const [checkinCelebration, setCheckinCelebration] = useState(false);
  const activeRef = useRef(0);

  // 登录 / 恢复会话后：拉取云端数据合并到本地，再把合并结果回传云端
  const establishAuth = useCallback(async (u: AuthUser) => {
    const local: CloudStudentData = {
      name: u.name,
      checkin: loadCheckIn(),
      progress: loadProgress(),
      wrongBook: loadWrongBook(),
    };
    let merged = local;
    try {
      const cloud = await pullCloudData(u.id);
      if (cloud) merged = mergeStudentData(local, cloud);
    } catch {
      // 云端不可达时保留本地数据，仍允许登录
    }
    saveCheckIn(merged.checkin);
    saveProgress(merged.progress);
    saveWrongBook(merged.wrongBook);
    setCheckin(merged.checkin);
    setProgress(merged.progress);
    setWrongBook(merged.wrongBook);
    setAuthUser(u);
    // 判断当前用户是否在老师名单里（用于显示教师后台 / 打卡核验）
    (async () => {
      try {
        const { data } = await supabase
          .from('teacher_roles')
          .select('user_id')
          .eq('user_id', u.id)
          .maybeSingle();
        setIsTeacher(!!data);
      } catch {
        setIsTeacher(false);
      }
    })();
    // 回传合并结果，保证云端与本地一致
    pushCloudData(u.id, u.email, merged).catch(() => {});
  }, []);

  useEffect(() => {
    setProgress(migrateProgressOnce());
    setContexts(loadContexts());
    setCheckin(loadCheckIn());
    setWrongBook(loadWrongBook());
    setSurnameOverrides(loadSurnameOverrides());

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

  // 恢复已有登录会话（刷新/重开 App 后自动登录并同步）
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const session = data.session;
      if (session?.user) {
        const u: AuthUser = {
          id: session.user.id,
          email: session.user.email ?? '',
          name: (session.user.user_metadata?.name as string) ?? '',
        };
        establishAuth(u);
      }
    });
  }, [establishAuth]);

  // 登录后：本地打卡/进度/错题本变化时，防抖上传云端
  useEffect(() => {
    if (!authUser) return;
    const timer = setTimeout(() => {
      pushCloudData(authUser.id, authUser.email, {
        name: authUser.name,
        checkin,
        progress,
        wrongBook,
      }).catch(() => {});
    }, 800);
    return () => clearTimeout(timer);
  }, [authUser, checkin, progress, wrongBook]);

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

  const setSurnameOverride = useCallback((term: string, surname: string) => {
    setSurnameOverrides((prev) => {
      const next = surname.trim()
        ? { ...prev, [term]: surname.trim() }
        : (() => { const { [term]: _drop, ...rest } = prev; return rest; })();
      saveSurnameOverrides(next);
      return next;
    });
  }, []);

  const removeSurnameOverride = useCallback((term: string) => {
    setSurnameOverrides((prev) => {
      const { [term]: _drop, ...rest } = prev;
      saveSurnameOverrides(rest);
      return rest;
    });
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

  // 完成一组正式练习后调用：若当天已达标且尚未弹过，则触发「打卡成功」弹窗
  const celebrateCheckIn = useCallback(() => {
    const today = todayKey();
    if (!isDayChecked(checkin, today)) return;
    if (localStorage.getItem(CELEBRATED_KEY) === today) return;
    localStorage.setItem(CELEBRATED_KEY, today);
    setCheckinCelebration(true);
  }, [checkin]);

  const dismissCelebration = useCallback(() => setCheckinCelebration(false), []);

  const saveContextList = useCallback((ctxs: ContextPassage[]) => {
    saveContexts(ctxs);
    setContexts(ctxs);
  }, []);

  const skipIdentity = useCallback(() => {
    setSkipped(true);
  }, []);

  // 邮箱 + 密码登录；成功返回空串，失败返回错误信息
  const signIn = useCallback(async (email: string, password: string): Promise<string> => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return error.message;
    const user = data.user;
    if (!user) return '登录失败，请重试。';
    const u: AuthUser = {
      id: user.id,
      email: user.email ?? email,
      name: (user.user_metadata?.name as string) ?? '',
    };
    await establishAuth(u);
    return '';
  }, [establishAuth]);

  // 邮箱 + 密码注册（name 存进 user_metadata），成功后即登录
  const signUp = useCallback(async (email: string, password: string, name: string): Promise<string> => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name } },
    });
    if (error) return error.message;
    const user = data.user;
    if (!user) return '注册失败，请重试。';
    const u: AuthUser = { id: user.id, email: user.email ?? email, name: name.trim() };
    await establishAuth(u);
    return '';
  }, [establishAuth]);

  // 登出：清除云端会话，回到登录界面（本地数据保留）
  const signOut = useCallback(async (): Promise<void> => {
    await supabase.auth.signOut();
    setAuthUser(null);
    setIsTeacher(false);
  }, []);

  const exportBackup = useCallback(async (): Promise<string | null> => {
    return exportBackupJson(checkin, progress, wrongBook);
  }, [checkin, progress, wrongBook]);

  const importBackup = useCallback(async (text: string): Promise<string> => {
    const res = await performImport(text);
    if (res.ok) {
      setCheckin(loadCheckIn());
      setProgress(loadProgress());
      setWrongBook(loadWrongBook());
    }
    return res.message;
  }, []);

  // 已登录用户修改自己的密码（用临时密码登录后自设新密码）
  const changePassword = useCallback(async (newPassword: string): Promise<string> => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    return error ? error.message : '';
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
    surnameOverrides,
    importFiles,
    appendVocab,
    replaceVocab,
    clearAll,
    setSurnameOverride,
    removeSurnameOverride,
    recordItem,
    resetProgress,
    beginStudy,
    endStudy,
    applyMakeup,
    checkinCelebration,
    celebrateCheckIn,
    dismissCelebration,
    saveContextList,
    skipped,
    skipIdentity,
    exportBackup,
    importBackup,
    authUser,
    isTeacher,
    signIn,
    signUp,
    signOut,
    changePassword,
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

// 练习组件在「完成一组」时调用：finished 由 false→true 的边沿触发一次打卡庆祝检查
export function useCelebrateCheckIn(finished: boolean): void {
  const { celebrateCheckIn } = useStore();
  const prev = useRef(false);
  useEffect(() => {
    if (finished && !prev.current) celebrateCheckIn();
    prev.current = finished;
  }, [finished, celebrateCheckIn]);
}