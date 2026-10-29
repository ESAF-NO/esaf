/**
 * Lager en datasettbunt fra berikelsen (`.data/enrichment/out/*.json` og
 * bildene den viser til), til `pnpm data:import`. Kjøres lokalt. Bunten har bare
 * feltene importen bruker, og bare bildene som faktisk brukes: profilbilder
 * skalert ned og uten metadata, og den beste logoen per selskap. Fødselsår og
 * annet fra registrene blir aldri med.
 *
 *   pnpm data:bundle --fra .data/enrichment --til ~/esaf-datasett.tar.gz
 *
 * Bunten inneholder persondata. Den skal aldri committes, og bare kopieres til
 * serveren mens importen kjøres (se README, «Fylle produksjon med datasettet»).
 *
 * Reglene for hva som hentes, er de samme som i den lokale importen før:
 *
 * - Status: bare bevis med middels eller høy sikkerhet gir aktiv, oppkjøpt eller
 *   nedlagt. Svake tegn (f.eks. «terminerte bedrifter» på den gamle ES-siden) og
 *   ingen bevis gir ukjent.
 * - Logoer: bare fra selskapets egen nettside eller ES-sidens startup-oversikt,
 *   aldri bilder fra historikken i ES-arkivet (ofte team- og produktbilder). Hvite
 *   logoer som forsvinner på hvit bakgrunn, hoppes over.
 * - Hendelser hentet automatisk fra nyhetssaker får lav sikkerhet, og sitater med
 *   usikker taler likeså; appen viser dem bare for dem som kan rette dem.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import sharp from 'sharp'
import { z } from 'zod'
import {
  processCompanyLogo,
  processProfilePhoto,
  writeDatasetBundle,
  type Dataset,
  type DatasetCompany,
  type DatasetPerson,
  type DatasetQuote,
  type DatasetSource,
} from '../src/index.ts'

/* eslint-disable @typescript-eslint/no-explicit-any -- rådataene fra berikelsen har ikke typer */

const usage = `Bruk: pnpm data:bundle --fra <mappe> --til <fil.tar.gz>

  --fra <mappe>   Berikelsen, med out/people.json, out/companies.json og out/quotes.json
                  (standard: .data/enrichment)
  --til <fil>     Bunten som lages. Må slutte på .tar.gz og ligge utenfor repoet
                  (eller i .data/, som er gitignorert)`

const fail = (message: string): never => {
  console.error(`${message}\n\n${usage}`)
  process.exit(1)
}

const { values } = (() => {
  try {
    return parseArgs({
      options: {
        fra: { type: 'string', default: '.data/enrichment' },
        til: { type: 'string' },
      },
    })
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
})()

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const cwd = process.env.INIT_CWD ?? process.cwd()
const from = resolve(cwd, values.fra)
if (!values.til) fail('Mangler --til.')
const to = resolve(cwd, values.til!)
if (!to.endsWith('.tar.gz')) fail('--til må slutte på .tar.gz.')
// Bunten har persondata: den skal aldri kunne havne i git.
const inRepo = !relative(repo, to).startsWith('..')
if (inRepo && !to.startsWith(join(repo, '.data') + sep)) {
  fail(
    'Bunten har persondata og kan ikke ligge i repoet (bortsett fra i .data/, som er gitignorert).',
  )
}
for (const file of ['out/people.json', 'out/companies.json', 'out/quotes.json']) {
  if (!existsSync(join(from, file))) fail(`Fant ikke ${join(from, file)}.`)
}

const read = (file: string): any[] => JSON.parse(readFileSync(join(from, file), 'utf8'))
const rawPeople = read('out/people.json')
const rawCompanies = read('out/companies.json')
const rawQuotes = read('out/quotes.json')

type Confidence = 'high' | 'medium' | 'low'
const conf = (c: unknown): Confidence => (c === 'high' || c === 'medium' ? c : 'low')
const day = (d: unknown) =>
  typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null
const year = (d: unknown) => {
  const y = typeof d === 'string' ? Number(d.slice(0, 4)) : NaN
  return y >= 1950 && y <= 2100 ? y : null
}
const iso = (d: unknown) => {
  if (typeof d !== 'string') return null
  const date = new Date(d)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
const titleCase = (s: string) =>
  s
    .toLocaleLowerCase('nb')
    .replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toLocaleUpperCase('nb'))

/** Retter tekst fra gamle sider: UTF-8 lest som Latin-1 («Ã¸», «Â »), og harde mellomrom. */
const clean = (raw?: string | null) => {
  if (!raw || typeof raw !== 'string') return null
  let t = raw
  if (/[ÂÃ][\u0080-ÿ]|â€/.test(t)) {
    const fixed = Buffer.from(t, 'latin1').toString('utf8')
    if (!fixed.includes('�')) t = fixed
  }
  t = t
    .replace(/Â(?=[\s\u00a0])/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
  // Teamlinjer («Students: …») vises allerede som personer på selskapssiden.
  t = t.replace(/(^|\n)\s*(Students|Studenter|Team)\s*:[^\n]*/gi, '').trim()
  return t || null
}

/** Kilden slik appen viser den: navn og en lenke folk kan åpne (aldri lokale filer). */
function sourceOf(src: any): DatasetSource | null {
  if (!src) return null
  const raw = typeof src.url === 'string' ? src.url : null
  let url = raw && /^https?:\/\//i.test(raw) ? raw : null
  const fetchedAt = iso(src.fetchedAt)
  const brreg = url?.match(/data\.brreg\.no\/enhetsregisteret\/api\/enheter\/(\d{9})/)
  if (brreg) url = `https://virksomhet.brreg.no/oppslag/enheter/${brreg[1]}`
  switch (src.source) {
    case 'phonelist':
      return { label: 'kullisten', url: null, fetchedAt }
    case 'es-live':
      return { label: 'entreprenorskolen.no', url, fetchedAt }
    case 'es-wayback':
      return { label: 'entreprenorskolen.no (arkiv)', url, fetchedAt }
    case 'solan':
      return { label: 'solanlinjeforening.no', url, fetchedAt }
    case 'brreg':
    case 'brreg-pipeline':
    case 'brreg-archive-lookup':
      return { label: 'Brønnøysundregistrene', url, fetchedAt }
  }
  if (!url) return null
  if (brreg) return { label: 'Brønnøysundregistrene', url, fetchedAt }
  const host = new URL(url).hostname.replace(/^www\./, '')
  if (host === 'web.archive.org') {
    const original = url.match(/web\.archive\.org\/web\/[^/]+\/(?:https?:\/\/)?([^/]+)/)?.[1]
    return { label: `${original?.replace(/^www\./, '') ?? 'nettarkivet'} (arkiv)`, url, fetchedAt }
  }
  return { label: host, url, fetchedAt }
}

/** Kildene for ett felt. Samme kilde to ganger (f.eks. to sider på ES-siden) blir én. */
function sourcesOf(list: any[], confidence: Confidence) {
  const seen = new Set<string>()
  const sources = list.flatMap((raw) => {
    const s = sourceOf(raw)
    if (!s || seen.has(s.label)) return []
    seen.add(s.label)
    return [s]
  })
  return sources.length ? { confidence, sources } : null
}

const images = new Map<string, Uint8Array>()
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex').slice(0, 24)
function addImage(kind: 'photos' | 'logos', data: Uint8Array, ext: string) {
  const path = `images/${kind}/${sha(data)}${ext}`
  images.set(path, data)
  return path
}

// 1. Selskaper ------------------------------------------------------------------

/** Bare bevis med middels eller høy sikkerhet avgjør. Uten det er statusen ukjent. */
const statusOf = (lifecycle: any): DatasetCompany['status'] => {
  const { status, confidence } = lifecycle ?? {}
  if (confidence !== 'high' && confidence !== 'medium') return 'unknown'
  if (status === 'active') return 'active'
  if (status === 'acquired') return 'acquired'
  if (status === 'bankrupt' || status === 'dissolved' || status === 'shut down') return 'closed'
  return 'unknown'
}

/** Siste gang selskapet sto på ES-siden: i arkivet, eller i dag hvis det står på nettsiden nå. */
function lastSeenOnEsSite(c: any): string | null {
  const dates = [
    day(c.esArchive?.lastSeen),
    ...(c.sources ?? [])
      .filter((s: any) => s.source === 'es-live')
      .map((s: any) => day(s.fetchedAt)),
  ].filter((d): d is string => d !== null)
  return dates.sort().at(-1) ?? null
}

/**
 * Bilder fra egen nettside som er logoen til noen andre (en kunde, et universitet,
 * en partner), og bilder i ES-sidens startup-oversikt som er team-, produkt- eller
 * landskapsbilder. Funnet ved gjennomgang av tidligere importer.
 */
const NOT_THE_LOGO = [
  'UGA%20logo',
  'Skanska%20Logo',
  'SalesScreen%20Logo',
  'mosvold-co.svg',
  '/images/startups/db_16.jpg',
  '/images/startups/dropracks_49.jpg',
  '/images/startups/prampack_11.jpg',
  '/images/startups/rendra_as_24.jpg',
  '/images/startups/trevarefabrikken_30.jpg',
  '/images/startups/connect_lng_31.jpg',
  '/images/startups/dogu_3.png',
]
type Logo = { path: string; source?: any }

/** Logoene som kan brukes: egen nettside først, så ES-sidens startup-oversikt. */
function logoCandidates(c: any): Logo[] {
  const all: Logo[] = (c.logos ?? []).filter(
    (l: Logo) =>
      !l.path.startsWith('raw/es/images/history/') &&
      !NOT_THE_LOGO.some((bad) => l.source?.url?.includes(bad)),
  )
  const own = all.filter(
    (l) => l.source?.source === 'web' && l.source.how !== 'entreprenorskolen-startups',
  )
  const es = all.filter(
    (l) => l.source?.source === 'es-live' || l.source?.how === 'entreprenorskolen-startups',
  )
  return [...own, ...es].filter((l, i, list) => list.findIndex((o) => o.path === l.path) === i)
}

// SVG slippes ikke inn i appens bildebibliotek. De gjøres om til PNG i en egen prosess
// med et sharp uten begrensningene fra @esaf/core, og med tidsgrense.
const SHARP = createRequire(import.meta.url).resolve('sharp')
const RASTERIZE = `
const sharp = require(process.argv[1]);
(async () => {
  const meta = await sharp(process.argv[2]).metadata();
  const density = Math.min(2400, Math.max(36, (72 * 512) / Math.max(meta.width, meta.height)));
  const png = await sharp(process.argv[2], { density }).resize(512, 512, { fit: 'inside' }).png().toBuffer();
  process.stdout.write(png);
})().catch((e) => { console.error(e.message); process.exit(1) });
`
const rasterizeSvg = (path: string) =>
  execFileSync(process.execPath, ['-e', RASTERIZE, SHARP, path], {
    maxBuffer: 20 * 1024 * 1024,
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  })

/**
 * Hvite logoer laget for mørk bakgrunn forsvinner på den hvite flisen i appen.
 * Da prøves neste kilde, og finnes ingen, vises bokstavflisen.
 */
async function invisibleOnWhite(image: Buffer) {
  const { data } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  // Piksler som synes på hvitt: dekkende og merkbart mørkere enn bakgrunnen.
  let ink = 0
  for (let i = 0; i < data.length; i += 4) {
    const luminance = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
    if (data[i + 3]! >= 128 && luminance < 225) ink++
  }
  return ink / (data.length / 4) < 0.005
}

const stats = { logos: 0, light: 0, noLogo: 0, photos: 0, photosFailed: 0, articles: 0 }

/** Den første kandidaten som lar seg lese og synes på hvitt, slik den skal i bunten. */
async function chooseLogo(c: any): Promise<DatasetCompany['logo']> {
  const candidates = logoCandidates(c)
  if (!candidates.length) return null
  for (const logo of candidates) {
    const path = join(from, logo.path)
    try {
      const raw = readFileSync(path)
      const isSvg =
        /\.svg$/i.test(logo.path) ||
        /^\s*(<\?xml|<svg)/i.test(raw.subarray(0, 200).toString('utf8'))
      const file = new Uint8Array(isSvg ? rasterizeSvg(path) : raw)
      const processed = await processCompanyLogo(file)
      if (await invisibleOnWhite(processed.large)) {
        stats.light++
        continue
      }
      stats.logos++
      const ext = isSvg ? '.png' : extname(logo.path).toLowerCase() || '.png'
      return {
        file: addImage('logos', file, ext),
        source: sourceOf(logo.source),
        confidence: logo.source?.how === 'img-logo' ? 'medium' : 'high',
      }
    } catch {
      // Prøver neste kilde (for eksempel ICO, en favicon som er for liten, eller en ødelagt fil).
    }
  }
  stats.noLogo++
  return null
}

const eventType: Record<string, DatasetCompany['timeline'][number]['type']> = {
  founded: 'founded',
  funding: 'funding',
  grant: 'funding',
  award: 'award',
  launch: 'launch',
  acquisition: 'acquired',
  bankruptcy: 'bankrupt',
  dissolution: 'dissolved',
  shutdown: 'closed',
  renamed: 'other',
  rebrand: 'other',
}
const short = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t)

const companies: DatasetCompany[] = []
for (const c of rawCompanies) {
  const fieldSources: DatasetCompany['fieldSources'] = {}
  const put = (field: string, value: ReturnType<typeof sourcesOf>) => {
    if (value) fieldSources[field] = value
  }
  const fs = c.fieldSources ?? {}
  const brregSources = fs.brreg?.sources ?? []
  const tagline = clean(c.solan?.blurb)
  const description = clean(c.description)
  const foundedYear = year(c.founded) ?? year(c.brreg?.founded)
  const location = c.city ? titleCase(c.city) : null
  const industries = c.industry?.description ? [c.industry.description] : []
  const status = statusOf(c.lifecycle)
  const lastSeen = lastSeenOnEsSite(c)

  if (tagline && c.solan) {
    put(
      'tagline',
      sourcesOf([{ source: 'solan', url: 'https://solanlinjeforening.no/#startups' }], 'medium'),
    )
  }
  if (description) {
    const origin = (c.descriptions ?? []).find((d: any) => d.text === c.description)
    if (origin) put('description', sourcesOf([origin.source], 'medium'))
  }
  if (c.website && fs.website)
    put('website', sourcesOf(fs.website.sources, conf(fs.website.confidence)))
  if (foundedYear !== null) {
    if (year(c.brreg?.founded) === foundedYear && brregSources.length) {
      put('foundedYear', sourcesOf(brregSources, conf(fs.brreg.confidence)))
    } else {
      const event = (c.timeline ?? []).find(
        (t: any) => t.type === 'founded' && year(t.date) === foundedYear,
      )
      if (event) put('foundedYear', sourcesOf([event.source], conf(event.confidence)))
    }
  }
  if (location && brregSources.length) put('location', sourcesOf(brregSources, 'medium'))
  if (industries.length && c.industry?.source === 'brreg' && brregSources.length) {
    put('industries', sourcesOf(brregSources, 'medium'))
  }
  if (status !== 'unknown') {
    // Bevisene som peker samme vei som statusen, sikrest først.
    const order: Record<string, number> = { high: 0, medium: 1, low: 2 }
    const evidence = (c.lifecycle.evidence ?? [])
      .filter((e: any) => statusOf({ status: e.status, confidence: e.confidence }) === status)
      .sort((a: any, b: any) => order[a.confidence]! - order[b.confidence]!)
    put(
      'status',
      sourcesOf(
        evidence.map((e: any) => ({ url: e.url, fetchedAt: null })),
        conf(c.lifecycle.confidence),
      ),
    )
  }
  if (lastSeen) {
    put(
      'lastSeenOnEsSite',
      sourcesOf(
        (c.sources ?? []).filter((s: any) => s.source === 'es-live' || s.source === 'es-wayback'),
        'high',
      ),
    )
  }

  // Bare hendelser med dato.
  const timeline = (c.timeline ?? []).flatMap((t: any) => {
    const m = (typeof t.date === 'string' ? t.date : '').match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/)
    const text = short((clean(t.text) ?? '').replace(/\s+/g, ' '), 500)
    if (!m || !text) return []
    return [
      {
        date: [m[1], m[2], m[3]].filter(Boolean).join('-'),
        type: eventType[t.type] ?? 'other',
        text,
        source: sourceOf(t.source),
        confidence: t.extraction === 'auto-sentence' ? 'low' : conf(t.confidence),
      },
    ]
  })

  // Saker i media: bare lenke, tittel, utgiver, dato og merkene. Aldri teksten.
  const articles = (c.articles ?? []).flatMap((a: any) => {
    if (typeof a?.url !== 'string' || typeof a?.title !== 'string') return []
    const date = typeof a.date === 'string' ? a.date.match(/^\d{4}(-\d{2}(-\d{2})?)?$/)?.[0] : null
    return [
      {
        url: a.url,
        title: clean(a.title) ?? a.title,
        date: date ?? null,
        publisher: typeof a.publisher === 'string' ? clean(a.publisher) : null,
        paywall: a.paywall === true,
        mentionsES: a.mentionsES === true,
      },
    ]
  })
  stats.articles += articles.length

  companies.push({
    key: c.key,
    name: c.name,
    tagline,
    description,
    website: c.website ?? null,
    foundedYear,
    location,
    industries,
    status,
    lastSeenOnEsSite: lastSeen,
    logo: await chooseLogo(c),
    fieldSources,
    timeline,
    articles,
  })
}

// 2. Personer -------------------------------------------------------------------

const niceName = (p: any) => {
  if (p.fullName !== p.fullName.toUpperCase()) return p.fullName
  return p.nameVariants?.find((n: string) => n !== n.toUpperCase()) ?? titleCase(p.fullName)
}
const titleFor = (relation: string, titles: string[] = []) =>
  titles.find((t) => !/per source/i.test(t)) ??
  (
    {
      founder: 'Gründer',
      ceo: 'Daglig leder',
      board: 'Styremedlem',
      team: 'ES-team',
      employee: null,
    } as Record<string, string | null>
  )[relation] ??
  null
/** Samme sjekk av e-post som bunten bruker; ugyldige adresser tas ikke med. */
const isEmail = (email: string) => z.email().safeParse(email).success

/**
 * Profilbildet slik det skal i bunten: rotert, uten metadata og skalert ned til
 * høyst 1024 piksler (appen lagrer 512). Små eller store originaler som ikke
 * passer reglene for opplasting, skaleres først, som i den lokale importen før.
 */
async function preparePhoto(rel: string): Promise<Uint8Array | null> {
  try {
    const original = readFileSync(join(from, rel))
    let usable: Buffer = original
    try {
      await processProfilePhoto(new Uint8Array(original))
    } catch {
      usable = await sharp(original)
        .rotate()
        .resize(1024, 1024, { fit: 'outside', withoutEnlargement: false })
        .jpeg({ quality: 90 })
        .toBuffer()
    }
    const smaller = await sharp(usable)
      .rotate()
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer()
    await processProfilePhoto(new Uint8Array(smaller))
    return new Uint8Array(smaller)
  } catch {
    return null
  }
}

const people: DatasetPerson[] = []
for (const p of rawPeople) {
  const fs = p.fieldSources ?? {}
  const fieldSources: DatasetPerson['fieldSources'] = {}
  const put = (field: string, from = field) => {
    const value = fs[from] && sourcesOf(fs[from].sources ?? [], conf(fs[from].confidence))
    if (value) fieldSources[field] = value
  }
  for (const field of ['bio', 'linkedinUrl', 'studyBackground', 'expertise', 'industries'])
    put(field)
  put('experience', 'companies')
  put('esCompany', 'companies')

  let photo: DatasetPerson['photo'] = null
  if (typeof p.photo === 'string') {
    const prepared = await preparePhoto(p.photo)
    if (prepared) {
      stats.photos++
      const origin = (p.photos ?? []).find((x: any) => x.path === p.photo)
      photo = {
        file: addImage('photos', prepared, '.jpg'),
        source:
          sourceOf(origin?.source) ??
          sourcesOf(fs.photo?.sources ?? [], 'medium')?.sources[0] ??
          null,
        confidence: conf(fs.photo?.confidence ?? 'medium'),
      }
      put('photo')
    } else {
      stats.photosFailed++
    }
  }

  const graduationYears: number[] = p.graduationYears?.length
    ? p.graduationYears
    : [p.graduationYear]
  people.push({
    key: p.key,
    fullName: niceName(p),
    graduationYears: graduationYears.filter((y) => Number.isInteger(y)),
    emails: [
      ...new Set<string>((p.emails ?? []).map((e: string) => e.trim().toLowerCase())),
    ].filter(isEmail),
    phone: p.phones?.[0] ?? null,
    linkedinUrl: p.linkedinUrl ?? null,
    studyBackground: p.studyBackground ?? null,
    bio: p.bio ?? null,
    expertise: (p.expertise ?? []).slice(0, 10),
    industries: p.industries ?? [],
    photo,
    companies: (p.companies ?? []).map((c: any) => {
      const team = c.relation === 'team'
      return {
        companyKey: c.companyKey,
        role: c.relation === 'founder' ? 'founder' : team ? 'es' : 'employee',
        title: titleFor(c.relation, c.titles),
        // Et ES-team som ikke er ES-selskapet på profilen, blir erfaring fram til uteksamineringen.
        startYear: team ? null : year(c.period?.since ?? c.period?.from),
        endYear: team ? year(String(p.graduationYear)) : year(c.period?.until ?? c.period?.to),
      }
    }),
    fieldSources,
  })
}

// 3. Sitater --------------------------------------------------------------------

const quotes: DatasetQuote[] = []
let skippedQuotes = 0
for (const q of rawQuotes) {
  const text = clean(q.text)?.slice(0, 2000)
  const speaker = typeof q.speaker === 'string' ? clean(q.speaker) : null
  if (!text || !speaker) {
    skippedQuotes++
    continue
  }
  const raw = q.sources?.[0] ?? { url: q.sourceUrl }
  let source = sourceOf(raw)
  if (!source && /^https?:\/\//.test(q.sourceUrl ?? '')) {
    source = {
      label: new URL(q.sourceUrl).hostname.replace(/^www\./, ''),
      url: q.sourceUrl,
      fetchedAt: null,
    }
  }
  quotes.push({
    key: q.key,
    text,
    speakerName: speaker.slice(0, 120),
    speakerRole: q.speakerRole ? (clean(q.speakerRole)?.slice(0, 160) ?? null) : null,
    // Datoen fra arkivet er når siden ble lagret, ikke når det ble sagt.
    date: q.dateKind === 'article publish date' ? day(q.date) : null,
    personKey: q.speakerPersonKey ?? null,
    companyKey: q.companyKey ?? null,
    source,
    confidence: q.attributionConfidence === 'high' ? 'high' : 'low',
  })
}

const data: Dataset = { companies, people, quotes }
const { archive, manifest } = writeDatasetBundle(data, images)
writeFileSync(to, archive, { mode: 0o600 })
chmodSync(to, 0o600)

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`
console.log(`Laget ${to} (${mb(statSync(to).size)}, skjemaversjon ${manifest.schemaVersion})`)
console.log(
  `  ${manifest.counts.companies} selskaper, ${manifest.counts.articles} saker i media, ` +
    `${manifest.counts.logos} logoer (${stats.light} hvite hoppet over, ${stats.noLogo} uten lesbar logo)`,
)
console.log(
  `  ${manifest.counts.people} personer, ${manifest.counts.photos} profilbilder` +
    `${stats.photosFailed ? ` (${stats.photosFailed} kunne ikke leses)` : ''}, ` +
    `${manifest.counts.quotes} sitater (${skippedQuotes} uten tekst eller taler hoppet over)`,
)
console.log(
  `\nBunten inneholder persondata. Ikke commit den, del den ikke, og slett ${basename(to)} ` +
    'fra serveren når importen er ferdig.',
)
