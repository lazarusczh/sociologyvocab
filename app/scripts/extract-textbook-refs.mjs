#!/usr/bin/env node
/**
 * Stage A — extract cited works from the distilled textbook skill.
 *
 * READ-ONLY with respect to the running app: it only scans the local skill
 * chapter markdown files and writes an intermediate candidates JSON for
 * human review. No app source is touched.
 *
 * Usage:
 *   node app/scripts/extract-textbook-refs.mjs
 *   node app/scripts/extract-textbook-refs.mjs --src "D:/path/to/chapters"
 *   node app/scripts/extract-textbook-refs.mjs --merge app/data/refs-manual.json
 *   node app/scripts/extract-textbook-refs.mjs --out app/data/refs-candidates.json
 *
 * NOTE: keep this file pure ASCII (see project publish conventions).
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const DEFAULT_SRC = 'C:/Users/rebir/.agents/skills/9699textbook1/chapters'
const DEFAULT_OUT = 'app/data/refs-candidates.json'

// ---------------------------------------------------------------- args
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const SRC = resolve(arg('src', DEFAULT_SRC))
const OUT = resolve(arg('out', DEFAULT_OUT))
const MERGE = arg('merge', 'app/data/refs-manual.json')

const LB = '\u300a' // 《
const RB = '\u300b' // 》

// ---------------------------------------------------------------- rules
// Words that look like a capitalised surname but are not.
const STOP = new Set([
  'The', 'This', 'That', 'These', 'Those', 'There', 'Their', 'They', 'Then', 'Thus',
  'And', 'But', 'For', 'Not', 'All', 'Any', 'Are', 'Was', 'Were', 'Has', 'Have',
  'Part', 'Chapter', 'Unit', 'Section', 'Key', 'Core', 'Main', 'Anti', 'Worked',
  'Mental', 'Connects', 'Topic', 'Paper', 'Level', 'Note', 'Notes', 'See', 'Use',
  'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Describe', 'Explain', 'Evaluate',
  'Assess', 'Discuss', 'Define', 'Compare', 'Contrast', 'How', 'Why', 'What',
  'Most', 'More', 'Less', 'Some', 'Such', 'Both', 'Each', 'Other', 'Another',
  'First', 'Second', 'Third', 'Final', 'Next', 'Last', 'New', 'Old', 'Good',
  'Evidence', 'Example', 'Research', 'Theory', 'Study', 'Data', 'Figure', 'Table',
])

// Multi-word author names / institutional authors worth matching first.
const MULTIWORD = [
  'Glasgow Media Group', 'Vargas Llosa', 'Ha-Joon Chang', 'de Beauvoir',
  'El Saadawi', 'Van Dijk', 'David Morgan', 'Carol Smart', 'Stan Cohen',
]

const NAME = "[A-Z][A-Za-z'\u2019\\-]+"
// Bowles & Gintis | Bowles and Gintis | Bowles | Bowles et al.
const AUTHOR_RE = new RegExp(
  `(${NAME}(?:\\s*(?:&|and)\\s*${NAME})?(?:\\s+et\\s+al\\.)?)`
)
// multi-word names take priority over the generic pattern
const AUTHOR_ALT = new RegExp(
  `((?:${MULTIWORD.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})` +
    `|${NAME}(?:\\s*(?:&|and)\\s*${NAME})?(?:\\s+et\\s+al\\.)?)`
)
// (1976) | (1976/2005) | (1979; 2015)
const YEAR_RE = /\((\d{4})(?:\s*\/\s*(\d{2,4}))?(?:\s*;\s*(\d{4}))?\)/

const BOOK_RE = new RegExp(LB + '([^' + RB + ']{2,90})' + RB + '\\s*(?:\\((\\d{4})(?:\\s*\\/\\s*(\\d{2,4}))?(?:\\s*;\\s*(\\d{4}))?\\))?', 'g')

function normYear(y) {
  if (!y) return undefined
  const n = Number(y)
  if (n < 1800 || n > 2035) return undefined
  return n
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function surnameOf(author) {
  const first = author.split(/\s*(?:&|and)\s*|\s+et\s+al\./)[0].trim()
  const parts = first.split(/\s+/)
  return parts[parts.length - 1]
}

function isLikelyName(s) {
  const surn = surnameOf(s)
  if (STOP.has(surn)) return false
  if (surn.length < 3) return false
  return true
}

/**
 * Trim a greedy multi-word capture down to the real author:
 *   "Glasgow Media Group" -> "Glasgow Media Group"   (institutional author kept)
 *   "Unit Durkheim"       -> "Durkheim"              (STOP word dropped)
 */
function trimAuthor(s) {
  const words = s.trim().split(/\s+/)
  const out = []
  for (let i = words.length - 1; i >= 0; i--) {
    if (STOP.has(words[i])) break
    out.unshift(words[i])
  }
  return out.join(' ')
}

function cleanLine(s) {
  return s.replace(/\*\*/g, '').replace(/`/g, '').trim()
}

// ---------------------------------------------------------------- extract
const files = readdirSync(SRC)
  .filter((f) => /^ch\d\d[-_].*\.md$/i.test(f))
  .sort()

if (files.length === 0) {
  console.error('[refs] no chapter files matched in:', SRC)
  process.exit(1)
}

/** @type {Map<string, any>} */
const byKey = new Map()

function mergeInto(hit, rec) {
  for (const c of rec.chapters) {
    if (!hit.chapters.includes(c)) hit.chapters.push(c)
  }
  if (!hit.title && rec.title) hit.title = rec.title
  if (!hit.year && rec.year) hit.year = rec.year
  if (rec.year && hit.year && rec.year < hit.year) {
    // keep the earliest edition, remember the later one
    hit.yearAlt = hit.yearAlt && hit.yearAlt < hit.year ? hit.yearAlt : hit.year
    hit.year = rec.year
  }
  if (hit.type === 'unknown' && rec.type !== 'unknown') hit.type = rec.type
  if (!hit.authors.length && rec.authors.length) hit.authors = rec.authors
  if (hit.context.length < rec.context.length) hit.context = rec.context
  const rank = { low: 0, medium: 1, high: 2 }
  if ((rank[rec.confidence] || 0) > (rank[hit.confidence] || 0)) {
    hit.confidence = rec.confidence
    hit.citationRaw = rec.citationRaw
  }
}

function put(rec, keyOverride) {
  const key = keyOverride || rec._key
  const hit = byKey.get(key)
  if (hit) {
    mergeInto(hit, rec)
    return
  }
  byKey.set(key, rec)
}

for (const file of files) {
  const chapter = file.replace(/\.md$/i, '') // ch05-education
  const raw = readFileSync(SRC + '/' + file, 'utf8')
  const lines = raw.split(/\r?\n/)
  const text = cleanLine(raw)

  // ---- pass 1: 《title》 — strongest signal ----------------------------
  let m
  BOOK_RE.lastIndex = 0
  while ((m = BOOK_RE.exec(text)) !== null) {
    const title = m[1].trim()
    const idx = m.index
    const before = cleanLine(text.slice(Math.max(0, idx - 80), idx))
    const after = cleanLine(text.slice(idx, idx + 140))

    // author: try (a) plain name right before, (b) "Author (year)" right
    // before (e.g. "Dahl (1961)《Who Governs?》"), (c) after the title.
    let author
    let year = normYear(m[2])

    let bm = before.match(
      new RegExp('((?:' + NAME + '\\s+){0,3}' + NAME + '(?:\\s*(?:&|and)\\s*' + NAME + ')?)\\s*$')
    )
    if (bm) {
      const cand = trimAuthor(bm[1])
      if (isLikelyName(cand)) author = cand
    }
    if (!author) {
      bm = before.match(new RegExp(AUTHOR_ALT.source + '\\s*\\(\\d{4}[^)]*\\)\\s*$'))
      if (bm && isLikelyName(bm[1])) {
        author = trimAuthor(bm[1])
        if (!year) {
          const ym = before.match(/\((\d{4})[^)]*\)\s*$/)
          if (ym) year = normYear(ym[1])
        }
      }
    }
    if (!author) {
      const am = after.match(new RegExp(AUTHOR_ALT.source + '\\s*\\(\\d{4}'))
      if (am && isLikelyName(am[1])) author = trimAuthor(am[1])
    }
    if (!year) {
      const am = after.match(YEAR_RE)
      if (am) year = normYear(am[1])
    }
    if (!year) {
      const bm2 = before.match(YEAR_RE)
      if (bm2) year = normYear(bm2[1])
    }

    const ctxLine = lines.find((l) => cleanLine(l).includes(LB + title + RB)) || ''
    const key = slug((author ? surnameOf(author) : title) + '-' + (year || 'nd'))
    put({
      _key: key,
      id: key,
      chapters: [chapter],
      citationRaw: cleanLine((author ? author + ' ' : '') + LB + title + RB + (year ? ' (' + year + ')' : '')),
      authors: author ? [author] : [],
      year,
      title,
      type: 'book',
      context: cleanLine(ctxLine).slice(0, 300),
      verified: false,
      confidence: author && year ? 'high' : 'medium',
      source: 'auto',
    })
  }

  // ---- pass 2: Author (year) ------------------------------------------
  const CITE_RE = new RegExp(AUTHOR_ALT.source + '\\s*\\((\\d{4})(?:\\s*\\/\\s*(\\d{2,4}))?(?:\\s*;\\s*(\\d{4}))?\\)', 'g')
  while ((m = CITE_RE.exec(text)) !== null) {
    const author = trimAuthor(m[1])
    const year = normYear(m[2])
    if (!year || !isLikelyName(author)) continue

    const idx = m.index
    const before = cleanLine(text.slice(Math.max(0, idx - 40), idx))
    // skip if this citation is already covered by a 《title》 in the same spot
    if (new RegExp(LB + '$').test(before)) continue

    const rawMatch = m[0]
    const ctxLine = lines.find((l) => cleanLine(l).includes(rawMatch)) || ''
    const key = slug(surnameOf(author) + '-' + year)
    put({
      _key: key,
      id: key,
      chapters: [chapter],
      citationRaw: cleanLine(rawMatch),
      authors: [author],
      year,
      title: undefined,
      type: 'unknown',
      context: cleanLine(ctxLine).slice(0, 300),
      verified: false,
      confidence: 'medium',
      source: 'auto',
    })
  }
}

// ---- pass 3: collapse the same title appearing with different years ----
// (e.g. Durkheim 《Suicide》 1897 / 1975 / no-year -> one entry)
for (const rec of [...byKey.values()]) {
  if (!rec.title || rec.title.length < 4) continue
  const tkey = 't-' + slug(rec.title)
  if (tkey === rec._key) continue
  const hit = byKey.get(tkey)
  if (hit) {
    mergeInto(hit, rec)
    byKey.delete(rec._key)
  } else {
    byKey.set(tkey, rec)
    byKey.delete(rec._key)
  }
}

// ---- pass 4: merge curated manual entries (survives re-runs) -----------
let manualCount = 0
if (MERGE && existsSync(MERGE)) {
  const manual = JSON.parse(readFileSync(MERGE, 'utf8'))
  for (const rec of manual.refs || manual) {
    const key = rec.id || slug((rec.authors?.[0] || rec.title || '') + '-' + (rec.year || 'nd'))
    rec.id = key
    rec.source = 'manual'
    rec.verified = rec.verified ?? false
    rec.chapters = rec.chapters || []
    rec.authors = rec.authors || []
    rec.context = rec.context || ''
    rec.confidence = rec.confidence || 'high'
    const hit = byKey.get(key)
    if (hit) mergeInto(hit, rec)
    else byKey.set(key, rec)
    manualCount++
  }
}

// ---------------------------------------------------------------- output
const refs = [...byKey.values()]
  .sort((a, b) => {
    const ca = a.chapters[0] || ''
    const cb = b.chapters[0] || ''
    if (ca !== cb) return ca < cb ? -1 : 1
    return (a.year || 9999) - (b.year || 9999)
  })
  .map((r) => {
    const { _key, ...rest } = r
    return rest
  })

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), source: SRC, refs }, null, 2), 'utf8')

// ---------------------------------------------------------------- report
const withTitle = refs.filter((r) => r.title).length
const byConf = refs.reduce((a, r) => ((a[r.confidence] = (a[r.confidence] || 0) + 1), a), {})
const byCh = refs.reduce((a, r) => {
  for (const c of r.chapters) a[c] = (a[c] || 0) + 1
  return a
}, {})

console.log('[refs] source   :', SRC)
console.log('[refs] chapters :', files.length)
console.log('[refs] written  :', OUT)
console.log('[refs] total    :', refs.length, manualCount ? '(incl. ' + manualCount + ' manual)' : '')
console.log('[refs] w/ title :', withTitle)
console.log('[refs] conf     :', JSON.stringify(byConf))
console.log('[refs] by chap  :', JSON.stringify(byCh))
console.log('\n--- entries with a title ---')
for (const r of refs.filter((x) => x.title)) {
  console.log(`  ${r.chapters.join(',').padEnd(34)} | ${r.citationRaw}`)
}
