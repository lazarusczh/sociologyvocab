import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';

// 本地记录的上次加载版本（localStorage），用于检测服务器是否有新版本
const KNOWN_VERSION_KEY = 'socio_vocab_known_version';
// 轮询间隔（毫秒）
const POLL_MS = 60_000;

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

// 检测到新版时显示的横幅（非考试中），点击「刷新」重新加载到最新版
export default function VersionCheck() {
  const { inQuiz } = useStore();
  const [hasUpdate, setHasUpdate] = useState(false);
  const knownRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // 页面加载时：能加载出页面说明 JS 就是当前版本，直接记录服务器版本为「已知版本」。
    // 这样刷新后不会误提示；只有「页面打开期间又发布了新版」才由轮询触发提示。
    const init = async () => {
      const server = await fetchServerVersion();
      if (cancelled || !server) return;
      localStorage.setItem(KNOWN_VERSION_KEY, server);
      knownRef.current = server;
    };

    // 定时轮询：服务器版本变化（页面打开期间又发新版）→ 提示刷新
    const poll = async () => {
      const server = await fetchServerVersion();
      if (cancelled || !server) return;
      if (knownRef.current && server !== knownRef.current) {
        setHasUpdate(true);
      }
    };

    init();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!hasUpdate || inQuiz) return null;

  return (
    <div className="version-banner" role="status">
      <span>发现新版本，刷新后获取最新内容</span>
      <div className="banner-actions">
        <button className="primary" onClick={() => window.location.reload()}>刷新</button>
        <button className="ghost" onClick={() => setHasUpdate(false)}>稍后</button>
      </div>
    </div>
  );
}
