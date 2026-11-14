#!/usr/bin/env node
// Stopper persondata fra kullisten og berikelsen før de havner i git.
//
// Leser navn, e-post og telefonnumre fra de lokale dataene i .data/enrichment/out (som aldri committes)
// og leter etter dem i det som skal committes. Finnes ikke dataene, som hos alle andre enn den som
// har kullisten, gjør skriptet ingenting.
//
//   node scripts/check-pii.mjs            linjene som er lagt til i staget endringer (pre-commit-hooken)
//   node scripts/check-pii.mjs --tree     alle filer i HEAD
//   node scripts/check-pii.mjs --history  alle versjoner av alle filer i alle grener
//
// Treffene skrives som fil og linje, aldri selve verdien.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const dataDir = join(root, '.data/enrichment/out')
const sources = ['people.json', 'staff.json'].map((f) => join(dataDir, f)).filter(existsSync)
if (sources.length === 0) process.exit(0)

// Filer som med vilje har ekte navn: styret står offentlig på esaf.no.
const ALLOWED_PATHS = new Set(['apps/site/src/board.ts'])

// Uten aksenter, så «Schüller» og «Schuller» er samme navn.
const norm = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
// Navn på organisasjoner som står i dataene sammen med personene.
const NOT_PEOPLE = /entrepren|alumniforening|ntnu|school/
const digits = (s) => s.replace(/\D/g, '').slice(-8)

const names = new Set()
const emails = new Set()
const phones = new Set()
for (const file of sources) {
  const rows = JSON.parse(readFileSync(file, 'utf8'))
  for (const row of Array.isArray(rows) ? rows : Object.values(rows)) {
    for (const n of [row.fullName, row.name, ...(row.nameVariants ?? [])]) {
      // To ord og minst åtte tegn, så vanlige ord og fornavn alene ikke gir treff.
      if (typeof n !== 'string' || n.trim().split(/\s+/).length < 2 || n.length < 8) continue
      if (!NOT_PEOPLE.test(norm(n))) names.add(norm(n.trim()))
    }
    for (const e of row.emails ?? []) if (typeof e === 'string') emails.add(norm(e))
    for (const p of row.phones ?? [])
      if (typeof p === 'string' && digits(p).length === 8) phones.add(digits(p))
  }
}
// Den som har dataene, står i dem selv. Eget navn og egen adresse er ikke en lekkasje.
const self = [
  spawnSync('git', ['config', 'user.name'], { encoding: 'utf8' }).stdout,
  spawnSync('git', ['config', 'user.email'], { encoding: 'utf8' }).stdout,
].map((s) => norm(s.trim()))
for (const s of self) {
  names.delete(s)
  emails.delete(s)
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const nameRe = names.size
  ? new RegExp(
      `(?<![\\p{L}])(?:${[...names]
        .sort((a, b) => b.length - a.length)
        .map(escape)
        .join('|')})(?![\\p{L}])`,
      'u',
    )
  : null
const emailRe = /[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[a-z]{2,}/giu
const phoneRe =
  /(?<![\d])(?:\+?47[ -]?)?(\d{3}[ -]?\d{2}[ -]?\d{3}|\d{2}[ -]?\d{2}[ -]?\d{2}[ -]?\d{2})(?!\d)/g

/** Hva som er funnet på én linje: 'navn', 'e-post', 'telefon'. */
function scanLine(line) {
  const text = norm(line)
  const found = []
  if (nameRe?.test(text)) found.push('navn')
  if ((text.match(emailRe) ?? []).some((e) => emails.has(e))) found.push('e-post')
  if ([...text.matchAll(phoneRe)].some((m) => phones.has(digits(m[1])))) found.push('telefon')
  return found
}

const hits = []
function scanText(path, text, lineOf = (i) => i + 1) {
  if (ALLOWED_PATHS.has(path.replace(/@[0-9a-f]+$/, ''))) return
  text.split('\n').forEach((line, i) => {
    const found = scanLine(line)
    if (found.length) hits.push(`${path}:${lineOf(i)}  ${found.join(', ')}`)
  })
}

const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 })
const mode = process.argv[2] ?? '--staged'

if (mode === '--staged') {
  let path = null
  let line = 0
  for (const l of git('diff', '--cached', '--unified=0', '--no-color', '--no-ext-diff').split(
    '\n',
  )) {
    if (l.startsWith('+++ ')) path = l.slice(6)
    else if (l.startsWith('@@')) line = Number(/\+(\d+)/.exec(l)?.[1] ?? 0)
    else if (l.startsWith('+') && path) {
      scanText(path, l.slice(1), () => line)
      line++
    }
  }
  // Commit-meldingen sjekkes av commit-msg-hooken.
} else if (mode === '--message') {
  const file = process.argv[3]
  scanText('commit-melding', readFileSync(file, 'utf8'))
} else if (mode === '--tree') {
  for (const path of git('ls-files', '-z').split('\0').filter(Boolean)) {
    const full = join(root, path)
    if (!existsSync(full)) continue
    const buf = readFileSync(full)
    if (buf.includes(0)) continue
    scanText(path, buf.toString('utf8'))
  }
} else if (mode === '--history') {
  const paths = new Map()
  for (const l of git('rev-list', '--all', '--objects').split('\n')) {
    const i = l.indexOf(' ')
    if (i > 0 && !paths.has(l.slice(0, i))) paths.set(l.slice(0, i), l.slice(i + 1))
  }
  // Alle objektene i én git-prosess: cat-file --batch skriver «<sha> <type> <størrelse>\n<innhold>\n».
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: [...paths.keys()].join('\n') + '\n',
    maxBuffer: 2 ** 31,
  })
  let at = 0
  while (at < out.length) {
    const nl = out.indexOf(10, at)
    const [sha, type, size] = out.subarray(at, nl).toString().split(' ')
    const body = out.subarray(nl + 1, nl + 1 + Number(size))
    at = nl + 1 + Number(size) + 1
    if (type === 'blob' && !body.includes(0))
      scanText(`${paths.get(sha)}@${sha.slice(0, 8)}`, body.toString('utf8'))
  }
  scanText('commit-meldinger', git('log', '--all', '--format=%B'))
} else {
  console.error(`Ukjent valg: ${mode}. Bruk --staged, --message <fil>, --tree eller --history.`)
  process.exit(2)
}

if (hits.length) {
  console.error('Persondata fra kullisten eller berikelsen funnet. Fjern dem før commit:\n')
  for (const h of hits) console.error(`  ${h}`)
  console.error('\nBruk oppdiktede navn og example.test-adresser i tester og eksempler.')
  process.exit(1)
}
