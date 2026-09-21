// OCR 辅助阅卷（教师后台入口）
//
// 流程：相机拍题 / 选图（可批量、可拖拽）→ 视觉模型转写（/app-api/ai/transcribe）→
//       词库容错匹配 → **原文内就地高亮**（核心术语/学者突出，通用词淡化）+ 原图并排对照。
//
// 设计取向（教师明确要求）：主产物是**保留完整上下文的原文**，不是命中清单 ——
// 只看清单只能判断"用没用术语"（AO1），看不出"用得对不对"（AO2）。
//
// 隐私：图片只在本机内存与本次请求里流转（不落云端存储）；转写文本由教师自行保存。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { apiUrl } from '../lib/apiBase';
import { useStore } from '../lib/store';
import { buildFormTable, matchTranscript, summarize, type OcrHit } from '../lib/ocrHighlight';
import {
  deleteOcrRecord,
  getOcrRecordText,
  listOcrRecordMetas,
  saveOcrRecord,
  updateOcrRecord,
  updateOcrRecordLabel,
  type OcrRecordMeta,
} from '../lib/ocrStore';
import './ocrMark.css';

const MAX_EDGE = 1800; // 长边上限：模型成本 ∝ 像素，1800 足够读手写
const JPEG_QUALITY = 0.85;

// file input 的 capture 属性**只有移动端浏览器/WebView 认**；Windows/macOS 桌面浏览器按规范忽略它，
// 只会弹出文件选择框（用户会觉得"这按钮名不副实"）。故按平台分流：
//   移动端 → 交给系统相机；桌面 → 打开应用内相机（getUserMedia）
const MOBILE_CAM_UA =
  typeof navigator !== 'undefined' && /(Android|iPhone|iPad|iPod)/i.test(navigator.userAgent);

interface Page {
  id: string;
  name: string;
  src: string; // data URL（本机内存，不落盘）；从历史记录载回的页面为空串，不显示原图
  text?: string;
  model?: string;
  ms?: number;
  busy?: boolean;
  error?: string;
  label?: string; // 备注（如学生姓名），随记录入库
  recordId?: string; // 已入库记录 id：重识别时覆盖，避免同页堆出多条
  saveState?: 'saving' | 'ok' | 'fail'; // 入库状态，仅用于界面提示
  // 词库匹配结果**随文本算一次就存这里**（2026-09-15 提速）：
  // 之前是在渲染函数里现算，于是「改一个字的备注」「鼠标划过标记」「识别完一页」……
  // 任何一次重渲染都要把所有页的全文重新跑一遍容错匹配 → 明显卡顿。
  hits?: OcrHit[];
}

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('读取图片失败'));
    fr.readAsDataURL(file);
  });

/** 等比缩到长边 MAX_EDGE 并转 JPEG（同时降 token 成本与请求体大小）
 *
 * ★ 2026-09-15 修正：解码失败时**返回 null**（原来是 resolve(dataUrl) 静默回退成原图）。
 * 回退成原图的问题是：像 iPhone 默认的 HEIC 这类浏览器**根本画不出来**的格式，
 * 会一路安静地带到 <img> 里 → 界面上只是一块空白，看不出任何原因 ✗。
 * 现在改为明确失败，由调用方给出人话提示（见 addFiles）。
 */
const downscale = (dataUrl: string): Promise<string | null> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);
        ctx.fillStyle = '#fff'; // 透明底转白，避免 PNG→JPEG 变黑
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
      } catch {
        // 超大图偶发：canvas 分配失败 / toDataURL 抛错
        resolve(null);
      }
    };
    img.onerror = () => resolve(null); // 浏览器解不了的格式（HEIC/HEIF 等）
    img.src = dataUrl;
  });

export default function OcrMarkPanel() {
  const { vocab } = useStore();
  const [pages, setPages] = useState<Page[]>([]);
  const [busyAll, setBusyAll] = useState(false);
  const [err, setErr] = useState('');
  const [showGeneral, setShowGeneral] = useState(true); // 一般词（高频通用词）默认显示但淡化
  // 原图改为「点按钮覆盖查看」（2026-09-15 教师决定）：不再与文本并排，文本独占整宽
  // （教师后台加了侧栏，并排会挤；且拍照录入时纸质原件在手，需要核对笔迹再点开即可）。
  const [zoom, setZoom] = useState<{ src: string; name: string } | null>(null);
  const [zoomActual, setZoomActual] = useState(false); // false = 适应宽度，true = 原尺寸
  // 覆盖层的自检信息（2026-09-15）：图若显示不出来，条栏上直接写出尺寸/数据量/失败原因，
  // 而不是留一块空白让人猜（教师反馈"图片显示不出"时，这一行就能定位是数据还是显示的问题）。
  const [zoomDims, setZoomDims] = useState<{ w: number; h: number } | null>(null);
  const [zoomErr, setZoomErr] = useState('');
  // 视觉通道自检结果（2026-09-17）：用服务端内置的小图逐个通道试，一眼看出挂在哪一档
  const [probe, setProbe] = useState<{ channel: string; ok: boolean; ms: number; note: string }[] | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);

  const openZoom = useCallback((src: string, name: string) => {
    setZoomActual(false);
    setZoomDims(null);
    setZoomErr('');
    setZoom({ src, name });
  }, []);

  // 覆盖层：按 ESC 关闭（点遮罩、点「关闭」按钮同样可关）
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);
  const [recs, setRecs] = useState<OcrRecordMeta[]>([]);
  const [recsBusy, setRecsBusy] = useState(false);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [camOn, setCamOn] = useState(false);
  const [camList, setCamList] = useState<MediaDeviceInfo[]>([]);
  const [camId, setCamId] = useState('');
  const [camWarn, setCamWarn] = useState('');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pickRef = useRef<HTMLInputElement | null>(null);

  const table = useMemo(() => buildFormTable(vocab), [vocab]);
  const defs = useMemo(() => {
    const m = new Map<string, string>();
    const dict = vocab as unknown as { term: string; definition?: string }[];
    for (const it of dict) m.set(it.term, it.definition ?? '');
    return m;
  }, [vocab]);

  // ---------- 录入记录（落库；刷新不丢，且不必为再看一眼而重复消耗模型额度） ----------
  // 列表只取元信息、不含正文（2026-09-15 提速）：正文动辄数千字，几十条一起拉会让载入/刷新明显变慢
  const loadRecs = useCallback(async () => {
    setRecsBusy(true);
    setRecs(await listOcrRecordMetas());
    setRecsBusy(false);
  }, []);

  useEffect(() => {
    void loadRecs();
  }, [loadRecs]);

  // 载入某条记录：正文按 id 单取（列表不再带正文），并**当场算一次高亮**存进页对象
  const loadRecordIntoPanel = useCallback(async (r: OcrRecordMeta) => {
    const when = new Date(r.created_at).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    setErr('');
    const text = await getOcrRecordText(r.id);
    if (text === null) {
      setErr('这条记录的正文没取到（可能已被删除），刷新列表后再试');
      return;
    }
    setPages((ps) => [
      ...ps,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: r.label?.trim() || `记录 ${when}`,
        src: '', // 记录只含文本（隐私），载回后不显示原图
        text,
        hits: matchTranscript(text, table),
        model: r.model ?? undefined,
        ms: r.elapsed_ms ?? undefined,
        label: r.label ?? '',
        recordId: r.id,
        saveState: 'ok',
      },
    ]);
  }, [table]);

  const removeRecord = useCallback(async (id: string) => {
    if (!(await deleteOcrRecord(id))) return;
    setRecs((rs) => rs.filter((r) => r.id !== id));
  }, []);

  // ---------- 导入 ----------
  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    const next: Page[] = [];
    const undecodable: string[] = [];
    for (const f of list) {
      try {
        const raw = await readAsDataUrl(f);
        const src = await downscale(raw);
        if (!src) { undecodable.push(f.name); continue; } // 本机浏览器解不了（多为 iPhone 的 HEIC）
        next.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: f.name, src });
      } catch {
        /* 跳过单张失败 */
      }
    }
    setPages((ps) => [...ps, ...next]);
    if (undecodable.length) {
      setErr(
        `有 ${undecodable.length} 张图片本机浏览器无法解码，已跳过：${undecodable.join('、')}`
        + '。若是 iPhone 拍的，多半是 HEIC 格式 —— 可在「设置 → 相机 → 格式」里改为「兼容性最高」（JPEG），'
        + '或先把图片转成 JPEG 再选图。',
      );
    }
  }, []);

  const addShot = useCallback(async (dataUrl: string) => {
    const src = await downscale(dataUrl);
    if (!src) {
      setErr('这张照片没能转成可显示的图片，请重拍一张');
      return;
    }
    setPages((ps) => [
      ...ps,
      { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: `拍题 ${ps.length + 1}`, src },
    ]);
  }, []);

  // ---------- 相机 ----------
  const closeCam = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamOn(false);
  }, []);

  /** 把 getUserMedia 的报错翻成可操作的提示（"在 IDE 内置预览里被拦"是最常见原因） */
  const camErrorText = (e: unknown): string => {
    const name = e instanceof Error ? e.name : '';
    const msg = e instanceof Error ? e.message : String(e);
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return '摄像头权限被拒绝。① 若此页开在 IDE 的内置预览里，请改用 Edge/Chrome 直接访问 http://127.0.0.1:8787（预览用的 webview 通常不放行摄像头）；② Windows：设置 → 隐私和安全性 → 相机 → 允许桌面应用访问相机，并确认 Edge/Chrome 的开关为「开」。';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '系统没检测到摄像头设备。';
    if (name === 'NotReadableError' || name === 'TrackStartError') return '摄像头被别的程序占用了（相机 App / Teams / 会议软件等），先关掉它们再试。';
    if (name === 'OverconstrainedError') return '摄像头不支持请求的参数（已自动降级重试）。';
    return `无法打开摄像头（${name || msg}）`;
  };

  const openCam = useCallback(
    async (deviceId?: string) => {
      setErr('');
      closeCam();
      const md = navigator.mediaDevices;
      if (!md?.getUserMedia) {
        setErr('此环境不提供摄像头接口（getUserMedia）。请用 Edge/Chrome 打开 http://127.0.0.1:8787，或改用「选图 / 拍照」。');
        return;
      }
      // 逐级降约束重试：指定设备 → 后置+高分辨率 → 仅后置 → 最简（Surface 等设备对参数字段较敏感）
      const tries: MediaTrackConstraints[] = [];
      if (deviceId) tries.push({ deviceId: { exact: deviceId } });
      else tries.push({ facingMode: { ideal: 'environment' }, width: { ideal: 2400 } });
      tries.push({ facingMode: 'environment' });
      tries.push({});

      let stream: MediaStream | null = null;
      let lastErr: unknown = null;
      for (const video of tries) {
        try {
          stream = await md.getUserMedia({ video, audio: false });
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!stream) {
        setErr(camErrorText(lastErr));
        return;
      }
      streamRef.current = stream;
      setCamWarn('');
      setCamId(stream.getVideoTracks()[0]?.getSettings().deviceId ?? '');
      setCamOn(true); // 挂流交给下方 effect（必须在 React 提交、<video> 挂载之后再赋 srcObject）
      // 拿到权限后设备 label 才可见，此时列出摄像头供切换（Surface 有前后两个）
      try {
        const all = await md.enumerateDevices();
        setCamList(all.filter((d) => d.kind === 'videoinput'));
      } catch {
        /* 忽略：列不出也不影响拍摄 */
      }
    },
    [closeCam],
  );

  useEffect(() => () => closeCam(), [closeCam]);

  // 把流挂到 <video>：**必须在 React 提交之后**。首次点「开相机」时 <video> 才刚挂载，
  // 若在 openCam 里 setTimeout(0) 直接赋值，ref 往往还是 null → 表现为"授权成功但画面全黑"。
  useEffect(() => {
    const v = videoRef.current;
    const s = streamRef.current;
    if (!camOn || !v || !s) return;
    if (v.srcObject !== s) v.srcObject = s;
    v.play().catch((e: unknown) => {
      const name = e instanceof Error ? e.name : String(e);
      setCamWarn(`画面未自动播放（${name}）：点一下画面即可开始。`);
    });
  }, [camOn, camId]);

  // 2 秒后仍无画面（videoWidth=0）→ 给可操作提示（换摄像头 / 排查占用 / 驱动预热）
  useEffect(() => {
    if (!camOn) {
      setCamWarn('');
      return;
    }
    const t = setTimeout(() => {
      const v = videoRef.current;
      if (v && v.videoWidth === 0) {
        setCamWarn('已授权但没有画面：① 用下拉换另一个摄像头；② 关掉可能占用摄像头的程序（相机 App / Teams）；③ 少数驱动需 2–3 秒预热，可点「重试」。');
      }
    }, 2000);
    return () => clearTimeout(t);
  }, [camOn, camId]);

  const playNow = useCallback(() => {
    void videoRef.current?.play().catch(() => setCamWarn('播放被浏览器拦截：请再点一次画面。'));
  }, []);

  const shoot = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')?.drawImage(v, 0, 0);
    void addShot(canvas.toDataURL('image/jpeg', 0.92));
  }, [addShot]);

  // ---------- 转写 ----------
  const transcribe = useCallback(async (page: Page) => {
    setPages((ps) => ps.map((p) => (p.id === page.id ? { ...p, busy: true, error: undefined } : p)));
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token ?? '';
      if (!token) throw new Error('未登录');
      const res = await fetch(apiUrl('/app-api/ai/transcribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ image: page.src }),
      });
      const body = (await res.json()) as { text?: string; model?: string; ms?: number; error?: string; detail?: string };
      if (!res.ok || !body.text) throw new Error(body.detail || body.error || `HTTP ${res.status}`);
      const text = body.text;
      // 高亮**随文本算这一次**就存进页对象（2026-09-15）：之后改备注、悬浮标记、列表刷新等重渲染都不再重算
      const hits = matchTranscript(text, table);
      setPages((ps) =>
        ps.map((p) => (p.id === page.id ? { ...p, busy: false, text, hits, model: body.model, ms: body.ms, saveState: 'saving' } : p)),
      );
      // 立刻落库：以后刷新/换设备都能载回（高亮在前端重算，不再调用模型）。
      // 入库失败只提示、绝不阻断识别结果展示。
      const payload = { text, model: body.model, elapsedMs: body.ms };
      const recId = page.recordId
        ? (await updateOcrRecord(page.recordId, payload))
          ? page.recordId
          : null
        : await saveOcrRecord({ label: page.label, pageName: page.name, ...payload });
      setPages((ps) =>
        ps.map((p) => (p.id === page.id ? { ...p, recordId: recId ?? p.recordId, saveState: recId ? 'ok' : 'fail' } : p)),
      );
      if (recId) void loadRecs();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPages((ps) => ps.map((p) => (p.id === page.id ? { ...p, busy: false, error: msg } : p)));
      // 完整错误上浮到页面顶部。卡片位太窄，且原先在那里只显示前 40 个字符 ——
      // 2026-09-17 教师就是因为那半截碎片，把「模型已下架」误判成了「rate limit」。
      setErr(`「${page.name}」识别失败：${msg}`);
    }
  }, [loadRecs, table]);

  const runAll = useCallback(async () => {
    setBusyAll(true);
    for (const p of pages) {
      if (!p.text) await transcribe(p); // 串行：避免同时占用额度
    }
    setBusyAll(false);
  }, [pages, transcribe]);

  // 通道自检：不占自己的答卷，服务端用内置小图（几百字节）逐个通道问「几个矩形、什么颜色」。
  // 魔搭那两个模型不处理请求，所以这一步也不计魔粒。
  const checkChannels = useCallback(async () => {
    setProbeBusy(true);
    setErr('');
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token ?? '';
      if (!token) throw new Error('未登录');
      const res = await fetch(apiUrl('/app-api/ai/vision-check'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as {
        probes?: { channel: string; ok: boolean; ms: number; note: string }[];
        error?: string;
        detail?: string;
      };
      if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`);
      setProbe(body.probes ?? []);
    } catch (e) {
      setErr('通道检测失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setProbeBusy(false);
    }
  }, []);

  // ---------- 渲染高亮 ----------
  const renderHi = (text: string, hits: OcrHit[]) => {
    const out: (string | ReactElement)[] = [];
    let cur = 0;
    for (const h of hits) {
      if (h.start < cur) continue;
      // 「一般词」按分级淡化；关掉开关时直接不标（疑似笔误始终保留，避免漏掉真错）
      if (h.level === 'general' && !showGeneral && h.mode !== 'fuzzy') continue;
      out.push(text.slice(cur, h.start));
      const cls = [h.kind === 'scholar' ? 'sch' : 'trm', h.level === 'general' ? 'gen' : '', h.mode === 'variant' ? 'var' : '', h.mode === 'fuzzy' ? 'fz' : '']
        .filter(Boolean)
        .join(' ');
      const label = h.mode === 'fuzzy' ? `疑似「${h.term}」（学生写作：${h.surface}）` : h.mode === 'variant' ? `同词根：${h.term}（${h.surface}·属正常用法）` : h.term;
      const def = defs.get(h.term) ?? '';
      out.push(
        <mark
          key={`${h.start}-${h.term}`}
          className={cls}
          onMouseEnter={(e) => setTip({ x: e.clientX + 12, y: e.clientY + 14, text: def ? `${label} — ${def.slice(0, 280)}` : label })}
          onMouseMove={(e) => setTip((t) => (t ? { ...t, x: e.clientX + 12, y: e.clientY + 14 } : t))}
          onMouseLeave={() => setTip(null)}
        >
          {text.slice(h.start, h.end)}
          {h.mode === 'fuzzy' ? <span className="qm">?</span> : null}
        </mark>,
      );
      cur = h.end;
    }
    out.push(text.slice(cur));
    return out;
  };

  // 合计直接用页对象里已算好的高亮（不再重跑一遍匹配）
  const totals = useMemo(() => summarize(pages.flatMap((p) => p.hits ?? [])), [pages]);

  // 词库变化（教师导入新词条）时补算已载入页的高亮：只在 vocab 变化时跑一次，不参与日常渲染
  useEffect(() => {
    setPages((ps) => {
      if (!ps.some((p) => p.text && !p.hits)) return ps; // 没有缺高亮的页 → 原样返回，避免多余渲染
      return ps.map((p) => (p.text && !p.hits ? { ...p, hits: matchTranscript(p.text, table) } : p));
    });
  }, [table]);

  const done = pages.filter((p) => p.text).length;

  return (
    <div>
      <div className="card">
        <div className="row" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>OCR 辅助阅卷</h3>
          <span className="spacer" />
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            识别 {done}/{pages.length} 页
          </span>
        </div>
        <p className="muted" style={{ marginTop: '0.4rem', fontSize: '0.85rem' }}>
          拍照或选图（可多选、可拖拽）→ 逐页转写 → 在<b>原文里就地高亮</b>术语与学者名；需要核对笔迹时，<b>点上方缩略图</b>或每页右上角「查看原图」即可覆盖查看。
          AI 只做转写与标注，<b>不参与判分</b>；图片不落云端存储。
          <br />
          相机：<b>「拍照」</b>在手机/平板上调用系统相机，在 Windows 桌面打开应用内相机（桌面浏览器按规范忽略 <code>capture</code>，无法直接唤起系统相机）；
          若在 IDE 内置预览里打不开摄像头，请用 <b>Edge/Chrome 直接打开 http://127.0.0.1:8787</b>。APK 阶段会改用原生相机接口。
        </p>

        <div className="ocrm-import" style={{ marginTop: '0.6rem' }}>
          <button
            onClick={() => {
              if (MOBILE_CAM_UA) fileRef.current?.click(); // 移动端：系统相机（capture 生效）
              else void openCam(); // 桌面：应用内相机（桌面浏览器忽略 capture）
            }}
            title={MOBILE_CAM_UA ? '调用系统相机拍照' : '打开应用内相机，可连续拍多页'}
          >
            拍照
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <button className="ghost" onClick={() => pickRef.current?.click()}>
            选图（文件）
          </button>
          <input
            ref={pickRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <button onClick={() => void runAll()} disabled={busyAll || !pages.length}>
            {busyAll ? '识别中…' : `开始识别（${pages.length} 页）`}
          </button>
          <button className="ghost" onClick={() => setPages([])} disabled={!pages.length}>
            清空
          </button>
          <button
            className="ghost"
            onClick={() => void checkChannels()}
            disabled={probeBusy}
            title="用服务端内置的小图逐个试识别通道，不占用你的答卷；模型换代/通道挂掉时用它定位"
          >
            {probeBusy ? '检测中…' : '检测识别通道'}
          </button>
        </div>

        {probe && (
          <div style={{ marginTop: '0.5rem', fontSize: '0.82rem', lineHeight: 1.7 }}>
            {probe.map((p) => (
              <div key={p.channel} style={{ color: p.ok ? 'var(--ok, #2e7d32)' : 'var(--danger, #c33)', wordBreak: 'break-word' }}>
                {p.ok ? '可用' : '不可用'} · {p.channel}
                {p.ms ? ` · ${(p.ms / 1000).toFixed(1)} 秒` : ''}
                <span className="muted" style={{ marginLeft: '0.4rem' }}>{p.note}</span>
              </div>
            ))}
            <div className="muted" style={{ marginTop: '0.2rem' }}>
              正常时应至少有一条「可用」，且回答里能说出三个矩形与红绿蓝。
            </div>
          </div>
        )}

        <div className="ocrm-toolbar">
          <label
            className="ocrm-switch"
            title="高频通用词（education / family / value 之类）淡化显示；关掉后只保留核心术语与学者"
          >
            <span>显示一般词</span>
            <span className="switch ocrm-switch__ctl">
              <input type="checkbox" checked={showGeneral} onChange={(e) => setShowGeneral(e.target.checked)} />
              <span className="switch__track">
                <span className="switch__thumb" />
              </span>
            </span>
          </label>
          {/* 「只看文字」开关已移除（2026-09-15）：原图不再与文本并排，文本本就独占整宽，该开关失去意义 */}
        </div>

        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files) void addFiles(e.dataTransfer.files);
          }}
        >
          {err && (
            <p style={{ color: 'var(--danger, #c33)', fontSize: '0.85rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>
              {err}
            </p>
          )}
          {pages.length > 0 && (
            <div className="ocrm-queue">
              {pages.map((p) => (
                <div className="ocrm-thumb" key={p.id}>
                  {p.src ? (
                    <img src={p.src} alt={p.name} title="点开看原图" onClick={() => openZoom(p.src, p.name)} />
                  ) : p.recordId ? (
                    // 有 recordId ⇒ 这页是从「录入记录」载回来的。图片按隐私口径本就不入库（只存文本），所以这里是正常的
                    <div className="ocrm-noshot">无原图<br /><span>历史记录只存文本</span></div>
                  ) : (
                    // 没有 recordId ⇒ 这页是刚导入/刚拍的，本该带着图；出现占位说明图没生成成功
                    <div className="ocrm-noshot ocrm-noshot--warn">图片未生成<br /><span>请重拍这一页</span></div>
                  )}
                  <div className="meta">
                    {p.name}
                    <br />
                    {p.busy ? '识别中…' : p.text ? `已识别 ${p.text.length} 字符` : p.error ? '识别失败（详情见上方红字）' : '待识别'}
                    {p.text ? (
                      <>
                        {' · '}
                        {p.saveState === 'saving'
                          ? '存入记录…'
                          : p.saveState === 'ok'
                            ? '已存入记录'
                            : p.saveState === 'fail'
                              ? '⚠ 存库失败'
                              : ''}
                      </>
                    ) : null}
                  </div>
                  <input
                    value={p.label ?? ''}
                    placeholder="备注（如学生姓名）"
                    onChange={(e) => setPages((ps) => ps.map((x) => (x.id === p.id ? { ...x, label: e.target.value } : x)))}
                    onBlur={() => {
                      if (p.recordId) void updateOcrRecordLabel(p.recordId, p.label ?? '');
                    }}
                    style={{ width: '100%', fontSize: '0.75rem', marginTop: '0.25rem' }}
                  />
                  <div style={{ display: 'flex', gap: '0.3rem', marginTop: '0.3rem' }}>
                    <button className="ghost" style={{ fontSize: '0.75rem', padding: '0.1rem 0.4rem' }} disabled={p.busy} onClick={() => void transcribe(p)}>
                      重识别
                    </button>
                    <button className="ghost" style={{ fontSize: '0.75rem', padding: '0.1rem 0.4rem' }} onClick={() => setPages((ps) => ps.filter((x) => x.id !== p.id))}>
                      移除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {done > 0 && (
          <div className="ocrm-legend">
            <span>本批合计：术语 {totals.terms} 个 · 学者 {totals.scholars} 位 · 一般词 {totals.generalHits} 处 · 同词根 {totals.variantHits} 处 · 疑似笔误 {totals.fuzzyHits} 处</span>
          </div>
        )}
        <div className="ocrm-legend">
          <span><i style={{ background: '#fff3b0' }} />术语</span>
          <span><i style={{ background: '#cfe8ff' }} />学者</span>
          <span><i style={{ background: '#eceff3' }} />一般词</span>
          <span><i style={{ background: '#eef7e2', borderBottom: '1.5px dotted #7a9a4a' }} />同词根变形（正常用法）</span>
          <span><i style={{ background: '#ffd9d9', borderBottom: '1.5px dashed #c66' }} />疑似笔误</span>
          <span>悬浮任意标记可看词库定义</span>
        </div>
      </div>

      <div className="card" style={{ marginTop: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>录入记录</h3>
          <span className="spacer" />
          <span className="muted" style={{ fontSize: '0.78rem' }}>
            共 {recs.length} 条 · 刷新不丢，载回文本不再调用模型
          </span>
          <button className="ghost" onClick={() => void loadRecs()} disabled={recsBusy} style={{ marginLeft: '0.5rem' }}>
            {recsBusy ? '加载中…' : '刷新'}
          </button>
        </div>
        {recs.length === 0 && (
          <p className="muted" style={{ fontSize: '0.85rem' }}>还没有记录 —— 识别成功的每一页会自动存入这里（只存文本，不存图片）。</p>
        )}
        <div className="ocrm-records">
          {recs.map((r) => (
            <div className="ocrm-record" key={r.id}>
              <div className="ocrm-record__main">
                <b>{r.label?.trim() || '（未填备注）'}</b>
                <span className="muted">
                  {new Date(r.created_at).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}{' '}
                  · {r.text_len ?? 0} 字{r.model ? ` · ${r.model.split('/').pop()}` : ''}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '0.3rem' }}>
                <button className="ghost" style={{ fontSize: '0.75rem', padding: '0.1rem 0.45rem' }} onClick={() => void loadRecordIntoPanel(r)}>
                  载入
                </button>
                <button className="ghost" style={{ fontSize: '0.75rem', padding: '0.1rem 0.45rem' }} onClick={() => void removeRecord(r.id)}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {camOn && (
        <div className="card ocrm-cam">
          <div className="row" style={{ alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>拍题</h3>
            {camList.length > 1 && (
              <select
                value={camId}
                onChange={(e) => void openCam(e.target.value)}
                title="切换前后摄像头"
                style={{ marginLeft: '0.6rem', maxWidth: 220 }}
              >
                {camList.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>
                    {d.label || `摄像头 ${i + 1}`}
                  </option>
                ))}
              </select>
            )}
            <span className="spacer" />
            <button onClick={shoot}>拍下这一页</button>
            <button className="ghost" onClick={closeCam}>关闭相机</button>
          </div>
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            onClick={playNow}
            onCanPlay={playNow}
            style={{ marginTop: '0.6rem' }}
          />
          {camWarn && (
            <p style={{ color: 'var(--c-critical, #c33)', fontSize: '0.85rem', marginTop: '0.4rem' }}>
              {camWarn}{' '}
              <button
                className="ghost"
                style={{ fontSize: '0.78rem', padding: '0.1rem 0.45rem' }}
                onClick={() => void openCam(camId)}
              >
                重试
              </button>
            </p>
          )}
          <p className="muted" style={{ fontSize: '0.82rem' }}>
            对准整页、尽量平放、光线均匀；拍完可继续拍下一页，最后回上面点「开始识别」。
            {camList.length > 1 ? ' 若画面来自前置摄像头，用上方下拉切换到后置。' : ''}
          </p>
        </div>
      )}

      {pages
        .filter((p) => p.text)
        .map((p) => {
          const hits = p.hits ?? []; // 已随文本算好（见 transcribe / loadRecordIntoPanel）
          return (
            <div className="ocrm-page" key={p.id}>
              <div className="row" style={{ alignItems: 'center', gap: '0.4rem' }}>
                <b style={{ fontSize: '0.9rem' }}>{p.name}</b>
                <span className="spacer" />
                {p.src ? (
                  <button
                    className="ppt-link"
                    onClick={() => openZoom(p.src, p.name)}
                  >
                    查看原图
                  </button>
                ) : (
                  <span className="muted" style={{ fontSize: '0.78rem' }}>（记录只存文本，无原图）</span>
                )}
                <span className="muted" style={{ fontSize: '0.78rem' }}>
                  {p.model ? `${p.model.split('/').pop()} · ${Math.round((p.ms ?? 0) / 1000)}s` : ''}
                </span>
              </div>
              {/* 不再与文本并排：文本独占整宽（教师后台加了侧栏，并排会把两栏都挤窄；
                  需要核对笔迹时点上方「查看原图」覆盖查看） */}
              <div className="ocrm-result noimg">
                <div className="ocrm-text">{renderHi(p.text ?? '', hits)}</div>
              </div>
            </div>
          );
        })}

      {/* 原图覆盖层：全屏遮罩 + 图片可滚动；点遮罩/按 ESC/点「关闭」都可退出。
          条栏 sticky，长扫描件向下滚时按钮仍在。
          ★ 2026-09-15 改为 createPortal 挂到 document.body：
            之前它渲染在面板内部，一旦某层祖先有层叠/裁剪/滚动上下文就可能看不到（教师反馈"图片显示不出"）✗。
            挂到 body 后与祖先无关，只受自己的 z-index 约束；
            同时条栏会显示「尺寸 · 数据量」，若图仍失败则显示 src 的开头，直接定位是数据问题还是显示问题 ✓。 */}
      {zoom && createPortal(
        <div className="ocrm-overlay" onClick={() => setZoom(null)}>
          <div className="ocrm-overlay__bar" onClick={(e) => e.stopPropagation()}>
            <b style={{ fontSize: '0.9rem' }}>{zoom.name} · 原图</b>
            <span style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.85)' }}>
              {zoomErr
                ? zoomErr
                : `${zoomDims ? `${zoomDims.w}×${zoomDims.h} · ` : ''}${Math.max(1, Math.round((zoom.src.length * 0.75) / 1024))} KB`}
            </span>
            <span className="spacer" />
            <button className="ghost" onClick={() => setZoomActual((v) => !v)}>
              {zoomActual ? '适应宽度' : '原尺寸'}
            </button>
            <button className="ghost" onClick={() => setZoom(null)}>关闭（ESC）</button>
          </div>
          <img
            src={zoom.src}
            alt={`${zoom.name} 原图`}
            className={zoomActual ? 'actual' : ''}
            onClick={(e) => e.stopPropagation()}
            onLoad={(e) => setZoomDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setZoomErr(
              `图片数据无法显示（${Math.max(1, Math.round(zoom.src.length / 1024))} KB，开头：${zoom.src.slice(0, 32)}…）`,
            )}
          />
        </div>,
        document.body,
      )}

      {tip && (
        <div className="ocrm-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}
