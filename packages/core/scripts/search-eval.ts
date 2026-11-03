/**
 * Måler personsøket mot vurderte treff, så endringer i rangeringen er målt og
 * ikke gjettet. Se README, «Personsøk».
 *
 *   pnpm search:eval                 # måler alle søkene i vurderingene
 *   pnpm search:eval --vurder        # skriver ut treff som ikke er vurdert ennå
 *   pnpm search:eval --detaljer      # viser treffene per søk
 *
 * Vurderingene ligger i `.data/search-eval.json` (persondata, committes aldri):
 *
 *   { "romfart": { "Ola Nordmann": 2, "Kari Nordmann": 0 }, … }
 *
 * 2: har jobbet med eller kan emnet. 1: i utkanten (studier, et prosjekt, en
 * ambisjon). 0: ikke relevant. Et søk med en tom liste måles bare på hva det
 * finner. Bare mot en lokal database (som `search:query`).
 */
import { existsSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createDb, loadRootEnv } from '@esaf/db'
import {
  createLocalEmbedder,
  defaultSearchModelDir,
  searchPeopleByTopic,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const { values } = parseArgs({
  options: {
    vurder: { type: 'boolean', default: false },
    detaljer: { type: 'boolean', default: false },
    fil: {
      type: 'string',
      default: new URL('../../../.data/search-eval.json', import.meta.url).pathname,
    },
    sok: { type: 'string' },
  },
})

const url = process.env.DATABASE_URL
if (!url) {
  console.error('Mangler DATABASE_URL.')
  process.exit(1)
}
const host = new URL(url).hostname
if (host !== 'localhost' && host !== '127.0.0.1') {
  console.error('Målingen er bare for en lokal database.')
  process.exit(1)
}
if (!existsSync(values.fil)) {
  console.error(`Fant ikke vurderingene i ${values.fil}.`)
  process.exit(1)
}

type Grades = Record<string, Record<string, number>>
const judged = JSON.parse(readFileSync(values.fil, 'utf8')) as Grades
const queries = Object.keys(judged).filter((q) => !values.sok || q === values.sok)

const db = createDb(url)
const embedder = createLocalEmbedder({ cacheDir: defaultSearchModelDir() })
const viewer: Viewer = {
  userId: 'cli',
  emailVerified: true,
  twoFactorEnabled: true,
  passkeySession: false,
  hasPasskey: false,
  personId: 'cli',
  membership: { status: 'active', role: 'owner' },
}

const K = 10
const dcg = (gains: number[]) => gains.reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0)

const rows: {
  q: string
  p: number
  ndcg: number
  recall: number
  wrong: number
  unjudged: number
}[] = []
const toJudge: Record<string, Record<string, string>> = {}

for (const q of queries) {
  const grades = judged[q]!
  const hits = await searchPeopleByTopic(db, viewer, q, { embedder, limit: 20 })
  const top = hits.slice(0, K)
  const grade = (name: string) => grades[name]
  const unjudged = hits.filter((h) => grade(h.fullName) === undefined)
  for (const h of unjudged)
    (toJudge[q] ??= {})[h.fullName] = `[${h.matchedBy}] ${h.reason?.slice(0, 220) ?? ''}`

  const judgedTop = top.filter((h) => grade(h.fullName) !== undefined)
  const ideal = Object.values(grades)
    .filter((g) => g > 0)
    .sort((a, b) => b - a)
    .slice(0, K)
  // Søk uten kjente svar («xyzzy») måles bare på feil treff. Et tomt svar på et
  // søk som har kjente svar, er ikke presist, det er feil.
  const p = judgedTop.length
    ? judgedTop.filter((h) => grade(h.fullName)! >= 1).length / judgedTop.length
    : ideal.length
      ? 0
      : NaN
  const ndcg = ideal.length ? dcg(top.map((h) => grade(h.fullName) ?? 0)) / dcg(ideal) : NaN
  const strong = Object.entries(grades).filter(([, g]) => g === 2)
  const found = new Set(hits.map((h) => h.fullName))
  const recall = strong.length ? strong.filter(([n]) => found.has(n)).length / strong.length : NaN
  const wrong = hits.filter((h) => grade(h.fullName) === 0).length
  rows.push({ q, p, ndcg, recall, wrong, unjudged: unjudged.length })

  if (values.detaljer) {
    console.log(`\n«${q}»`)
    for (const h of hits)
      console.log(
        `  ${grade(h.fullName) ?? '?'} ${h.fullName} [${h.matchedBy} ${h.score.toFixed(1)}] ${h.reason?.slice(0, 90) ?? ''}`,
      )
  }
}

if (values.vurder) {
  console.log(JSON.stringify(toJudge, null, 2))
} else {
  const pad = (s: string, n: number) => s.slice(0, n).padEnd(n)
  const f = (x: number) => (Number.isNaN(x) ? '   -' : x.toFixed(2))
  console.log(`\n${pad('søk', 34)} P@10  nDCG  funnet  feil  ikke vurdert`)
  for (const r of rows)
    console.log(
      `${pad(r.q, 34)} ${f(r.p)}  ${f(r.ndcg)}  ${f(r.recall).padStart(6)}  ${String(r.wrong).padStart(4)}  ${String(r.unjudged).padStart(4)}`,
    )
  const avg = (k: 'p' | 'ndcg' | 'recall') => {
    const xs = rows.map((r) => r[k]).filter((x) => !Number.isNaN(x))
    return xs.reduce((s, x) => s + x, 0) / (xs.length || 1)
  }
  const sum = (k: 'wrong' | 'unjudged') => rows.reduce((s, r) => s + r[k], 0)
  console.log(
    `${pad(`snitt (${rows.length} søk)`, 34)} ${f(avg('p'))}  ${f(avg('ndcg'))}  ${f(avg('recall')).padStart(6)}  ${String(sum('wrong')).padStart(4)}  ${String(sum('unjudged')).padStart(4)}`,
  )
}
await embedder.unload()
await db.close()
