// ==UserScript==
// @name         ManageBac Term Grades 等第批量填入
// @namespace    local.termgrade
// @version      1.0
// @description  导入 ManageBac 导出的 TermGrades.xlsx，把等第按学生姓名自动填进 Term Grades 页面（逐学生卡片识别；预演 / 回读校验；纯本机，不上传任何数据）
// @match        https://*.managebac.cn/*/term-grades*
// @match        https://*.managebac.com/*/term-grades*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

/*
 * 这个脚本与「词汇项目」无关，只做一件事：
 *   把 ManageBac 自己导出的 TermGrades.xlsx 里的等第，填回 ManageBac 的 Term Grades 页面。
 *
 * 为什么匹配用「姓名」：导出的表本身就是 ManageBac 的产物，两边的姓名写法天然一致，
 * 不存在「站内名 vs ManageBac 名」对不上的问题。
 *
 * 使用流程（详见面板内提示）：
 *   1. 打开 ManageBac 某个班的 Gradebook → Term Grades 页面
 *   2. 面板里「导入 TermGrades.xlsx」
 *   3. 先点「预演」——只匹配、不写，核对「谁 → 哪一格 → 填什么」
 *   4. 确认无误再点「填入本页」
 *   5. 如果页面一次只显示一个学生，用「自动跟随」：你切到下一个学生，它自动填
 *
 * 安全约定：
 *   · 只写「预演里明确显示过」的格子；N/A 与空值默认跳过
 *   · 每写一格都会回读校验，失败会单独报出来
 *   · 不读取、不存储、不上传任何学生数据；导入的表格只留在本页内存里
 *   · 只记住「列勾选」与「字段映射」这类设置（GM 存储，仅本机）
 *
 * 页面结构未知时的兜底：点「探查结构」，把结果发给我，我据此把选择器写死成最稳的版本。
 */
(function () {
  'use strict';

  // ===================== 基础工具 =====================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 归一化：小写、把标点/括号/多余空格折叠成单空格
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff*]+/g, ' ').trim();
  // 只保留英文部分（表头里有中文后缀，如 "Mid-term/Mock 期中/模拟"）
  const ascii = (s) => (s || '').replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim();
  const uniq = (arr) => [...new Set(arr)];
  const clampText = (s, n) => {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };

  const store = {
    get(k, dflt) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(k, dflt);
        const raw = localStorage.getItem(k);
        return raw == null ? dflt : JSON.parse(raw);
      } catch { return dflt; }
    },
    set(k, v) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(k, v);
        else localStorage.setItem(k, JSON.stringify(v));
      } catch { /* 存储失败不致命 */ }
    },
    del(k) {
      try {
        if (typeof GM_deleteValue === 'function') GM_deleteValue(k);
        else localStorage.removeItem(k);
      } catch { /* ignore */ }
    },
  };

  const SETTINGS_KEY = 'mb_term_grade_settings_v1';

  // ===================== 姓名解析与匹配（沿用本项目已验证的规则） =====================
  // 解析 ManageBac 姓名显示串，例如 "Zhang, San (John) | 张三"
  function parseMBName(text) {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    const paren = t.match(/\(([^)]*)\)/);
    const en = norm(paren ? paren[1] : '');
    const cn = norm((t.split('|')[1] || '').trim());
    const head = norm(t.split('|')[0].replace(/\([^)]*\)/g, ' '));
    const pinyin = head.split(' ').filter(Boolean);
    const tokens = new Set([...pinyin, ...(en ? en.split(' ') : []), ...(cn ? [cn] : [])]);
    return { display: t, en, cn, full: norm(t), pinyin, tokens };
  }

  // 宽松打分匹配：分数越高越像；0 = 不匹配
  function scoreMatch(key, s) {
    const p = norm(key);
    if (!p) return 0;
    if (s.en && p === s.en) return 100;          // 英文名完全一致（最常用）
    if (s.cn && p === s.cn) return 100;          // 中文名完全一致
    if (p === s.full) return 100;                // 整串一致
    const pt = p.split(' ').filter(Boolean);
    if (pt.length && pt.every((t) => s.tokens.has(t))) {
      return (s.en && pt.includes(s.en)) ? 90 : 80; // 词全命中（含英文名给更高分）
    }
    if (pt.length === 1 && s.pinyin.includes(pt[0])) return 70; // 单个拼音词（如仅名）
    if (s.en && (p.includes(s.en) || s.en.includes(p))) return 60; // 包含关系
    return 0;
  }

  // 用单个 key 在名册里找匹配；并列时返回全部候选人（供人工消歧）
  function matchOne(key, roster) {
    let best = null, bestScore = 0, candidates = [];
    for (const r of roster) {
      const sc = scoreMatch(key, r.parsed);
      if (sc > bestScore) { bestScore = sc; best = r; candidates = [r]; }
      else if (sc === bestScore && sc > 0) candidates.push(r);
    }
    return bestScore > 0
      ? { picked: best, ties: candidates.length, candidates, score: bestScore }
      : { picked: null, ties: 0, candidates: [], score: 0 };
  }

  // 由导出行组合出姓名候选（由具体到宽泛，命中即用）
  function nameCandidates(rec) {
    const out = [];
    const push = (parts) => {
      const s = parts.filter(Boolean).join(' ').trim();
      if (s && !out.includes(s)) out.push(s);
    };
    const { pref, first, last, other } = rec;
    push([pref, first, last]);
    push([first, last]);
    push([pref, last]);
    push([last, first]);
    push([last, pref]);
    push([pref]);
    push([first]);
    push([other]);
    return out;
  }

  // ===================== 直读 .xlsx（zip + 浏览器内置解压，无需第三方库） =====================
  const U16 = (dv, o) => dv.getUint16(o, true);
  const U32 = (dv, o) => dv.getUint32(o, true);

  function zipEntries(buf) {
    const dv = new DataView(buf);
    const dec = new TextDecoder('utf-8');
    let eocd = -1;
    const min = Math.max(0, buf.byteLength - 65557);
    for (let i = buf.byteLength - 22; i >= min; i--) {
      if (U32(dv, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return [];
    const total = U16(dv, eocd + 10);
    let p = U32(dv, eocd + 16);
    const out = [];
    for (let i = 0; i < total; i++) {
      if (U32(dv, p) !== 0x02014b50) break;
      const method = U16(dv, p + 10);
      const compSize = U32(dv, p + 20);
      const fnLen = U16(dv, p + 28);
      const exLen = U16(dv, p + 30);
      const cmLen = U16(dv, p + 32);
      const lho = U32(dv, p + 42);
      const name = dec.decode(new Uint8Array(buf, p + 46, fnLen));
      out.push({ name, method, compSize, lho });
      p += 46 + fnLen + exLen + cmLen;
    }
    return out;
  }

  async function readZipEntry(buf, e) {
    const dv = new DataView(buf);
    if (U32(dv, e.lho) !== 0x04034b50) return null;
    const fnLen = U16(dv, e.lho + 26);
    const exLen = U16(dv, e.lho + 28);
    const data = new Uint8Array(buf, e.lho + 30 + fnLen + exLen, e.compSize);
    if (e.method === 0) return data;
    if (e.method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const s = new Blob([data]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(s).arrayBuffer());
    }
    return null;
  }

  function colIdx(letters) {
    let n = 0;
    for (const ch of (letters || '').toUpperCase()) {
      const c = ch.charCodeAt(0);
      if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    }
    return n - 1;
  }

  // 读一个 worksheet 成二维数组
  function sheetRowsFromXml(xmlText, shared) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const rows = [];
    doc.querySelectorAll('row').forEach((rEl) => {
      const rIdx = parseInt(rEl.getAttribute('r') || '0', 10) - 1;
      if (rIdx < 0) return;
      const arr = rows[rIdx] || (rows[rIdx] = []);
      rEl.querySelectorAll('c').forEach((cEl) => {
        const ci = colIdx((cEl.getAttribute('r') || '').replace(/\d+/g, ''));
        const t = cEl.getAttribute('t');
        let v = '';
        if (t === 's') {
          const vEl = cEl.querySelector('v');
          const idx = parseInt(vEl ? (vEl.textContent || '-1') : '-1', 10);
          v = shared[idx] != null ? shared[idx] : '';
        } else if (t === 'inlineStr') {
          const tEl = cEl.querySelector('is t') || cEl.querySelector('t');
          v = tEl ? (tEl.textContent || '') : '';
        } else {
          const isEl = cEl.querySelector('is');
          if (isEl) {
            let s = '';
            isEl.querySelectorAll('t').forEach((t2) => { s += t2.textContent || ''; });
            v = s;
          } else {
            const vEl = cEl.querySelector('v');
            v = vEl ? (vEl.textContent || '') : '';
          }
        }
        if (ci >= 0) arr[ci] = v;
      });
    });
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i] || (rows[i] = []);
      for (let j = 0; j < a.length; j++) if (a[j] === undefined) a[j] = '';
    }
    return rows;
  }

  // 读出 xlsx 的全部 sheet（名称 + 行），并按「含 Student ID 表头」挑出 Term Grades 那张
  async function readXlsxSheets(buf) {
    const entries = zipEntries(buf);
    const dec = new TextDecoder('utf-8');
    const byName = new Map(entries.map((e) => [e.name, e]));
    const ssE = byName.get('xl/sharedStrings.xml');
    const shared = [];
    if (ssE) {
      const bytes = await readZipEntry(buf, ssE);
      if (bytes) {
        const doc = new DOMParser().parseFromString(dec.decode(bytes), 'application/xml');
        doc.querySelectorAll('si').forEach((si) => {
          let s = '';
          si.querySelectorAll('t').forEach((t) => { s += t.textContent || ''; });
          shared.push(s);
        });
      }
    }

    // sheet 名称 ← workbook.xml + rels；读不到就退化为 sheet1/2/3 顺序
    let sheetList = [];
    const wbE = byName.get('xl/workbook.xml');
    const relE = byName.get('xl/_rels/workbook.xml.rels');
    if (wbE) {
      const wbBytes = await readZipEntry(buf, wbE);
      const relMap = new Map();
      if (relE) {
        const relBytes = await readZipEntry(buf, relE);
        if (relBytes) {
          const rdoc = new DOMParser().parseFromString(dec.decode(relBytes), 'application/xml');
          rdoc.querySelectorAll('Relationship').forEach((r) => {
            const id = r.getAttribute('Id');
            let target = r.getAttribute('Target') || '';
            target = target.replace(/^\/?xl\//, '').replace(/^\//, '');
            if (id && target) relMap.set(id, 'xl/' + target);
          });
        }
      }
      if (wbBytes) {
        const wdoc = new DOMParser().parseFromString(dec.decode(wbBytes), 'application/xml');
        wdoc.querySelectorAll('sheet').forEach((s) => {
          const rid = s.getAttribute('r:id') || s.getAttribute('id');
          const name = s.getAttribute('name') || '';
          const path = (rid && relMap.get(rid)) || null;
          sheetList.push({ name, path });
        });
      }
    }
    if (!sheetList.length) {
      entries
        .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
        .forEach((e) => sheetList.push({ name: e.name.replace(/^xl\/worksheets\//, '').replace(/\.xml$/, ''), path: e.name }));
    }

    const sheets = [];
    for (const s of sheetList) {
      const e = s.path ? byName.get(s.path) : null;
      if (!e) continue;
      const bytes = await readZipEntry(buf, e);
      if (!bytes) continue;
      sheets.push({ name: s.name, rows: sheetRowsFromXml(dec.decode(bytes), shared) });
    }
    return sheets;
  }

  // ===================== 表格 → 记录 =====================
  // 身份列 / 不参与填写：这些即使有值也不填
  const IDENTITY_COL = /^(class\s*id|student\s*id|last\s*name|first\s*name|other\s*name|preferred\s*name|average|comments?|notes?)$/i;

  // 找表头行：含 "Student ID" 的那一行
  function findHeaderRow(rows) {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || [];
      if (r.some((c) => /^student\s*id$/i.test(ascii(c).trim()))) return i;
    }
    return -1;
  }

  // 由一张 sheet 建出 { columns, records }
  function buildTable(rows) {
    const hi = findHeaderRow(rows);
    if (hi < 0) return null;
    const head = (rows[hi] || []).map((c) => (c || '').trim());
    const colIdxOf = (re) => head.findIndex((h) => re.test(ascii(h).trim()));

    const iId = colIdxOf(/^student\s*id$/i);
    const iLast = colIdxOf(/^last\s*name$/i);
    const iFirst = colIdxOf(/^first\s*name$/i);
    const iOther = colIdxOf(/^other\s*name$/i);
    const iPref = colIdxOf(/^preferred\s*name$/i);
    if (iId < 0) return null;

    // 可填列：有表头、非身份列
    const columns = [];
    head.forEach((h, i) => {
      const en = ascii(h).trim();
      if (!en) return;
      if (IDENTITY_COL.test(en)) return;
      columns.push({ index: i, name: h.trim(), key: en });
    });

    const g = (row, i) => (i >= 0 ? (row[i] || '').trim() : '');
    const records = [];
    for (let r = hi + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || !row.length) continue;
      const id = g(row, iId);
      const last = g(row, iLast), first = g(row, iFirst), pref = g(row, iPref), other = g(row, iOther);
      if (!id && !last && !first) continue;   // 空行 / 结尾汇总行
      const values = {};
      for (const c of columns) values[c.index] = g(row, c.index);
      records.push({ id, last, first, pref, other, values });
    }
    return { headerRow: hi, columns, records };
  }

  // 值清洗：N/A、空 → 跳过；字母等第统一大写、A * → A*
  // 支持两种写法：
  //   · 纯等第        "A*"  "u"  "B"
  //   · 等第+百分比   "C (60.0%)"  "A* (91.2%)"   ← Task Categories 表就是这种
  // 注意：页面上只填**等第字母**，后面的百分比一律丢弃（页面评分项要的是等第，不是百分数）。
  function cleanValue(raw) {
    let v = (raw == null ? '' : String(raw)).replace(/\s+/g, ' ').trim();
    if (!v) return { skip: true, reason: '空值' };
    if (/^(n\/?a|-|—|na)$/i.test(v)) return { skip: true, reason: 'N/A' };

    // 形如 "C (60.0%)" / "A* (91.2%)" / "U(2.0%)" → 只取等第
    const m = /^([A-Ua-u]\*?)\s*[（(]\s*([\d.]+)\s*%\s*[)）]$/.exec(v);
    if (m) {
      return { skip: false, value: m[1].toUpperCase(), grade: m[1].toUpperCase(), percent: m[2] + '%' };
    }

    v = v.replace(/\s*\*\s*/g, '*').replace(/\s+/g, ' ');
    if (/^[a-u](\*)?$/i.test(v)) v = v.toUpperCase();
    return { skip: false, value: v, grade: v };
  }

  // ===================== 选哪张工作表 =====================
  // TermGrades 导出有两张表，内容不同：
  //   ① "Term Grades"     —— 已填好的最终等第快照（填回去不会产生变化）
  //   ② "Task Categories" —— 各评分项的**实际分类成绩**（等第 + 百分比），这才是要填的
  // 因此优先选 Task Categories；找不到再退回其他含 Student ID 表头的工作表。
  function pickSheet(sheets) {
    const built = [];
    for (const s of sheets) {
      const t = buildTable(s.rows);
      if (t && t.records.length) built.push({ sheetName: s.name, table: t });
    }
    if (!built.length) return null;

    const isTaskCat = (b) => /task\s*categor/i.test(b.sheetName);
    const hit = built.find(isTaskCat);
    if (hit) {
      return { ...hit, note: '（Task Categories = 各评分项实际成绩；已跳过 "Term Grades" 快照表）' };
    }
    // 没有 Task Categories：若只有一张就直接用；多张则取最后一张（导出的第二页通常是明细）
    const picked = built.length === 1 ? built[0] : built[built.length - 1];
    return { ...picked, note: '⚠ 未找到 "Task Categories" 工作表，已改用「' + picked.sheetName + '」' };
  }

  // ===================== 页面扫描：学生卡片 =====================
  const NAME_ANCHOR_RE = /\/teacher\/(users|students)\/\d+/;
  // 可写的控件：文本输入、多行文本、下拉（Term Grades 的评分项可能是 Criteria 下拉）
  const CTRL_SEL = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="file"]), textarea, select';

  function nameAnchors(root) {
    return [...(root || document).querySelectorAll('a[href]')]
      .filter((a) => NAME_ANCHOR_RE.test(a.getAttribute('href') || ''));
  }

  function controlsIn(el) {
    return [...el.querySelectorAll(CTRL_SEL)].filter((i) => !i.disabled && i.type !== 'hidden');
  }

  // 从姓名锚点往上找到「装这个学生的控件、且只含一个姓名锚点」的最小容器
  // 兼容两种布局：① 每个学生一张卡片 ② 表格里每个学生一行（<tr>）
  function cardForAnchor(a) {
    // 表格布局：优先用 <tr> 当卡片边界（最贴合语义）
    const tr = a.closest('tr');
    if (tr) {
      const ctrls = controlsIn(tr);
      const hrefs = uniq(nameAnchors(tr).map((x) => x.getAttribute('href')));
      if (ctrls.length && hrefs.length === 1) return { card: tr, nameEl: a, inputs: ctrls };
    }
    let el = a;
    let fallback = null;
    for (let depth = 0; depth < 14; depth++) {
      el = el.parentElement;
      if (!el || el === document.body || el === document.documentElement) break;
      const ctrls = controlsIn(el);
      if (!ctrls.length) continue;
      const hrefs = uniq(nameAnchors(el).map((x) => x.getAttribute('href')));
      if (hrefs.length === 1) return { card: el, nameEl: a, inputs: ctrls };
      if (hrefs.length > 1) return fallback;   // 走过头了：退回上一级
      fallback = { card: el, nameEl: a, inputs: ctrls };
    }
    return fallback;
  }

  // 页面上的学生卡片（去重、按 DOM 顺序）
  function detectCards() {
    const out = [];
    const seen = new Set();
    for (const a of nameAnchors(document)) {
      const got = cardForAnchor(a);
      if (!got) continue;
      if (seen.has(got.card)) continue;
      seen.add(got.card);
      out.push({ ...got, nameText: cardNameText(got.nameEl) });
    }
    return out;
  }

  // 姓名文本：锚点文本 + 最近容器文本（去掉 "Progress" 等噪声）
  function cardNameText(a) {
    const anchor = (a.textContent || '').replace(/\s+/g, ' ').trim();
    const near = (() => {
      let el = a.parentElement;
      for (let i = 0; i < 3 && el; i++, el = el.parentElement) {
        const t = (el.textContent || '').replace(/Progress/g, ' ').replace(/\s+/g, ' ').trim();
        if (t && t.length <= 90) return t;
      }
      return '';
    })();
    return anchor.length >= near.length ? anchor : near;
  }

  // 字段标签候选（用于和导出表的列名对上）
  function fieldLabels(el) {
    const cands = [];
    const push = (s) => {
      const t = (s || '').replace(/\s+/g, ' ').trim();
      if (t && t.length <= 90 && !cands.includes(t)) cands.push(t);
    };
    push(el.getAttribute('aria-label'));
    push(el.getAttribute('placeholder'));
    push(el.getAttribute('title'));
    push(el.getAttribute('name'));
    push(el.id);
    const lab = el.closest('label');
    if (lab) push(lab.textContent);
    if (el.id) {
      try {
        const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (l) push(l.textContent);
      } catch { /* ignore */ }
    }
    let p = el.previousElementSibling, n = 0;
    while (p && n < 2) { push(p.textContent); p = p.previousElementSibling; n++; }
    const par = el.parentElement;
    if (par) {
      // 父容器文本（去掉输入值本身，避免把分数当标签）
      const clone = par.cloneNode(true);
      clone.querySelectorAll('input,textarea,select,button').forEach((x) => x.remove());
      push(clone.textContent);
    }
    const td = el.closest('td,th');
    if (td) {
      const tr = td.closest('tr');
      const table = td.closest('table');
      if (table && tr) {
        const idx = [...tr.children].indexOf(td);
        const th = table.querySelector('thead tr')?.children?.[idx];
        if (th) push(th.textContent);
      }
    }
    return cands;
  }

  // ===================== 列 ↔ 字段 的匹配 =====================
  // 同义词归并：导出的列名和页面标签常不同（如 Mid-term/Mock vs Mock Exam/Mid-term Exam）
  const SYN = [
    [/intra[\s-]*unit/i, 'intraunit'],
    [/end\s*of\s*unit/i, 'endofunit'],
    [/end\s*of\s*term|final\s*exam/i, 'endofterm'],
    [/mid[\s-]*term|mock/i, 'mock'],
    [/target/i, 'target'],
    [/ethos|attendance|effort/i, 'ethos'],
    [/final\s*grade|overall/i, 'finalgrade'],
    [/average|total\s*score|percent/i, 'average'],
    [/comment/i, 'comment'],
  ];
  function canon(s) {
    const t = ascii(s);
    for (const [re, tag] of SYN) if (re.test(t)) return tag;
    return norm(t);
  }
  // 两个标签的相似度 0..1
  function labelScore(colName, label) {
    const a = canon(colName), b = canon(label);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length >= 4 && b.includes(a)) return 0.9;
    if (b.length >= 4 && a.includes(b)) return 0.85;
    const at = new Set(norm(colName).split(' ').filter(Boolean));
    const bt = new Set(norm(label).split(' ').filter(Boolean));
    if (!at.size || !bt.size) return 0;
    let hit = 0;
    for (const t of at) if (bt.has(t)) hit++;
    return (hit / Math.max(at.size, bt.size)) * 0.7;
  }

  // 给某张卡片的输入框打分，返回 [{el, labels, best}]
  function describeFields(card) {
    return card.inputs.map((el, i) => {
      const labels = fieldLabels(el);
      return { el, index: i, labels };
    });
  }
  // 字段稳定签名：用于记住「手动绑定」与「上次自动映射」
  function fieldSig(f) {
    const el = f.el;
    return [
      el.getAttribute('name') || '',
      el.id || '',
      norm(f.labels[0] || ''),
    ].join('|');
  }

  // ===================== 写值（真实输入 + 回读校验） =====================
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) || {}, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  // 尽量模拟「人打字」：先全选，再用 insertText 覆盖；失败退回原生 setter + InputEvent
  async function typeInto(el, value) {
    el.focus({ preventScroll: true });
    try { el.select(); } catch { /* ignore */ }
    let typed = false;
    try { typed = document.execCommand('insertText', false, value); } catch { typed = false; }
    if (!typed || el.value !== value) {
      setNativeValue(el, value);
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      } catch {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value === value;
  }

  // ---- 下拉框（Criteria 类评分项常见） ----
  // 在 <select> 的 option 里找目标值：先精确匹配，再按「等第值出现在 option 文本里」匹配
  function findOption(sel, value) {
    const opts = [...sel.options];
    const normOpt = (o) => norm(o.textContent) || norm(o.value);
    const v = norm(value);
    let hit = opts.find((o) => norm(o.value) === v || normOpt(o) === v);
    if (hit) return hit;
    // "C (60%)" 这类：等第字母 + 说明，取开头的等第
    const head = (norm(value).match(/^[a-u]\*?/) || [])[0];
    if (head) {
      hit = opts.find((o) => normOpt(o) === head);
      if (hit) return hit;
      hit = opts.find((o) => normOpt(o).startsWith(head + ' ') || normOpt(o).startsWith(head + '('));
      if (hit) return hit;
    }
    // 宽松：option 文本包含该值（>=2 字符，避免单字母乱命中）
    if (v.length >= 2) {
      hit = opts.find((o) => normOpt(o).includes(v));
      if (hit) return hit;
    }
    return null;
  }

  async function selectInto(sel, value) {
    const opt = findOption(sel, value);
    if (!opt) return { ok: false, reason: 'no-option', options: [...sel.options].map((o) => (o.textContent || '').trim()).filter(Boolean).slice(0, 20) };
    sel.focus({ preventScroll: true });
    // 原生 setter + change 事件：让框架（React/Vue/jQuery）收到变化
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (desc && desc.set) desc.set.call(sel, opt.value); else sel.value = opt.value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, picked: (opt.textContent || '').trim() };
  }

  const isSelect = (el) => el instanceof HTMLSelectElement || el.tagName === 'SELECT';
  const currentValue = (el) => (isSelect(el)
    ? (el.selectedOptions && el.selectedOptions[0] ? (el.selectedOptions[0].textContent || '').trim() : el.value)
    : el.value);

  // 写入并回读确认；失败自动补写一次（页面基线可能还没就绪）
  async function writeField(el, value, opts) {
    const settle = (opts && opts.settle) || 700;

    if (isSelect(el)) {
      const r = await selectInto(el, value);
      if (!r.ok) return { ok: false, tries: 1, reason: r.reason, options: r.options };
      el.blur();
      await sleep(settle);
      const got = currentValue(el);
      const okNow = norm(got) === norm(value) || norm(got).startsWith(norm(value)) || norm(value).startsWith(norm(got));
      if (okNow) return { ok: true, tries: 1 };
      await sleep(400);
      const r2 = await selectInto(el, value);
      if (!r2.ok) return { ok: false, tries: 2, reason: r2.reason, options: r2.options };
      el.blur();
      await sleep(settle);
      return { ok: true, tries: 2 };
    }

    await typeInto(el, value);
    el.blur();
    await sleep(settle);
    if (el.value === value) return { ok: true, tries: 1 };
    // 补写一次（有些页面首格会被"基线"吞掉）
    await sleep(400);
    await typeInto(el, value);
    el.blur();
    await sleep(settle);
    return { ok: el.value === value, tries: 2 };
  }

  // ===================== 面板 =====================
  const box = document.createElement('div');
  box.id = 'mb-tg-panel';
  box.style.cssText = [
    'position:fixed', 'left:16px', 'bottom:16px', 'z-index:2147483646', 'width:420px',
    'background:#fff', 'border:1px solid #c9d2e0', 'border-radius:8px',
    'box-shadow:0 8px 24px rgba(0,0,0,.18)', 'font:13px/1.5 system-ui,sans-serif', 'color:#1f2d3d',
  ].join(';');
  box.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:#f4f7fb;border-bottom:1px solid #e3e9f2;border-radius:8px 8px 0 0">
      <strong style="flex:1">Term Grades 等第填入</strong>
      <button id="mbtg-fold" title="折叠/展开" style="border:0;background:transparent;cursor:pointer;font-size:16px">–</button>
    </div>
    <div id="mbtg-body" style="padding:10px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <label style="font-size:12px;color:#2563eb;cursor:pointer">导入 TermGrades.xlsx
          <input id="mbtg-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style="display:none">
        </label>
        <span id="mbtg-info" style="font-size:12px;color:#5b6b82">未导入</span>
        <button id="mbtg-clear" title="清空已导入的表（本页内存）" style="border:1px solid #c9d2e0;background:#fff;color:#b91c1c;border-radius:4px;font-size:11px;padding:1px 6px;cursor:pointer">清空</button>
      </div>

      <div id="mbtg-cols-wrap" style="display:none;margin-bottom:8px">
        <div style="font-size:12px;color:#5b6b82;margin-bottom:4px">要填的列（取消勾选即跳过）：</div>
        <div id="mbtg-cols" style="display:flex;flex-wrap:wrap;gap:4px 10px"></div>
      </div>

      <div style="display:flex;gap:6px;margin-bottom:8px">
        <button id="mbtg-dry" style="flex:1;padding:6px 10px;border:1px solid #c9d2e0;border-radius:6px;background:#fff;cursor:pointer">预演</button>
        <button id="mbtg-run" style="flex:1;padding:6px 10px;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer">填入本页</button>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:8px">
        <button id="mbtg-follow" style="flex:1;padding:5px 8px;border:1px solid #c9d2e0;border-radius:6px;background:#fff;cursor:pointer">自动跟随：关</button>
        <button id="mbtg-probe" style="flex:1;padding:5px 8px;border:1px solid #c9d2e0;border-radius:6px;background:#fff;cursor:pointer">探查结构</button>
      </div>
      <div id="mbtg-map-wrap" style="display:none;margin-bottom:8px;padding:6px;border:1px dashed #c9d2e0;border-radius:6px">
        <div style="font-size:12px;color:#5b6b82;margin-bottom:4px">手动绑定：先点下面按钮，再点页面上那个输入框</div>
        <div style="display:flex;gap:6px">
          <button id="mbtg-pick" style="padding:4px 8px;border:1px solid #c9d2e0;border-radius:4px;background:#fff;cursor:pointer">点选绑定</button>
          <select id="mbtg-pick-col" style="flex:1;font-size:12px;border:1px solid #c9d2e0;border-radius:4px;padding:2px"></select>
        </div>
      </div>

      <pre id="mbtg-log" style="margin:0;max-height:230px;overflow:auto;white-space:pre-wrap;font:12px/1.5 ui-monospace,Consolas,monospace;background:#f8fafc;border:1px solid #e3e9f2;border-radius:6px;padding:6px"></pre>
    </div>`;
  document.body.appendChild(box);

  const $ = (id) => box.querySelector('#' + id);
  const FILE = $('mbtg-file');
  const INFO = $('mbtg-info');
  const LOG = $('mbtg-log');
  const COLS = $('mbtg-cols');
  const COLS_WRAP = $('mbtg-cols-wrap');
  const MAP_WRAP = $('mbtg-map-wrap');
  const PICK_COL = $('mbtg-pick-col');
  const FOLLOW_BTN = $('mbtg-follow');

  const log = (s) => {
    LOG.textContent += s + '\n';
    LOG.scrollTop = LOG.scrollHeight;
  };
  const logClear = () => { LOG.textContent = ''; };

  // ===================== 运行状态 =====================
  let TABLE = null;              // { columns, records }
  let selectedCols = new Set();  // 勾选的列 index
  let manualMap = {};            // 字段签名 → 列 index（手动绑定，持久化）
  let followTimer = null;        // 自动跟随
  let lastFollowedKey = '';      // 自动跟随：上次填过的学生

  const settings = store.get(SETTINGS_KEY, { selected: [], manual: {} });
  manualMap = settings.manual || {};

  function persist() {
    // 列名存下来（下标会随表结构变化，不能用来恢复）
    const names = TABLE
      ? [...selectedCols].map((i) => (TABLE.columns.find((c) => c.index === i) || {}).name).filter(Boolean)
      : [];
    store.set(SETTINGS_KEY, { selected: names, manual: manualMap });
  }

  // ===================== 导入 =====================
  FILE.addEventListener('change', async () => {
    const f = FILE.files && FILE.files[0];
    if (!f) return;
    INFO.textContent = '读取中…';
    try {
      const sheets = await readXlsxSheets(await f.arrayBuffer());
      const built = pickSheet(sheets);
      if (!built) {
        INFO.textContent = '❌ 没找到带 Student ID 表头的工作表';
        log('❌ 解析失败：没找到含「Student ID」表头的工作表。请确认导出的是 Term Grades 表。');
        return;
      }
      TABLE = built.table;
      // 默认勾选：全部可填列（用户可再取消）
      selectedCols = new Set(TABLE.columns.map((c) => c.index));
      INFO.textContent = `✅ ${TABLE.records.length} 人 · ${TABLE.columns.length} 列（${built.sheetName}）`;
      renderCols();
      renderPickCols();
      MAP_WRAP.style.display = '';
      logClear();
      log(`已导入「${built.sheetName}」：${TABLE.records.length} 名学生，可填列 ${TABLE.columns.length} 个`);
      if (built.note) log(built.note);
      log('可填列：' + TABLE.columns.map((c) => c.name).join(' · '));
      log('下一步：点「预演」，核对匹配结果后再「填入本页」。');
    } catch (e) {
      INFO.textContent = '❌ 解析失败';
      log('❌ 解析失败：' + ((e && e.message) ? e.message : String(e)));
    } finally {
      FILE.value = '';
    }
  });

  $('mbtg-clear').addEventListener('click', () => {
    TABLE = null;
    selectedCols = new Set();
    INFO.textContent = '未导入';
    COLS_WRAP.style.display = 'none';
    MAP_WRAP.style.display = 'none';
    logClear();
    log('已清空本次导入（不影响已记住的勾选与绑定）。');
  });

  function renderCols() {
    COLS.innerHTML = '';
    COLS_WRAP.style.display = '';
    for (const c of TABLE.columns) {
      const id = 'mbtg-c' + c.index;
      const lab = document.createElement('label');
      lab.style.cssText = 'font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = id;
      cb.checked = selectedCols.has(c.index);
      cb.addEventListener('change', () => {
        if (cb.checked) selectedCols.add(c.index); else selectedCols.delete(c.index);
        persist();
      });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(c.name));
      COLS.appendChild(lab);
    }
  }

  function renderPickCols() {
    PICK_COL.innerHTML = '';
    if (!TABLE) return;
    for (const c of TABLE.columns) {
      const o = document.createElement('option');
      o.value = String(c.index);
      o.textContent = c.name;
      PICK_COL.appendChild(o);
    }
  }

  // ===================== 预演 / 填入 =====================
  // 对一张卡片：算出 字段 → 列 的映射
  function mapCard(card) {
    const fields = describeFields(card);
    const used = new Set();
    const plan = [];   // {col, field, value, score, via}
    for (const c of TABLE.columns) {
      if (!selectedCols.has(c.index)) continue;
      // ① 手动绑定优先
      let hit = null, via = '';
      for (const f of fields) {
        if (used.has(f.el)) continue;
        if (manualMap[fieldSig(f)] === c.index) { hit = f; via = '手动'; break; }
      }
      // ② 自动按标签匹配
      if (!hit) {
        let best = null, bestSc = 0;
        for (const f of fields) {
          if (used.has(f.el)) continue;
          let sc = 0;
          for (const lab of f.labels) sc = Math.max(sc, labelScore(c.name, lab));
          if (sc > bestSc) { bestSc = sc; best = f; }
        }
        if (best && bestSc >= 0.5) { hit = best; via = '标签'; }
      }
      if (hit) { used.add(hit.el); plan.push({ col: c, field: hit, via }); }
    }
    return { fields, plan };
  }

  // 在导出表里认这张卡片对应的学生
  function matchRecord(card) {
    // 反查：拿导出的每个学生去和这张卡片的姓名比
    let best = null, bestScore = 0, cands = [];
    const cardParsed = parseMBName(card.nameText);
    for (const r of TABLE.records) {
      let sc = 0;
      for (const cand of nameCandidates(r)) sc = Math.max(sc, scoreMatch(cand, cardParsed));
      if (sc > bestScore) { bestScore = sc; best = r; cands = [r]; }
      else if (sc === bestScore && sc > 0) cands.push(r);
    }
    return bestScore > 0
      ? { rec: best, ties: cands.length, candidates: cands, score: bestScore }
      : { rec: null, ties: 0, candidates: [], score: 0 };
  }

  async function run(dry) {
    logClear();
    if (!TABLE) { log('❌ 先导入 TermGrades.xlsx'); return; }
    if (!selectedCols.size) { log('❌ 至少勾选一列'); return; }

    const cards = detectCards();
    if (!cards.length) {
      log('❌ 没识别到学生卡片。');
      log('   可能原因：① 本页不是 Term Grades；② 页面还没加载完（稍等再试）；');
      log('   ③ 卡片里没有 /teacher/users/<id> 这类链接 —— 请点「探查结构」把结果发我。');
      return;
    }
    log(`识别到 ${cards.length} 张学生卡片${dry ? '（预演，不写入）' : ''}`);

    let okCards = 0, okFields = 0, failFields = 0;
    const problems = [];

    for (const card of cards) {
      const m = matchRecord(card);
      if (!m.rec) {
        problems.push(`⚠ 卡片「${clampText(card.nameText, 40)}」在表里没匹配到学生`);
        continue;
      }
      if (m.ties > 1) {
        problems.push(`⚠ 卡片「${clampText(card.nameText, 40)}」匹配到 ${m.ties} 个同名候选人，已跳过（请手动绑定）`);
        continue;
      }
      const { plan } = mapCard(card);
      if (!plan.length) {
        problems.push(`⚠ ${m.rec.last} ${m.rec.first}：卡片里没找到能对上的输入框（试试「点选绑定」）`);
        continue;
      }

      log(`\n【${m.rec.last} ${m.rec.first}${m.rec.pref ? ' (' + m.rec.pref + ')' : ''}】← 卡片「${clampText(card.nameText, 30)}」`);
      let cardWrote = 0;
      for (const p of plan) {
        const cv = cleanValue(m.rec.values[p.col.index]);
        if (cv.skip) { log(`   · ${p.col.name}: ${cv.reason}，跳过`); continue; }
        if (dry) {
          // 下拉框顺手校验：值不在选项里要提前说，别等到写的时候才失败
          let note = '';
          if (isSelect(p.field.el)) {
            const opt = findOption(p.field.el, cv.value);
            note = opt ? '（下拉）' : '  ⚠ 下拉里没有这个选项';
          }
          log(`   · ${p.col.name} → ${cv.value}  [${p.via}]${note}`);
          cardWrote++;
          continue;
        }
        const r = await writeField(p.field.el, cv.value);
        if (r.ok) {
          log(`   · ${p.col.name} → ${cv.value}  ✅  [${p.via}]`);
          cardWrote++; okFields++;
        } else if (r.reason === 'no-option') {
          log(`   · ${p.col.name} → ${cv.value}  ❌ 下拉里没有该选项`);
          log(`       可选值：${(r.options || []).join(' / ') || '（空）'}`);
          failFields++;
        } else {
          log(`   · ${p.col.name} → ${cv.value}  ❌ 回读不一致（写了 ${r.tries} 次）  [${p.via}]`);
          failFields++;
        }
      }
      if (cardWrote) okCards++;
    }

    log(`\n完成：${dry ? '可填' : '已写'} ${okCards} 名学生${dry ? '' : `，成功 ${okFields} 格，失败 ${failFields} 格`}`);
    if (problems.length) log('\n' + problems.join('\n'));
    if (!dry && failFields) {
      log('\n提示：回读不一致的格子，通常是页面保存脚本还没就绪。');
      log('      等几秒再点一次「填入本页」即可补上（重复填同一个值是无害的）。');
    }
  }

  $('mbtg-dry').addEventListener('click', () => void run(true));
  $('mbtg-run').addEventListener('click', () => void run(false));

  // ===================== 自动跟随（页面一次只显示一个学生时用） =====================
  function currentStudentKey() {
    const cards = detectCards();
    if (cards.length !== 1) return '';
    return norm(cards[0].nameText);
  }

  async function followTick() {
    if (!TABLE) return;
    const cards = detectCards();
    if (cards.length !== 1) return;         // 多卡片同页 → 用「填入本页」
    const key = norm(cards[0].nameText);
    if (!key || key === lastFollowedKey) return;
    lastFollowedKey = key;
    await run(false);
  }

  FOLLOW_BTN.addEventListener('click', () => {
    if (followTimer) {
      clearInterval(followTimer);
      followTimer = null;
      FOLLOW_BTN.textContent = '自动跟随：关';
      FOLLOW_BTN.style.background = '#fff';
      log('自动跟随已关闭。');
      return;
    }
    if (!TABLE) { log('❌ 先导入 TermGrades.xlsx'); return; }
    lastFollowedKey = '';
    followTimer = setInterval(() => void followTick(), 1200);
    FOLLOW_BTN.textContent = '自动跟随：开';
    FOLLOW_BTN.style.background = '#dcfce7';
    log('自动跟随已开启：你切换到下一个学生时，脚本会自动填这一张卡片。');
  });

  // ===================== 手动绑定：点选页面上某个输入框 =====================
  let picking = false;
  $('mbtg-pick').addEventListener('click', () => {
    if (!TABLE) { log('❌ 先导入 TermGrades.xlsx'); return; }
    picking = true;
    log('请在页面上点那个要绑定的输入框…');
  });

  document.addEventListener('click', (ev) => {
    if (!picking) return;
    const el = ev.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    if (box.contains(el)) return;
    ev.preventDefault();
    ev.stopPropagation();
    picking = false;
    const colIdxWanted = Number(PICK_COL.value);
    const col = TABLE.columns.find((c) => c.index === colIdxWanted);
    if (!col) { log('❌ 没选列'); return; }
    // 找到这个输入框所属的卡片，用它的字段签名登记
    const cards = detectCards();
    const card = cards.find((c) => c.card.contains(el));
    if (!card) { log('❌ 这个输入框不在识别到的学生卡片里'); return; }
    const f = describeFields(card).find((x) => x.el === el);
    if (!f) { log('❌ 没定位到字段'); return; }
    manualMap[fieldSig(f)] = col.index;
    persist();
    el.style.outline = '2px solid #16a34a';
    setTimeout(() => { el.style.outline = ''; }, 1500);
    log(`✅ 已绑定：${col.name} ← 字段「${clampText(f.labels[0] || f.el.name || f.el.id, 40)}」`);
    log('   绑定会记住，并套用到同结构的其他学生卡片。');
  }, true);

  // ===================== 结构探查 =====================
  $('mbtg-probe').addEventListener('click', async () => {
    const cards = detectCards();
    const data = {
      url: location.href,
      title: document.title,
      inputCount: document.querySelectorAll(CTRL_SEL).length,
      nameAnchorCount: nameAnchors(document).length,
      cards: cards.map((c) => ({
        nameText: c.nameText,
        cardTag: c.card.tagName,
        cardId: c.card.id || '',
        cardClass: (c.card.className || '').toString().slice(0, 160),
        inputs: describeFields(c).map((f) => ({
          tag: f.el.tagName,
          type: f.el.type || '',
          id: f.el.id || '',
          name: f.el.getAttribute('name') || '',
          valueLen: (f.el.value || '').length,
          options: isSelect(f.el) ? [...f.el.options].map((o) => (o.textContent || '').trim()).filter(Boolean).slice(0, 15) : undefined,
          labels: f.labels.slice(0, 6).map((s) => clampText(s, 60)),
        })),
      })),
      // 页面上所有输入框的粗描（当卡片没识别出来时看这个）
      allInputs: [...document.querySelectorAll(CTRL_SEL)].slice(0, 60).map((el) => ({
        id: el.id || '',
        name: el.getAttribute('name') || '',
        type: el.type || '',
        aria: el.getAttribute('aria-label') || '',
        placeholder: el.getAttribute('placeholder') || '',
        valueLen: (el.value || '').length,
        ancestors: (() => {
          const out = [];
          let p = el.parentElement, n = 0;
          while (p && n < 5) { out.push(p.tagName.toLowerCase() + (p.className ? '.' + String(p.className).split(/\s+/).slice(0, 3).join('.') : '')); p = p.parentElement; n++; }
          return out;
        })(),
      })),
      tables: [...document.querySelectorAll('table')].slice(0, 6).map((t) => ({
        cls: (t.className || '').toString().slice(0, 100),
        headers: [...t.querySelectorAll('thead th')].map((th) => clampText(th.textContent, 40)),
        rowCount: t.querySelectorAll('tbody tr').length,
      })),
    };
    const text = JSON.stringify(data, null, 2);
    let copied = false;
    try {
      if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); copied = true; }
      else if (navigator.clipboard) { await navigator.clipboard.writeText(text); copied = true; }
    } catch { copied = false; }
    logClear();
    log(`探查完成：卡片 ${data.cards.length} 张，输入框 ${data.inputCount} 个，姓名链接 ${data.nameAnchorCount} 个`);
    log(copied ? '✅ 结构 JSON 已复制到剪贴板，请发给我。' : '⚠ 复制失败，请从下面手动复制。');
    if (!copied) { LOG.textContent += '\n' + text; }
  });

  // 折叠
  $('mbtg-fold').addEventListener('click', () => {
    const b = $('mbtg-body');
    b.style.display = b.style.display === 'none' ? 'block' : 'none';
  });

  // ===================== 面板存活 / 只在 Term Grades 页展开 =====================
  // ManageBac 是客户端路由，跳页时面板可能被整块替换，因此持续巡检并挂回。
  //
  // 【硬性条件】URL 必须落在 term-grades 页面，否则一律收起。
  //   实测路由形态（401 = 存在，404 = 不存在）：
  //     ✔ /teacher/classes/<id>/gradebook/term/<termId>/term-grades
  //     ✔ /teacher/classes/<id>/gradebook/term-grades
  //     ✘ /teacher/classes/<id>/gradebook/term/<termId>/term_grades   ← 下划线是 404
  //   所以判定用 /term-grades/（连字符），不要写成 term_grades。
  const onTermGradesUrl = () => /term-grades/i.test(location.pathname + location.search);

  // 在 URL 命中的前提下，再确认页面确实有可填的控件（避免页面还没渲染时误展开）
  const looksLikeTermGrades = () => {
    if (!onTermGradesUrl()) return false;
    const cards = detectCards();
    if (cards.length && cards.some((c) => c.inputs.length >= 2)) return true;
    return document.querySelectorAll(CTRL_SEL).length >= 2;
  };

  let offTicks = 0;
  const sync = () => {
    if (!box.isConnected && document.body) document.body.appendChild(box);
    if (looksLikeTermGrades()) {
      offTicks = 0;
      box.style.display = '';
    } else if (++offTicks >= 3) {
      box.style.display = 'none';
    }
  };
  setInterval(sync, 900);
  ['turbo:load', 'turbo:render', 'turbo:frame-load', 'pjax:end'].forEach((ev) => document.addEventListener(ev, sync));
  window.addEventListener('popstate', sync);
  ['pushState', 'replaceState'].forEach((m) => {
    const orig = history[m];
    history[m] = function (...args) {
      const r = orig.apply(this, args);
      sync();
      return r;
    };
  });
  sync();

  // 恢复上次勾选的列：按「列名」记，而不是下标 —— 表结构变了也不会错配
  if (settings.selected && settings.selected.length) {
    const want = new Set(settings.selected.map((s) => canon(s)));
    const hit = TABLE ? TABLE.columns.filter((c) => want.has(canon(c.name))) : [];
    if (hit.length) {
      selectedCols = new Set(hit.map((c) => c.index));
      renderCols();
    }
  }
})();
