/**
 * Lager en frittstående forhåndsvisning av ES-universet fra en lokal database,
 * til `.data/mockups/es-universet-lokal.html` (gitignorert: inneholder navn).
 * Nekter alt annet enn localhost.
 *
 *   pnpm --filter @esaf/mcp preview:universe
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { getUniverse, type Viewer } from '@esaf/core'
import { createDb, loadRootEnv } from '@esaf/db'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

loadRootEnv()
const url = process.env.DATABASE_URL
if (!url || !['localhost', '127.0.0.1'].includes(new URL(url).hostname)) {
  console.error('Bare for en lokal database.')
  process.exit(1)
}
const root = fileURLToPath(new URL('..', import.meta.url))
const db = createDb(url)
const viewer: Viewer = {
  userId: 'preview',
  emailVerified: true,
  twoFactorEnabled: true,
  passkeySession: false,
  hasPasskey: false,
  personId: 'preview',
  membership: { status: 'active', role: 'owner' },
}
const full = await getUniverse(db, viewer)
await db.close()
// `--lett`: bare selskaper noen har startet eller hatt som ES-selskap, og
// arbeidsgivere med flere fra ES, med kortere tekster. Til å vise inline.
const light = process.argv.includes('--lett')
const keep = new Set(
  full.companies
    .filter((c) => {
      const own = full.links.filter((l) => l.companyId === c.id)
      return own.some((l) => l.role !== 'employee') || own.length >= 2
    })
    .map((c) => c.id),
)
const universe = light
  ? {
      ...full,
      companies: full.companies.filter((c) => keep.has(c.id)),
      links: full.links.filter((l) => keep.has(l.companyId)),
    }
  : full
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// Korte id-er, så fila blir liten nok til å vises inline.
const ids = new Map<string, string>()
const short = (id: string) => ids.get(id) ?? (ids.set(id, ids.size.toString(36)), ids.get(id)!)
const data = {
  ...universe,
  appUrl: 'http://localhost:3000',
  people: universe.people.map((p) => ({ ...p, id: short(p.id) })),
  companies: universe.companies.map((c) => ({
    ...c,
    id: short(c.id),
    tagline: c.tagline ? cut(c.tagline, light ? 70 : 140) : null,
    milestones: (light ? c.milestones.slice(-3) : c.milestones).map((m) => ({
      ...m,
      text: cut(m.text, light ? 70 : 160),
    })),
  })),
  links: universe.links.map((l) => ({
    ...l,
    personId: short(l.personId),
    companyId: short(l.companyId),
  })),
}
// Uten MCP-vert trengs ikke SDK-et; en tom erstatning holder fila liten.
const result = await build({
  entryPoints: [`${root}views/universe.ts`],
  bundle: true,
  write: false,
  format: 'iife',
  minify: true,
  plugins: [
    {
      name: 'stub-ext-apps',
      setup(b) {
        b.onResolve({ filter: /^@modelcontextprotocol\/ext-apps$/ }, () => ({
          path: 'stub',
          namespace: 'stub',
        }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class App {}' }))
      },
    },
  ],
})
// Kompakt: lister i stedet for objekter, og en liten dekoder i siden.
const roles = ['founder', 'es', 'employee']
const statuses = ['active', 'acquired', 'closed', 'unknown']
const types = ['funding', 'award', 'launch']
const compact = {
  f: data.firstYear,
  l: data.lastYear,
  u: data.appUrl,
  p: data.people.map((p) => [p.id, p.name, p.cohort ?? 0, p.claimed ? 1 : 0]),
  c: data.companies.map((c) => [
    c.id,
    c.slug,
    c.name,
    statuses.indexOf(c.status),
    c.tagline ?? '',
    c.founded ?? 0,
    c.closed ?? 0,
    c.acquired ?? 0,
    c.endUncertain ? 1 : 0,
    c.milestones.map((m) => [m.year, types.indexOf(m.type), m.text, m.uncertain ? 1 : 0]),
  ]),
  k: data.links.map((l) => [
    l.personId,
    l.companyId,
    roles.indexOf(l.role),
    l.from ?? 0,
    l.to ?? 0,
  ]),
}
const decode = `(function(d){var R=${JSON.stringify(roles)},S=${JSON.stringify(statuses)},T=${JSON.stringify(types)},z=function(v){return v||null};window.__ESAF_UNIVERSE__={firstYear:d.f,lastYear:d.l,appUrl:d.u,generatedAt:'',people:d.p.map(function(p){return{id:p[0],name:p[1],cohort:z(p[2]),claimed:!!p[3]}}),companies:d.c.map(function(c){return{id:c[0],slug:c[1],name:c[2],status:S[c[3]],tagline:z(c[4]),founded:z(c[5]),closed:z(c[6]),acquired:z(c[7]),endUncertain:!!c[8],milestones:c[9].map(function(m){return{year:m[0],type:T[m[1]],text:m[2],uncertain:!!m[3]}})}}),links:d.k.map(function(l){return{personId:l[0],companyId:l[1],role:R[l[2]],from:z(l[3]),to:z(l[4])}})}})`
const json = JSON.stringify(compact).replace(/</g, '\\u003c')
const script = `<script>${decode}(${json})</script><script>${result.outputFiles[0]!.text}</script>`
const html = (await readFile(`${root}views/universe.html`, 'utf8')).replace(
  '<!--SCRIPT-->',
  () => script,
)
const out = `${root}../../.data/mockups/es-universet-lokal${light ? '-lett' : ''}.html`
await writeFile(out, html, { mode: 0o600 })
console.log(
  `${out}: ${universe.people.length} personer, ${universe.companies.length} selskaper, ${universe.links.length} koblinger, ${Math.round(html.length / 1024)} kB`,
)
