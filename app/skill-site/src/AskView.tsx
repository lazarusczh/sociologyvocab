import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { retrieve, retrievePages, expandPages, buildPageContext, buildScaffoldText, localTerms, type PageIndexBook, type ScaffoldRow } from './retrieval'
import { parseBlocks, orderedLabels } from './md'
import { QUALITY_CN, askStream, fetchQueryTerms, fetchTierCatalog, searchWebRemote, webSegmentPrompt, type HistMsg, type TierInfo, type WebSource } from './ask'
import { fetchPageIndex, fetchPageTexts, fetchScaffolds } from './supabase'
import { booksOf, type SkillData } from './data'

// 页原文出处里显示的书名（与导入时的 book 代码对应）
const PAGE_BOOK_LABEL: Record<string, string> = {
  tb1: 'Haralambos',
  tb2: 'Livesey & Blundell',
};

// 回传给模型的多轮上下文上限：最多最近 5 轮（10 条消息）
const HIST_MAX_MSGS = 10;

// 档位目录的**内置兜底**：只在拉不到后端目录时用（旧部署/断网），保证界面仍可用。
// 正常走 GET /skill-api/models —— 那里是模型名的唯一真源，后端换模型时界面自动跟随。
// 2026-09-17 改：原先这里写死了「Qwen3-235B」等名字，路由换了模型后界面还显示旧名（教师发现）。
const TIER_FALLBACK: TierInfo[] = [
  { code: 'auto', label: '自动', model: '', note: '按题目难度自动选档' },
  { code: 'fast', label: '快速', model: '', note: '强制快速档' },
  { code: 'think', label: '深度', model: '', note: '强制深度档' },
  { code: 'nemotron', label: 'Nemo', model: '', note: 'OpenRouter 免费缓冲源' },
  { code: 'llama', label: '兜底', model: '', note: 'Workers AI 兜底' },
];

/** 模型 id → 展示短名：去掉供应商前缀（`Qwen/Qwen3.5-122B-A10B` → `Qwen3.5-122B-A10B`） */
const shortModel = (id: string) => id.split('/').pop() || id;

/** 档位在界面上的叫法：`模型名（档位）`；自动档没有单一模型，写「按题切换」 */
const tierLabel = (t: TierInfo) =>
  t.code === 'auto' || !t.model ? `${t.label}（按题切换档位）` : `${shortModel(t.model)}（${t.label}）`;

/** 联网段状态机（方案 §11.3）：searching → ok / empty / failed */
type WebState = 'searching' | 'ok' | 'empty' | 'failed';
interface WebSeg {
  state: WebState;
  sources: WebSource[];
  a: string;
  error?: string | null;
}

interface Msg {
  q: string;
  a: string;
  error: string | null;
  sources: string[];
  /** 联网段（第二段）。未开启联网时为 undefined —— 界面完全不渲染这一块 */
  web?: WebSeg;
  /** 档位代号（X-AI-Model），诊断用 */
  model?: string | null;
  /** 真实模型 id（X-AI-Model-Id）；尾缀优先显示它 */
  modelId?: string | null;
  fail?: string | null;
}

/**
 * 尾缀显示什么：**优先真实模型 id**（后端给什么就显示什么，换模型自动跟随）；
 * 旧部署没有这个响应头时退化为代号，至少不会是错的旧名字。
 */
const modelLabel = (m: Pick<Msg, 'model' | 'modelId'>) =>
  m.modelId ? shortModel(m.modelId) : (m.model ?? '');

const SUGGESTIONS = [
  '功能主义怎么解释教育？',
  '什么是 meritocracy？',
  '用评价框架回答 "family is patriarchal"',
  'Bowles & Gintis 的对应理论是什么',
];

export default function AskView({ skill }: { skill: SkillData }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // 手动档位选择（记忆在 localStorage，便于长期对比）
  const [tier, setTier] = useState<string>(() => localStorage.getItem('ask_tier') || 'auto');
  // 联网检索开关：默认**关**（不额外消耗检索额度）；与档位一样记忆在 localStorage
  const [webOn, setWebOn] = useState<boolean>(() => localStorage.getItem('ask_web') === '1');
  // 档位目录：模型名的唯一真源在后端（GET /skill-api/models）。拉不到时保留内置兜底，界面不至于空白。
  const [tiers, setTiers] = useState<TierInfo[]>(TIER_FALLBACK);
  useEffect(() => {
    let alive = true;
    void fetchTierCatalog().then((t) => {
      if (alive && t.length) setTiers(t);
    });
    return () => { alive = false; };
  }, []);
  const chooseTier = (t: string) => {
    setTier(t);
    try { localStorage.setItem('ask_tier', t); } catch { /* ignore */ }
  };
  // 学生视角模拟开关存放于主站 DevPanel（localStorage 'ask_simulate'，同源共享）；
  // 每次发送前实时读取，保证在主站切过后无需刷新即生效。
  const endRef = useRef<HTMLDivElement>(null);

  // 教材原文页索引（页级关键词 → 页码）：体积小，常驻前端；原文按需拉取
  const [pageIdx, setPageIdx] = useState<PageIndexBook[] | null>(null);
  // 章节答题脚手架（蒸馏层的教师口径）：按命中的章注入 system
  const [scaffolds, setScaffolds] = useState<ScaffoldRow[]>([]);
  useEffect(() => {
    let alive = true;
    fetchPageIndex()
      .then((d) => { if (alive) setPageIdx(d); })
      .catch(() => { if (alive) setPageIdx([]); });   // 取不到索引时静默降级
    fetchScaffolds()
      .then((d) => { if (alive) setScaffolds(d); })
      .catch(() => { if (alive) setScaffolds([]); });
    return () => { alive = false; };
  }, []);

  const scrollBottom = () =>
    setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);

  /**
   * 第二段：联网补例证。**永远在资料库段收尾之后**才调用（§11.3 的顺序），
   * 且自带 try/catch —— 这一段失败绝不能把已经出来的资料库回答标成失败。
   */
  const runWebSegment = async (q: string) => {
    const patch = (p: Partial<WebSeg>) =>
      setMsgs((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        if (last && last.q === q) {
          const prev: WebSeg = last.web ?? { state: 'searching', sources: [], a: '', error: null };
          copy[copy.length - 1] = { ...last, web: { ...prev, ...p } };
        }
        return copy;
      });

    patch({ state: 'searching', sources: [], a: '', error: null });
    try {
      // 中文改写交给服务端：一次模型调用同时产出「检索句」与「关键词」。
      // 以前前端先调术语桥拿 8–12 个词再拼成一句喂 Tavily —— 那正是八卦结果的来源。
      const found = await searchWebRemote(q);
      if (found.error) { patch({ state: 'failed', error: found.error }); return; }
      if (!found.sources.length) { patch({ state: 'empty', sources: [] }); return; }

      patch({ state: 'ok', sources: found.sources, error: null });
      const { system, context } = webSegmentPrompt(found.sources);
      const r = await askStream(q, system, context, (d) => {
        setMsgs((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last && last.q === q && last.web) {
            copy[copy.length - 1] = { ...last, web: { ...last.web, a: last.web.a + d } };
          }
          return copy;
        });
        scrollBottom();
      }, [], tier, false);
      patch({ state: r.error ? 'failed' : 'ok', error: r.error });
    } catch (e) {
      patch({ state: 'failed', error: e instanceof Error ? e.message : '联网部分失败' });
    }
  };

  const send = async (raw?: string) => {
    const q = (raw ?? input).trim();
    if (!q || busy) return;
    setInput('');
    setMsgs((m) => [...m, { q, a: '', error: null, sources: [] }]);
    setBusy(true);
    scrollBottom();

    // 构造多轮上下文：仅把「已收尾且有回答」的轮次作为历史回传（user/assistant 成对）；
    // 完全失败(无输出)的轮次跳过，后续追问不必依赖它。
    const pairs: HistMsg[] = [];
    for (const m of msgs) {
      if (!m.a) continue;
      pairs.push({ role: 'user', content: m.q });
      pairs.push({ role: 'assistant', content: m.error ? `${m.a}\n\n（该轮回答因错误中断：${m.error}）` : m.a });
    }
    let history = pairs.length > HIST_MAX_MSGS ? pairs.slice(pairs.length - HIST_MAX_MSGS) : pairs;
    if (history[0]?.role === 'assistant') history = history.slice(1);

    const { system, context, sources } = retrieve(skill, q);

    // 教材原文页：用常驻索引把问题定位到页码，再按需拉取原文，
    // 补上蒸馏摘要丢掉的研究案例等正文细节（问不到就静默降级为纯蒸馏材料）。
    let finalContext = context;
    let finalSources = sources;
    let finalSystem = system;
    const chaptersHit: string[] = [];   // 命中的章（用于注入该章答题脚手架）
    if (pageIdx && pageIdx.length) {
      try {
        // 中文提问：先查离线术语桥（零延迟），覆盖不足再让模型翻译补足
        let extraTerms = localTerms(pageIdx ?? [], q);
        if (/[一-鿿]/.test(q) && extraTerms.length < 3) {
          extraTerms = [...new Set([...extraTerms, ...(await fetchQueryTerms(q))])];
        }
        const hits = expandPages(retrievePages(pageIdx, q, extraTerms));
        for (const h of hits) if (h.chapter) chaptersHit.push(h.chapter);
        const byBook = new Map<string, number[]>();
        for (const h of hits) byBook.set(h.book, [...(byBook.get(h.book) ?? []), h.page]);
        const texts: Record<string, string> = {};
        for (const [book, pages] of byBook) {
          const rows = await fetchPageTexts(book, pages);
          for (const r of rows) texts[`${book}:${r.page}`] = r.text;
        }
        const pc = buildPageContext(hits, texts, PAGE_BOOK_LABEL);
        if (pc.context) {
          finalContext = `${context}\n\n---\n\n${pc.context}`;
          finalSources = [...sources, ...pc.sources].slice(0, 10);
        }
      } catch { /* ignore: 原文不可用时仍用蒸馏材料作答 */ }
    }
    // 页没命中时，退一步用蒸馏来源里出现的章名，保证脚手架仍能注入
    for (const r of scaffolds) {
      if (sources.some((s) => s.toLowerCase().includes(r.chapter.toLowerCase()))) {
        chaptersHit.push(r.chapter);
      }
    }
    const scaffold = buildScaffoldText(scaffolds, chaptersHit);
    if (scaffold) finalSystem = `${system}\n\n${scaffold}`;

    // 任何异常都必须收尾，否则 busy 永远为 true（界面卡在"思考中"）
    try {
      const res = await askStream(q, finalSystem, finalContext, (delta) => {
        setMsgs((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last && last.q === q) copy[copy.length - 1] = { ...last, a: last.a + delta };
          return copy;
        });
        scrollBottom();
      }, history, tier, localStorage.getItem('ask_simulate') === '1');

      setMsgs((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        if (last && last.q === q) copy[copy.length - 1] = { ...last, sources: finalSources, error: res.error, model: res.model, modelId: res.modelId, fail: res.fail };
        return copy;
      });

      // 资料库段收尾后再补联网段（顺序即语义：先框架，后例证）
      if (webOn) await runWebSegment(q);
    } catch (e) {
      setMsgs((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        if (last && last.q === q) {
          copy[copy.length - 1] = { ...last, sources: finalSources, error: e instanceof Error ? e.message : '回答失败，请重试。' };
        }
        return copy;
      });
    } finally {
      setBusy(false);
      scrollBottom();
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const clearAll = () => {
    if (busy) return;
    setMsgs([]);
    setInput('');
  };

  return (
    <section className="ask">
      <h2>AI 问答</h2>
      <p className="ask-hint">基于 {booksOf(skill).length} 本教材语料跨本检索作答，同一概念会并列各书说法；附引用出处，未覆盖内容如实说明。</p>

      <div className="ask-tier" role="group" aria-label="模型档位">
        <span className="ask-tier-label">模型</span>
        {/* 下拉而非一排药丸：模型名很长（如 Qwen3.5-397B-A17B（深度）），横排会把界面挤乱（2026-09-17 教师建议） */}
        <select
          className="ask-tier-select"
          value={tier}
          title={tiers.find((t) => t.code === tier)?.note ?? ''}
          onChange={(e) => chooseTier(e.target.value)}
        >
          {tiers.map((t) => (
            <option key={t.code} value={t.code} title={t.note ?? ''}>
              {tierLabel(t)}
            </option>
          ))}
        </select>

        <label
          className="ask-web-toggle"
          title="开启后：先用教材语料作答，再额外检索一次外部案例与过往研究（会消耗检索额度）"
        >
          <input
            type="checkbox"
            checked={webOn}
            disabled={busy}
            onChange={(e) => {
              setWebOn(e.target.checked);
              try { localStorage.setItem('ask_web', e.target.checked ? '1' : '0'); } catch { /* ignore */ }
            }}
          />
          <span className="ask-web-text">联网搜索</span>
        </label>
      </div>

      {msgs.length === 0 && (
        <div className="ask-empty">
          <p>试试问：</p>
          <div className="chips">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="chip" onClick={() => void send(s)} disabled={busy}>
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {msgs.length > 0 && (
        <div className="ask-toolbar">
          <span className="ask-count">{msgs.length} 轮</span>
          <button className="ask-clear" onClick={clearAll} disabled={busy}>
            清空对话
          </button>
        </div>
      )}

      <div className="ask-list">
        {msgs.map((m, i) => (
          <div className="ask-pair" key={i}>
            <div className="ask-q">{m.q}</div>
            <div className="ask-a">
              {m.a ? <MdText text={m.a} /> : m.error ? <div className="ask-err">{m.error}</div> : <div className="typing">思考中…</div>}
              {!m.error && (m.sources.length > 0 || m.model || m.modelId) && (
                <div className="ask-src">
                  {m.sources.length > 0 && <span>出处：{m.sources.join('、')}</span>}
                  {(m.modelId || m.model) && (
                    <span className="ask-model">
                      模型：{modelLabel(m)}
                      {m.fail && (
                        <span className="ask-fail" title={m.fail}>
                          ⚠ {m.fail}
                        </span>
                      )}
                    </span>
                  )}
                </div>
              )}

              {/* 第二段：联网。边界由「独立请求 + 固定小标题」共同保证，模型无权决定从这里开始联网 */}
              {m.web && (
                <div className="ask-web">
                  <div className="ask-web-head">
                    <span className="ask-web-badge">联网</span>
                    以下内容来自于资料库之外的联网查询
                  </div>

                  {m.web.state === 'searching' && (
                    <div className="ask-web-status">正在检索外部资料…</div>
                  )}
                  {m.web.state === 'empty' && (
                    <div className="ask-web-status">本次检索没有找到相关材料。</div>
                  )}
                  {m.web.state === 'failed' && (
                    <div className="ask-web-status ask-web-fail">
                      联网部分未完成：{m.web.error}
                      <span className="ask-web-note">（资料库回答不受影响）</span>
                    </div>
                  )}

                  {m.web.sources.length > 0 && (
                    <ol className="web-src-list">
                      {m.web.sources.map((s, k) => {
                        // 来源已按「案例侧 → 研究侧」分组排序，这里在换组处插小标题
                        const prevSource = k > 0 ? m.web!.sources[k - 1].source : null;
                        const showGroup = k === 0 || prevSource !== s.source;
                        return (
                        <Fragment key={k}>
                        {showGroup && (
                          <li className="web-group">
                            {s.source === 'tavily' ? '现实案例与数据' : '过往研究'}
                          </li>
                        )}
                        <li className="web-src">
                          <a href={s.url} target="_blank" rel="noopener noreferrer">
                            <span className="web-num">[{k + 1}]</span>
                            {s.title || s.domain}
                          </a>
                          <div className="web-tags">
                            <span className={`web-tag q-${s.quality}`}>{QUALITY_CN[s.quality] ?? s.quality}</span>
                            <span className="web-tag r">{s.region}</span>
                            <span className={`web-tag ${s.primary ? 'p-yes' : 'p-no'}`}>
                              {s.primary ? '原始' : '转述'}
                            </span>
                            {s.year ? <span className="web-tag r">{s.year}</span> : null}
                            {typeof s.citedBy === 'number' ? (
                              <span className="web-tag r">{s.citedBy} 引</span>
                            ) : null}
                          </div>
                          {s.authors?.length ? (
                            <div className="web-authors">
                              {s.authors.slice(0, 3).join(', ')}
                              {s.authors.length > 3 ? ' et al.' : ''}
                            </div>
                          ) : null}
                          <div className="web-dom">
                            {s.domain}
                            {s.venue ? ` · ${s.venue}` : ''}
                          </div>
                          {s.snippet ? <div className="web-sn">{s.snippet}</div> : null}
                        </li>
                        </Fragment>
                        );
                      })}
                    </ol>
                  )}

                  {m.web.a && <MdText text={m.web.a} />}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="ask-input-bar">
        <textarea
          className="ask-input"
          rows={2}
          placeholder="输入社会学问题（中英皆可）…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          disabled={busy}
        />
        <button className="btn send-btn" onClick={() => void send()} disabled={busy || !input.trim()}>
          {busy ? '生成中' : '发送'}
        </button>
      </div>
    </section>
  );
}

// —— 极简 markdown 渲染：分块解析见 md.ts（列表跨空行合并、整行加粗识别为小标题）——
function MdText({ text }: { text: string }) {
  return (
    <>
      {parseBlocks(text).map((b, i) => {
        if (b.kind === 'heading') {
          const Tag = b.level <= 2 ? 'h3' : b.level === 3 ? 'h4' : 'h5';
          return <Tag key={i}>{inline(b.text)}</Tag>;
        }
        if (b.kind === 'ul' || b.kind === 'ol') {
          const Tag = b.kind === 'ul' ? 'ul' : 'ol';
          const labels = b.kind === 'ol' ? orderedLabels(b.items) : [];
          return (
            <Tag key={i}>
              {b.items.map((it, j) => (
                <li key={j}>
                  {labels[j] && <span className="md-num">{labels[j]}.</span>}
                  {inline(it.text)}
                  {it.subs.length > 0 && (
                    <ul>
                      {it.subs.map((s, k) => <li key={k}>{inline(s)}</li>)}
                    </ul>
                  )}
                </li>
              ))}
            </Tag>
          );
        }
        return <p key={i}>{inline(b.text)}</p>;
      })}
    </>
  );
}

function inline(s: string): React.ReactNode {
  // 先保护 `code`，再处理 **bold** 与 *italic*，避免嵌套混乱
  const parts = s.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith('*') && p.endsWith('*') && p.length > 2) return <em key={i}>{p.slice(1, -1)}</em>;
    return p;
  });
}
