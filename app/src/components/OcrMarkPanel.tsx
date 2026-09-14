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
import { supabase } from '../lib/supabase';
import { useStore } from '../lib/store';
import { buildFormTable, matchTranscript, summarize, type OcrHit } from '../lib/ocrHighlight';
import {
  deleteOcrRecord,
  listOcrRecords,
  saveOcrRecord,
  updateOcrRecord,
  updateOcrRecordLabel,
  type OcrRecord,
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
}

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('读取图片失败'));
    fr.readAsDataURL(file);
  });

/** 等比缩到长边 MAX_EDGE 并转 JPEG（同时降 token 成本与请求体大小） */
const downscale = (dataUrl: string): Promise<string> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(dataUrl);
      ctx.fillStyle = '#fff'; // 透明底转白，避免 PNG→JPEG 变黑
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });

export default function OcrMarkPanel() {
  const { vocab } = useStore();
  const [pages, setPages] = useState<Page[]>([]);
  const [busyAll, setBusyAll] = useState(false);
  const [err, setErr] = useState('');
  const [showGeneral, setShowGeneral] = useState(true); // 一般词（高频通用词）默认显示但淡化
  // 默认「只看文字」：拍照录入意味着教师手上必有纸质原件，先读文本更顺（2026-09-14 教师确认）
  const [onlyCorrected, setOnlyCorrected] = useState(true);
  const [recs, setRecs] = useState<OcrRecord[]>([]);
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
  const loadRecs = useCallback(async () => {
    setRecsBusy(true);
    setRecs(await listOcrRecords());
    setRecsBusy(false);
  }, []);

  useEffect(() => {
    void loadRecs();
  }, [loadRecs]);

  const loadRecordIntoPanel = useCallback((r: OcrRecord) => {
    const when = new Date(r.created_at).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    setPages((ps) => [
      ...ps,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: r.label?.trim() || `记录 ${when}`,
        src: '', // 记录只含文本（隐私），载回后不显示原图
        text: r.text,
        model: r.model ?? undefined,
        ms: r.elapsed_ms ?? undefined,
        label: r.label ?? '',
        recordId: r.id,
        saveState: 'ok',
      },
    ]);
  }, []);

  const removeRecord = useCallback(async (id: string) => {
    if (!(await deleteOcrRecord(id))) return;
    setRecs((rs) => rs.filter((r) => r.id !== id));
  }, []);

  // ---------- 导入 ----------
  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    const next: Page[] = [];
    for (const f of list) {
      try {
        const raw = await readAsDataUrl(f);
        next.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: f.name, src: await downscale(raw) });
      } catch {
        /* 跳过单张失败 */
      }
    }
    setPages((ps) => [...ps, ...next]);
  }, []);

  const addShot = useCallback(async (dataUrl: string) => {
    const src = await downscale(dataUrl);
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
      const res = await fetch('/app-api/ai/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ image: page.src }),
      });
      const body = (await res.json()) as { text?: string; model?: string; ms?: number; error?: string; detail?: string };
      if (!res.ok || !body.text) throw new Error(body.detail || body.error || `HTTP ${res.status}`);
      const text = body.text;
      setPages((ps) =>
        ps.map((p) => (p.id === page.id ? { ...p, busy: false, text, model: body.model, ms: body.ms, saveState: 'saving' } : p)),
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
    }
  }, [loadRecs]);

  const runAll = useCallback(async () => {
    setBusyAll(true);
    for (const p of pages) {
      if (!p.text) await transcribe(p); // 串行：避免同时占用额度
    }
    setBusyAll(false);
  }, [pages, transcribe]);

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

  const totals = useMemo(() => {
    const all = pages.flatMap((p) => (p.text ? matchTranscript(p.text, table) : []));
    return summarize(all);
  }, [pages, table]);

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
          拍照或选图（可多选、可拖拽）→ 逐页转写 → 在<b>原文里就地高亮</b>术语与学者名，配合左侧原图人工给分。
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
        </div>

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
          <label className="ocrm-switch" title="隐藏左侧原图，让高亮文本占满宽度，便于通读与数 AO2">
            <span>只看文字</span>
            <span className="switch ocrm-switch__ctl">
              <input type="checkbox" checked={onlyCorrected} onChange={(e) => setOnlyCorrected(e.target.checked)} />
              <span className="switch__track">
                <span className="switch__thumb" />
              </span>
            </span>
          </label>
        </div>

        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files) void addFiles(e.dataTransfer.files);
          }}
        >
          {err && <p style={{ color: 'var(--danger, #c33)', fontSize: '0.85rem' }}>{err}</p>}
          {pages.length > 0 && (
            <div className="ocrm-queue">
              {pages.map((p) => (
                <div className="ocrm-thumb" key={p.id}>
                  <img src={p.src} alt={p.name} />
                  <div className="meta">
                    {p.name}
                    <br />
                    {p.busy ? '识别中…' : p.text ? `已识别 ${p.text.length} 字符` : p.error ? `失败：${p.error.slice(0, 40)}` : '待识别'}
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
                  · {r.text.length} 字{r.model ? ` · ${r.model.split('/').pop()}` : ''}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '0.3rem' }}>
                <button className="ghost" style={{ fontSize: '0.75rem', padding: '0.1rem 0.45rem' }} onClick={() => loadRecordIntoPanel(r)}>
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
          const hits = matchTranscript(p.text ?? '', table);
          return (
            <div className="ocrm-page" key={p.id}>
              <div className="row" style={{ alignItems: 'center' }}>
                <b style={{ fontSize: '0.9rem' }}>{p.name}</b>
                <span className="spacer" />
                <span className="muted" style={{ fontSize: '0.78rem' }}>
                  {p.model ? `${p.model.split('/').pop()} · ${Math.round((p.ms ?? 0) / 1000)}s` : ''}
                </span>
              </div>
              <div className={`ocrm-result${onlyCorrected || !p.src ? ' noimg' : ''}`}>
                {!onlyCorrected && p.src && <img src={p.src} alt={`${p.name} 原图`} />}
                <div className="ocrm-text">{renderHi(p.text ?? '', hits)}</div>
              </div>
            </div>
          );
        })}

      {tip && (
        <div className="ocrm-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}
