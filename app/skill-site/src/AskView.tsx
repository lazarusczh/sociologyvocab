import { useRef, useState, type KeyboardEvent } from 'react'
import { retrieve } from './retrieval'
import { askStream, type HistMsg } from './ask'
import { booksOf, type SkillData } from './data'

// 回传给模型的多轮上下文上限：最多最近 5 轮（10 条消息）
const HIST_MAX_MSGS = 10;

interface Msg {
  q: string;
  a: string;
  error: string | null;
  sources: string[];
  model?: string | null;
  fail?: string | null;
}

// 响应头 X-AI-Model 的档位代号 → 展示名（便于对比各档效果）
const MODEL_NAME: Record<string, string> = {
  agnes: 'Agnes-2.5-Flash',
  'qwen3-main': 'Qwen3-235B（快速档）',
  'qwen3-think': 'Qwen3-235B-Thinking',
  openrouter: 'OpenRouter 缓冲源',
  'workers-8b': 'Llama-3.1-8B（兜底）',
};

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
  const endRef = useRef<HTMLDivElement>(null);

  const scrollBottom = () =>
    setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);

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

    // 任何异常都必须收尾，否则 busy 永远为 true（界面卡在"思考中"）
    try {
      const res = await askStream(q, system, context, (delta) => {
        setMsgs((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last && last.q === q) copy[copy.length - 1] = { ...last, a: last.a + delta };
          return copy;
        });
        scrollBottom();
      }, history);

      setMsgs((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        if (last && last.q === q) copy[copy.length - 1] = { ...last, sources, error: res.error, model: res.model, fail: res.fail };
        return copy;
      });
    } catch (e) {
      setMsgs((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        if (last && last.q === q) {
          copy[copy.length - 1] = { ...last, sources, error: e instanceof Error ? e.message : '回答失败，请重试。' };
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
              {!m.error && (m.sources.length > 0 || m.model) && (
                <div className="ask-src">
                  {m.sources.length > 0 && <span>出处：{m.sources.join('、')}</span>}
                  {m.model && (
                    <span className="ask-model">
                      模型：{MODEL_NAME[m.model] ?? m.model}
                      {m.fail && (
                        <span className="ask-fail" title={m.fail}>
                          ⚠ {m.fail}
                        </span>
                      )}
                    </span>
                  )}
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

// —— 极简 markdown 渲染：支持标题/加粗/斜体/行内代码/列表/引用 ——
function MdText({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, i) => {
        const b = block.trim();
        if (!b) return null;

        if (/^#{1,4}\s/.test(b)) {
          const level = b.match(/^#{1,4}/)![0].length;
          const body = inline(b.replace(/^#{1,4}\s*/, ''));
          const Tag = level <= 2 ? 'h3' : level === 3 ? 'h4' : 'h5';
          return <Tag key={i}>{body}</Tag>;
        }

        const lines = b.split('\n');
        if (lines.every((l) => /^\s*[-•*]\s+/.test(l))) {
          return (
            <ul key={i}>
              {lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-•*]\s+/, ''))}</li>)}
            </ul>
          );
        }
        if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
          return (
            <ol key={i}>
              {lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>)}
            </ol>
          );
        }
        return <p key={i}>{inline(b)}</p>;
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
