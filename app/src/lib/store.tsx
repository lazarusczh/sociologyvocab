import {
  createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode,
} from 'react';
import type { VocabItem, Progress, ContextPassage, ImportResult, CheckInState, WrongBook, PracticeMode, SurnameOverrides, AuthUser } from './types';
import {
  loadVocab, saveVocab, clearVocab,
  loadProgress, saveProgress, recordAnswer, resetMastery, PAPER_ORDER,
  loadContexts, saveContexts, isConfigured, setConfigured,
  loadCheckIn, saveCheckIn, loadWrongBook, saveWrongBook,
  loadSurnameOverrides, saveSurnameOverrides, setDataScope,
  migrateVocabStableIds, migrateAllProgressKeys,
  loadVocabVersion, saveVocabVersion,
} from './storage';
import {
  recordFormalAnswer, addStudySeconds, applyMakeup as applyMakeupCheck,
  applyWrongAnswer, emptyCheckIn, todayKey, isDayChecked,
} from './checkin';
import { parseExcelFiles, migrateVocabItems } from './excelImport';
import { loadUnitOrder, saveUnitOrder } from './unitMapping';
import { exportBackupJson, performImport } from './backup';
import { supabase } from './supabase';
import { pullCloudData, pushCloudData, mergeStudentData, type CloudStudentData, getLatestVocabVersion, pullLatestVocab } from './cloud';

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
  // 单元分类
  unitOrder: Record<string, string[]>;
  addUnit: (paper: string, sub: string, name: string) => void;
  removeUnit: (paper: string, sub: string, name: string) => void;
  moveUnit: (paper: string, sub: string, name: string, dir: -1 | 1) => void;
  renameUnit: (paper: string, sub: string, oldName: string, newName: string) => void;
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
  isDeveloper: boolean;
  vocabUpdateBanner: string;
  syncVocabFromCloud: () => void;
  dismissVocabBanner: () => void;
  signIn: (email: string, password: string) => Promise<string>;
  signUp: (email: string, password: string, name: string) => Promise<string>;
  signOut: () => Promise<void>;
  changePassword: (newPassword: string) => Promise<string>;
  // 随堂测验/作业：考试进行中标志（用于锁导航）
  inQuiz: boolean;
  setInQuiz: (v: boolean) => void;
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
  const [isDeveloper, setIsDeveloper] = useState(false);
  const [vocabUpdateBanner, setVocabUpdateBanner] = useState('');
  const [surnameOverrides, setSurnameOverrides] = useState<SurnameOverrides>({});
  const [checkinCelebration, setCheckinCelebration] = useState(false);
  const [inQuiz, setInQuiz] = useState(false);
  const [unitOrder, setUnitOrder] = useState<Record<string, string[]>>(() => loadUnitOrder());
  const activeRef = useRef(0);

  // 登录 / 恢复会话后：拉取云端数据合并到本地，再把合并结果回传云端
  const establishAuth = useCallback(async (u: AuthUser) => {
    // 切换到该用户的独立数据命名空间，避免读到其他账号留在本机的学习数据
    setDataScope(`user:${u.id}`);
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
    // 判断当前用户角色（用于显示教师后台 / 打卡核验）
    (async () => {
      try {
        const { data } = await supabase
          .from('user_roles')
          .select('role')
          .eq('user_id', u.id);
        const roles = ((data ?? []) as { role: string }[]).map((r) => r.role);
        setIsTeacher(roles.includes('teacher'));
        setIsDeveloper(roles.includes('developer'));
      } catch {
        setIsTeacher(false);
        setIsDeveloper(false);
      }
    })();
    // 回传合并结果，保证云端与本地一致
    pushCloudData(u.id, u.email, merged).catch(() => {});
  }, []);

  useEffect(() => {
    setContexts(loadContexts());
    setCheckin(loadCheckIn());
    setSurnameOverrides(loadSurnameOverrides());

    // 稳定 id 迁移：先把本地词库换成稳定 id，并迁移进度/错题本的旧 id key
    const local = migrateVocabItems(loadVocab());
    const { vocab: stableVocab, idMap } = migrateVocabStableIds(local);
    if (Object.keys(idMap).length > 0) {
      saveVocab(stableVocab);
      migrateAllProgressKeys(idMap);
    }
    setProgress(migrateProgressOnce());
    setWrongBook(loadWrongBook());

    if (stableVocab.length > 0) {
      setVocab(stableVocab);
      saveVocab(stableVocab); // 旧词库可能缺少 paper 字段，迁移后回写
    } else if (!isConfigured()) {
      // 首次使用：加载内置词库（public/vocab-data.json）
      fetch(`${import.meta.env.BASE_URL}vocab-data.json`)
        .then((r) => r.json())
        .then((data: VocabItem[]) => {
          if (data && data.length > 0) {
            const migrated = migrateVocabStableIds(migrateVocabItems(data)).vocab;
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

  // 从云端同步词库：启动/回首页时调用（登录用户和离线游客都同步），检查最新版本并静默拉取
  const syncVocabFromCloud = useCallback(async () => {
    try {
      const latestVersion = await getLatestVocabVersion();
      if (latestVersion > loadVocabVersion()) {
        const pulled = await pullLatestVocab();
        if (pulled) {
          if (pulled.data.length > 0) {
            const migrated = migrateVocabStableIds(migrateVocabItems(pulled.data)).vocab;
            persistVocab(migrated);
            setVocabUpdateBanner(`词库已更新到 v${pulled.version}（${migrated.length} 条）`);
          }
          // 同步单元分类列表
          if (pulled.unitOrder) {
            setUnitOrder((prev) => {
              const next = { ...prev, ...pulled.unitOrder };
              saveUnitOrder(next);
              return next;
            });
          }
          saveVocabVersion(pulled.version);
        }
      }
    } catch {
      // 离线/失败：用本地缓存，不提示
    }
  }, [persistVocab]);

  const dismissVocabBanner = useCallback(() => {
    setVocabUpdateBanner('');
  }, []);

  // 登录后同步词库（启动/登录时 + authUser 变化时）
  useEffect(() => {
    if (authUser) syncVocabFromCloud();
  }, [authUser, syncVocabFromCloud]);

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

  // 单元分类管理（增删排序；变更存本地，随「发布词库」同步云端）
  const addUnit = useCallback((paper: string, sub: string, name: string) => {
    const key = `${paper}|${sub}`;
    setUnitOrder((prev) => {
      const list = prev[key] ?? [];
      if (list.includes(name)) return prev;
      const next = { ...prev, [key]: [...list, name] };
      saveUnitOrder(next);
      return next;
    });
  }, []);

  const removeUnit = useCallback((paper: string, sub: string, name: string) => {
    const key = `${paper}|${sub}`;
    setUnitOrder((prev) => {
      const next = { ...prev, [key]: (prev[key] ?? []).filter((u) => u !== name) };
      saveUnitOrder(next);
      return next;
    });
    // 删除单元时，同步从所有词条上移除该单元
    setVocab((prev) => {
      const next = prev.map((i) => (i.unit?.includes(name) ? { ...i, unit: i.unit.filter((u) => u !== name) } : i));
      saveVocab(next);
      return next;
    });
  }, []);

  const moveUnit = useCallback((paper: string, sub: string, name: string, dir: -1 | 1) => {
    const key = `${paper}|${sub}`;
    setUnitOrder((prev) => {
      const list = [...(prev[key] ?? [])];
      const idx = list.indexOf(name);
      if (idx < 0) return prev;
      const target = idx + dir;
      if (target < 0 || target >= list.length) return prev;
      [list[idx], list[target]] = [list[target], list[idx]];
      const next = { ...prev, [key]: list };
      saveUnitOrder(next);
      return next;
    });
  }, []);

  // 重命名单元：更新单元列表中的名字，并同步更新所有词条的 unit 引用
  const renameUnit = useCallback((paper: string, sub: string, oldName: string, newName: string) => {
    const key = `${paper}|${sub}`;
    setUnitOrder((prev) => {
      const list = (prev[key] ?? []).map((u) => (u === oldName ? newName : u));
      const next = { ...prev, [key]: list };
      saveUnitOrder(next);
      return next;
    });
    setVocab((prev) => {
      const next = prev.map((i) =>
        i.unit?.includes(oldName) ? { ...i, unit: i.unit.map((u) => (u === oldName ? newName : u)) } : i,
      );
      saveVocab(next);
      return next;
    });
  }, []);

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

  // 完成一组正式练习后调用：若当天已达标且该账号尚未弹过，则触发「打卡成功」弹窗
  const celebrateCheckIn = useCallback(() => {
    const today = todayKey();
    if (!isDayChecked(checkin, today)) return;
    // 按账号区分「当天已弹」标记：登录用户各自独立，离线游客共用 guest 标记
    const key = authUser ? `${CELEBRATED_KEY}:user:${authUser.id}` : CELEBRATED_KEY;
    if (localStorage.getItem(key) === today) return;
    localStorage.setItem(key, today);
    setCheckinCelebration(true);
  }, [checkin, authUser]);

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

  // 登出：清除云端会话，回到登录界面（本地数据保留、按用户隔离，不互相污染）
  const signOut = useCallback(async (): Promise<void> => {
    await supabase.auth.signOut();
    setAuthUser(null);
    setIsTeacher(false);
    setIsDeveloper(false);
    setDataScope('guest');
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
    unitOrder,
    addUnit,
    removeUnit,
    moveUnit,
    renameUnit,
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
    isDeveloper,
    vocabUpdateBanner,
    syncVocabFromCloud,
    dismissVocabBanner,
    signIn,
    signUp,
    signOut,
    changePassword,
    inQuiz,
    setInQuiz,
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