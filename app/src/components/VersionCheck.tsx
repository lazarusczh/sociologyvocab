import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';

// 轮询间隔（毫秒）
const POLL_MS = 60_000;
// 点「稍后」累计达到此次数后，转为倒计时强制刷新（不再允许无限期推迟）
const SNOOZE_LIMIT = 2;
// 强制刷新的倒计时秒数
const FORCE_COUNTDOWN_S = 15;

// 拉取服务器当前版本号（version.json 由构建时生成，_headers 配置 no-cache）
async function fetchServerVersion(): Promise<string | null> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

// 检测到新版时显示的居中强提醒弹窗（考试中不打扰），点「立即刷新」重新加载到最新版
export default function VersionCheck() {
  const { inQuiz } = useStore();
  const inQuizRef = useRef(inQuiz);
  inQuizRef.current = inQuiz;

  const [hasUpdate, setHasUpdate] = useState(false);
  const [snoozeCount, setSnoozeCount] = useState(0);
  const [forced, setForced] = useState(false); // 已进入强制模式（不再给「稍后」）
  const [countdown, setCountdown] = useState(FORCE_COUNTDOWN_S);

  useEffect(() => {
    let cancelled = false;

    // 基准是「本份 JS 的构建版本」（__APP_VERSION__，构建时注入），而不是「加载时的服务器版本」。
    // 后者在页面拿到的是缓存旧 JS 时会被错记成最新版，导致永远不提示——这正是「学生一直用旧版」
    // 最难查的那种情形；换成前者后，无论旧 HTML 被缓存、bfcache 恢复还是离线启动都能发现。
    const check = async () => {
      const server = await fetchServerVersion();
      if (cancelled || !server) return;
      if (server !== __APP_VERSION__) setHasUpdate(true);
    };

    void check();
    const id = setInterval(check, POLL_MS);
    // 后台期间浏览器会节流/冻结定时器，切回前台（或窗口重新获得焦点）时立即补查一次；
    // 否则「刚回到页面」的那段时间仍在用旧版，等下一个轮询周期才发现。
    const onWake = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, []);

  // 强制模式倒计时：考试中暂停计时（刷新会打断答题）
  useEffect(() => {
    if (!forced) return;
    const id = setInterval(() => {
      if (inQuizRef.current) return;
      setCountdown((c) => Math.max(0, c - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [forced]);

  // 倒计时归零 → 自动刷新到最新版
  useEffect(() => {
    if (forced && countdown === 0 && !inQuiz) window.location.reload();
  }, [forced, countdown, inQuiz]);

  const snooze = () => {
    const next = snoozeCount + 1;
    setSnoozeCount(next);
    if (next >= SNOOZE_LIMIT) {
      setCountdown(FORCE_COUNTDOWN_S);
      setForced(true);
      return;
    }
    setHasUpdate(false); // 本次先收起；下一次轮询（或切回前台）会再次提醒
  };

  if (inQuiz || (!hasUpdate && !forced)) return null;

  return (
    <div className="version-overlay" role="alertdialog" aria-modal="true" aria-labelledby="version-title">
      <div className="version-modal">
        <h3 className="version-title" id="version-title">发现新版本</h3>
        {forced ? (
          <p className="version-desc">
            当前页面还在用旧版本，将于 <b>{countdown}</b> 秒后自动刷新。
            <br />考试中会暂停，不会打断答题。
          </p>
        ) : (
          <p className="version-desc">
            当前页面还在用旧版本，刷新后才会加载最新内容。
            <br />点「稍后」不会永久忽略，过一会儿还会再提醒你。
          </p>
        )}
        <div className="version-actions">
          <button className="primary" onClick={() => window.location.reload()}>立即刷新</button>
          {!forced && <button className="ghost" onClick={snooze}>稍后</button>}
        </div>
      </div>
    </div>
  );
}
