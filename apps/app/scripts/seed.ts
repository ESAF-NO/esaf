/**
 * Fyller en LOKAL utviklingsdatabase. Sletter alt i databasen først, og nekter å
 * kjøre mot noe annet enn localhost.
 *
 *   pnpm db:seed
 *     Oppdiktede alumni, selskaper og innlegg, for utvikling uten ekte data.
 *     Logg inn som admin@example.test.
 *
 *   pnpm db:seed --fil ~/Downloads/telefonliste.xlsx [--admin deg@example.com]
 *     Den ekte kullisten, importert med samme kode som i produksjon. Med --admin
 *     går kontoen samme vei som en ekte bruker: bekreftet e-post, forespørsel om
 *     å være profilen med den adressen, og så godkjenner operatøren og gir admin.
 *     Ingen innlegg lages, så ingen ekte personer får tekst de ikke har skrevet.
 *     Fila leses bare, og havner aldri i repoet.
 *
 * Passordet er korrekt-hest-batteri.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  addComment,
  applyProfileImport,
  formatMention,
  getAccessState,
  grantRoleAsOperator,
  loadViewer,
  normalizeEmail,
  parseProfileSheet,
  parseProfileWorkbook,
  planProfileImport,
  submitAccessRequest,
} from '@esaf/core'
import { createDb, loadRootEnv, schema, sql } from '@esaf/db'
import { hashPassword } from 'better-auth/crypto'

loadRootEnv()
const url = process.env.DATABASE_URL
if (!url) throw new Error('Mangler DATABASE_URL.')
const host = new URL(url).hostname
if (!['localhost', '127.0.0.1', '::1'].includes(host) || process.env.NODE_ENV === 'production') {
  console.error(`Nekter å seede ${host}. Seed er bare for lokal utvikling.`)
  process.exit(1)
}

const { values: args } = parseArgs({
  options: { fil: { type: 'string' }, admin: { type: 'string' } },
})
const PASSWORD = 'korrekt-hest-batteri'

// Deterministisk tilfeldighet, så seed gir samme data hver gang.
let state = 20_241_028
const rand = () => {
  state = (state * 1_103_515_245 + 12_345) % 2 ** 31
  return state / 2 ** 31
}
const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!
const some = <T>(list: readonly T[], n: number) => [...list].sort(() => rand() - 0.5).slice(0, n)

const firstNames = [
  'Ingrid',
  'Magnus',
  'Sigrid',
  'Henrik',
  'Maren',
  'Eirik',
  'Thea',
  'Sondre',
  'Ida',
  'Jonas',
  'Synne',
  'Martin',
  'Hedda',
  'Andreas',
  'Vilde',
  'Kristoffer',
  'Nora',
  'Sindre',
  'Emilie',
  'Håkon',
  'Live',
  'Fredrik',
  'Tuva',
  'Even',
  'Mathilde',
  'Aksel',
  'Kaja',
  'Tobias',
  'Selma',
  'Vegard',
  'Amalie',
  'Petter',
  'Frida',
  'Ole',
  'Silje',
  'Mats',
  'Hanna',
  'Jørgen',
  'Marte',
  'Lars',
] as const
const lastNames = [
  'Bakken',
  'Solberg',
  'Haugen',
  'Strand',
  'Lunde',
  'Moe',
  'Nygaard',
  'Aas',
  'Berge',
  'Dahl',
  'Lie',
  'Holm',
  'Eide',
  'Vik',
  'Myhre',
  'Rønning',
  'Sæther',
  'Brekke',
  'Tangen',
  'Fossum',
  'Grønli',
  'Hovland',
  'Kvam',
  'Lien',
  'Mjøen',
  'Nesse',
  'Opsahl',
  'Rustad',
  'Skjelbred',
  'Tveit',
] as const
const studies = [
  'Industriell økonomi',
  'Datateknologi',
  'Maskinteknikk',
  'Bioteknologi',
  'Elektronikk',
  'Kybernetikk',
  'Energi og miljø',
  'Materialteknologi',
  'Fysikk og matematikk',
  'Bygg og miljø',
  'Marin teknikk',
  'Kjemi',
] as const
const cities = [
  'Oslo',
  'Oslo',
  'Oslo',
  'Trondheim',
  'Trondheim',
  'Bergen',
  'Stavanger',
  'London',
  'Stockholm',
  'San Francisco',
] as const
const expertise = [
  'B2B-salg',
  'Fundraising',
  'Produktledelse',
  'Rekruttering',
  'Hardware',
  'SaaS-prising',
  'Energi',
  'Medtech',
  'IP og patenter',
  'Go-to-market',
  'Styrearbeid',
  'Seed-investering',
  'Maskinlæring',
  'Regulatorisk',
  'Eksport',
  'Offentlige anbud',
  'Klimateknologi',
  'Growth',
  'Juss for startups',
  'Supply chain',
] as const
const companies = [
  { name: 'Syrlig', jobs: ['Daglig leder', 'CTO'] },
  { name: 'Havkraft Labs', jobs: ['Grunnlegger', 'COO'] },
  { name: 'Byggbit', jobs: ['Daglig leder', 'Produktsjef'] },
  { name: 'Nordlys Health', jobs: ['CEO', 'Medgrunnlegger'] },
  { name: 'Fjordflow', jobs: ['CTO', 'Daglig leder'] },
  { name: 'Kvartz Energy', jobs: ['Grunnlegger'] },
  { name: 'Pitchly', jobs: ['Daglig leder'] },
  { name: 'Torv', jobs: ['Partner'] },
  { name: 'Sanntid AI', jobs: ['CEO', 'Head of Engineering'] },
  { name: 'Løypa', jobs: ['Grunnlegger'] },
] as const
const employers = [
  'Equinor',
  'Schibsted',
  'McKinsey',
  'Kahoot!',
  'Oda',
  'Vipps MobilePay',
  'Northvolt',
  'Aker BioMarine',
  'Statkraft',
  'Spotify',
  'Investinor',
  'Nordic Semiconductor',
  'Tibber',
  'Cognite',
  'Deloitte',
  'Startuplab',
] as const
const roles = [
  'Produktsjef',
  'Investment Manager',
  'Partner',
  'Strategirådgiver',
  'Senior Manager',
  'Forretningsutvikler',
  'Head of Growth',
  'Daglig leder',
  'Engineering Manager',
  'Associate',
] as const

const industryNames = [
  'Energi',
  'Olje og gass',
  'Fornybar energi',
  'Helse og medtech',
  'Finans',
  'IT og programvare',
  'Telekom',
  'Media',
  'Bygg og eiendom',
  'Industri',
  'Havbruk',
  'Konsulent',
  'Venture capital',
] as const

const db = createDb(url)
const {
  auditEvent,
  cohort,
  comment,
  experience,
  membership,
  person,
  personCohort,
  personEmail,
  post,
  postVote,
  user,
  account,
} = schema

await db.execute(
  sql`truncate ${schema.notification}, ${postVote}, ${comment}, ${post}, ${schema.accessRequest}, ${auditEvent}, ${experience}, ${membership}, ${personCohort}, ${personEmail}, ${person}, ${cohort}, ${schema.session}, ${account}, ${schema.verification}, ${user} cascade`,
)

/** En innloggingskonto med bekreftet e-post og passord, som om personen hadde registrert seg. */
async function createLogin(name: string, email: string) {
  const id = randomUUID()
  await db.insert(user).values({ id, name, email, emailVerified: true })
  await db.insert(account).values({
    id: randomUUID(),
    accountId: id,
    providerId: 'credential',
    userId: id,
    password: await hashPassword(PASSWORD),
  })
  return id
}

if (args.fil) {
  await seedFromList(args.fil, args.admin)
} else {
  await seedDemo()
}
await db.close()

/** Den ekte kullisten, importert som i produksjon. */
async function seedFromList(fil: string, adminEmail: string | undefined) {
  const file = resolve(process.env.INIT_CWD ?? process.cwd(), fil)
  const data = readFileSync(file)
  const parsed = /\.xlsx$/i.test(file)
    ? await parseProfileWorkbook(data, { yearKind: 'graduation' })
    : parseProfileSheet(data.toString('utf8'), { yearKind: 'graduation' })
  const plan = await planProfileImport(db, parsed.rows)
  const result = await applyProfileImport(db, plan, {
    membershipStatus: 'active',
    sourceLabel: basename(file),
  })

  const email = normalizeEmail(adminEmail ?? 'admin@example.test')
  const userId = await createLogin('Lokal admin', email)
  // Samme vei som en ekte bruker: bekreftet e-post, «dette er meg», så godkjenner operatøren.
  const viewer = await loadViewer(db, userId)
  const { match: own } = await getAccessState(db, viewer)
  if (adminEmail && !own) console.warn(`Fant ikke ${email} i lista; lager en egen admin-profil.`)
  await submitAccessRequest(db, viewer, {
    profilePersonId: own?.personId ?? null,
    fullName: own?.fullName ?? 'Lokal admin',
    graduationYear: own?.years.at(-1) ?? null,
    linkedinUrl: '',
    note: '',
  })
  await grantRoleAsOperator(db, { email, reason: 'Lokal utvikling (pnpm db:seed)' })

  console.log(
    `Importerte ${result.created} personer i ${result.cohortsCreated} kull fra ${basename(file)}` +
      ` (${parsed.errors.length} rader hoppet over, ${parsed.warnings.length} varsler; se pnpm profiles:import).`,
  )
  console.log(
    own
      ? `Logg inn som ${email} / ${PASSWORD}. Kontoen er koblet til profilen til ${own.fullName} og er admin.`
      : `Logg inn som ${email} / ${PASSWORD}.`,
  )
}

/** Oppdiktede alumni, selskaper og innlegg. */
async function seedDemo() {
  const years = Array.from({ length: 2026 - 2006 + 1 }, (_, i) => 2006 + i)
  const cohortRows = await db
    .insert(cohort)
    .values(years.map((graduationYear) => ({ graduationYear })))
    .returning()
  const cohortId = new Map(cohortRows.map((c) => [c.graduationYear, c.id]))

  // Admin som kan logge inn
  const adminUserId = await createLogin('Ada Aasen', 'admin@example.test')

  type Seeded = { id: string; name: string; year: number }
  const people: Seeded[] = []
  const usedNames = new Set<string>()
  const companySeats = companies.flatMap((c) => c.jobs.map((job) => ({ company: c.name, job })))
  const companyYear = new Map(companies.map((c, i) => [c.name, 2009 + ((i * 7) % 16)]))

  for (let i = 0; i < 90; i++) {
    let name: string
    do name = `${pick(firstNames)} ${pick(lastNames)}`
    while (usedNames.has(name))
    usedNames.add(name)
    const isAdmin = i === 0
    const fullName = isAdmin ? 'Ada Aasen' : name
    const founder = i > 0 && i <= companySeats.length ? companySeats[i - 1] : undefined
    // Gründere av samme ES-selskap går i samme kull.
    const year = isAdmin
      ? 2016
      : founder
        ? companyYear.get(founder.company)!
        : years[Math.min(years.length - 1, Math.floor(rand() ** 0.7 * years.length))]!
    const claimed = isAdmin || rand() < 0.45
    const filled = claimed || rand() < 0.5
    const userId = claimed ? (isAdmin ? adminUserId : randomUUID()) : null
    const startedAt = (gap: number) => Math.min(2026, year + gap)
    if (userId && !isAdmin) {
      await db.insert(user).values({
        id: userId,
        name: fullName,
        email: `${fullName.toLowerCase().replace(/[^a-z]+/g, '.')}.${i}@example.test`,
        emailVerified: true,
      })
    }
    const [p] = await db
      .insert(person)
      .values({
        fullName,
        userId,
        claimedAt: claimed ? new Date(Date.now() - rand() * 90 * 864e5) : null,
        onboardedAt: claimed ? new Date() : null,
        source: claimed ? 'signup' : 'import',
        studyBackground: pick(studies),
        city: filled ? pick(cities) : null,
        esCompany: founder?.company ?? null,
        bio:
          claimed && rand() < 0.7
            ? pick([
                'Bygger selskap innen energi og klima. Spør meg om hardware, finansiering og hvordan man overlever første kunde.',
                'Har jobbet med produkt i både startup og konsern. Hjelper gjerne andre ES-ere med prising og go-to-market.',
                'Investor i tidligfase. Ser mest på B2B-software og deeptech fra norske universiteter.',
                'Gründer på andre selskap. Første ble kjøpt opp i 2021, nå bygger vi noe nytt innen helse.',
                'Jobber med strategi og M&A. Alltid glad for en kaffe med folk fra Entreprenørskolen.',
              ])
            : null,
        expertise: filled ? some(expertise, 1 + Math.floor(rand() * 4)) : [],
        industries: filled ? some(industryNames, 1 + Math.floor(rand() * 3)) : [],
      })
      .returning({ id: person.id })

    // Erfaring: gründere bygger fortsatt selskapet sitt (eller har gått videre),
    // andre har en nåværende jobb og kanskje en eller to tidligere.
    const history: (typeof experience.$inferInsert)[] = []
    const at = (company: string, title: string, from: number, to: number | null, founded = false) =>
      history.push({
        personId: p!.id,
        company,
        title,
        startYear: from,
        endYear: to,
        founder: founded,
      })
    if (isAdmin) {
      at('ESAF', 'Styreleder', 2024, null)
      at('Kahoot!', 'Produktsjef', 2018, 2024)
      at('McKinsey', 'Associate', startedAt(0), 2018)
    } else if (filled) {
      const first = startedAt(0)
      if (founder) {
        const stillThere = rand() < 0.7
        at(founder.company, founder.job, first, stillThere ? null : startedAt(4), true)
        if (!stillThere) at(pick(employers), pick(roles), startedAt(4), null)
      } else {
        const past = Math.floor(rand() * 3)
        let from = first
        for (let k = 0; k < past && from < 2024; k++) {
          const to = Math.min(2025, from + 2 + Math.floor(rand() * 3))
          at(pick(employers), pick(roles), from, to)
          from = to
        }
        at(pick(employers), pick(roles), from, null)
      }
    }
    history.forEach((r, position) => (r.position = position))
    if (history.length) await db.insert(experience).values(history)
    await db.insert(membership).values({
      personId: p!.id,
      status: 'active',
      role: isAdmin ? 'owner' : 'member',
      decidedAt: new Date(),
    })
    await db.insert(personCohort).values({ personId: p!.id, cohortId: cohortId.get(year)! })
    if (isAdmin) {
      await db
        .insert(personEmail)
        .values({ email: 'admin@example.test', personId: p!.id, source: 'signup' })
    }
    people.push({ id: p!.id, name: fullName, year })
  }

  // To forespørsler om tilgang, så adminsiden har noe å vise: én der adressen står
  // på en profil fra kullisten (sterkt tegn), og én som ikke ble funnet.
  const [listed] = await db
    .insert(person)
    .values({ fullName: 'Kari Nordmann', source: 'import', phone: '+47 400 00 000' })
    .returning({ id: person.id })
  await db.insert(membership).values({ personId: listed!.id, status: 'active' })
  await db.insert(personCohort).values({ personId: listed!.id, cohortId: cohortId.get(2017)! })
  await db
    .insert(personEmail)
    .values({ email: 'kari@example.test', personId: listed!.id, source: 'import' })
  const kari = await loadViewer(db, await createLogin('kari', 'kari@example.test'))
  await submitAccessRequest(db, kari, {
    profilePersonId: listed!.id,
    fullName: 'Kari Nordmann',
    graduationYear: 2017,
    linkedinUrl: '',
    note: '',
  })
  const nils = await loadViewer(db, await createLogin('nils', 'nils@example.test'))
  await submitAccessRequest(db, nils, {
    profilePersonId: null,
    fullName: 'Nils Nyregistrert',
    graduationYear: 2020,
    linkedinUrl: 'https://www.linkedin.com/in/nils-nyregistrert',
    note: 'Brukte NTNU-mailen da jeg gikk på ES, så den adressen står nok i lista.',
  })

  const posts = [
    {
      channel: 'sporsmal',
      title: 'Noen som har erfaring med Innovasjon Norge-søknader for hardware?',
      body: 'Vi skal søke om oppstartstilskudd 2 for en sensorplattform til havbruk. Hva skilte de gode søknadene fra de dårlige? Tar gjerne en prat over kaffe også.',
    },
    {
      channel: 'intro',
      title: 'Ser etter intro til noen i Equinor Ventures',
      body: 'Vi har en pilot med en leverandør til sokkelen og vil gjerne snakke med noen i ventures-teamet før vi starter emisjonen. Kjenner noen her en partner der?',
    },
    {
      channel: 'lansering',
      title: 'Fjordflow er live – sanntids vannkvalitet for oppdrettere',
      body: 'Etter to år med piloter er vi endelig ute med første kommersielle versjon. Takk til alle ES-ere som har testet og gitt tilbakemelding. Vi tar gjerne imot flere introer til oppdrettsselskaper!',
      url: 'https://example.test/fjordflow',
    },
    {
      channel: 'jobb',
      title: 'Byggbit ansetter første salgssjef (Oslo)',
      body: 'Vi har vokst fra 3 til 14 kunder i år og trenger en som kan bygge salgsorganisasjonen. Gjerne ES-bakgrunn. Send meg en melding!',
      url: 'https://example.test/byggbit/jobb',
    },
    {
      channel: 'arrangement',
      title: 'ESAF-helg i Trondheim: hvem kommer?',
      body: 'Vi planlegger helgen sammen med dagens kull:\n\n- **Fredag:** workshops med studentene\n- **Lørdag:** flere workshops, og middag om kvelden\n\nSkriv i kommentarfeltet om du vil holde en workshop.',
    },
    {
      channel: 'sporsmal',
      title: 'Hvordan priser dere B2B SaaS i det norske markedet?',
      body: 'Vi selger til kommuner og har slitt med å finne riktig nivå. Per bruker, per innbygger, eller fast årspris? Hva har funket for dere?',
    },
    {
      channel: 'generelt',
      title: 'Tips til gode bøker om å bygge salgsteam?',
      body: 'Har lest disse:\n\n1. _Founding Sales_\n2. _The Sales Acceleration Formula_\n\nHva mer bør jeg lese?',
    },
    {
      channel: 'lansering',
      title: 'Nordlys Health henter 18 MNOK i seed',
      body: 'Vi har hentet 18 millioner for å skalere digital oppfølging av hjertepasienter. Spesielt takk til tre ES-alumni som gikk inn som engler.',
    },
    {
      channel: 'intro',
      title: 'Noen som kjenner noen hos Tibber eller Statkraft?',
      body: 'Bygger en tjeneste for fleksibilitet i strømnettet og vil gjerne snakke med noen som jobber med flexmarkeder.',
    },
    {
      channel: 'jobb',
      title: 'Sanntid AI søker ML-ingeniør',
      body: 'Fulltid i Trondheim eller remote fra Norden. Vi jobber med prediktivt vedlikehold for industri.',
      url: 'https://example.test/sanntid/jobb',
    },
    {
      channel: 'sporsmal',
      title: 'Aksjonæravtale: hva bør vi tenke på før første emisjon?',
      body: 'Tre gründere, ingen investorer ennå. Vi får tilbud fra en engel.\n\n> Hvilke klausuler angrer dere på at dere **ikke** hadde?',
    },
    {
      channel: 'generelt',
      title: 'Kaffe i London neste uke?',
      body: 'Er i London tirsdag til fredag. Noen ES-ere der som vil ta en kaffe?',
    },
    {
      channel: 'sporsmal',
      title: 'Erfaringer med å ansette utviklere fra Øst-Europa?',
      body: 'Vurderer et team i Polen. Hvordan har det gått for dere som har gjort det?',
    },
    {
      channel: 'lansering',
      title: 'Løypa lanserer app for turstier i hele Norden',
      body: 'Gratis i App Store og Google Play. Vi vil gjerne høre hva dere synes!',
      url: 'https://example.test/loypa',
    },
    {
      channel: 'arrangement',
      title: 'ESAF-talk i Oslo: Fra ES-prosjekt til exit',
      body: 'To alumni forteller om veien fra syretest til oppkjøp. Etterpå blir det mingling. Torsdag kl. 18.',
    },
  ] as const

  const commentBodies = [
    'Veldig bra spørsmål, følger med!',
    'Sendte deg en melding.',
    'Vi gjorde akkurat dette i fjor. Ta kontakt, så kan jeg vise deg søknaden vår.',
    'Gratulerer! Fortjent etter mye arbeid.',
    'Kjenner en der, skal sjekke om hun er åpen for en prat.',
    'Kommer gjerne og holder en workshop om salg.',
    'Vi gikk for fast årspris og angrer ikke. Enklere for innkjøp i kommunene.',
    'Les The Mom Test også, den er gull.',
    'Jeg er i London på onsdag!',
    'Pass på drag-along og tag-along, og at vesting gjelder alle gründerne.',
  ] as const

  for (const [index, p] of posts.entries()) {
    const author = index === 4 ? people[0]! : pick(people.slice(1))
    const created = new Date(Date.now() - (index * 1.7 + rand()) * 864e5)
    const [row] = await db
      .insert(post)
      .values({
        ...p,
        url: 'url' in p ? p.url : null,
        // ESAF-helgen er festet øverst, som en kunngjøring fra styret.
        pinnedAt: index === 4 ? created : null,
        authorPersonId: author.id,
        createdAt: created,
        updatedAt: created,
      })
      .returning({ id: post.id })
    const voters = some(people, Math.floor(rand() * 18))
    if (voters.length) {
      await db.insert(postVote).values(voters.map((v) => ({ postId: row!.id, personId: v.id })))
    }
    const commenters = some(people, Math.floor(rand() * 5))
    for (const [j, c] of commenters.entries()) {
      const at = new Date(created.getTime() + (j + 1) * 37 * 60_000)
      await db.insert(comment).values({
        postId: row!.id,
        authorPersonId: c.id,
        body: pick(commentBodies),
        createdAt: at,
        updatedAt: at,
      })
    }
  }

  // Et vanlig medlem som også kan logge inn, så varsler og omtaler kan prøves med
  // to brukere. Kommentarene går gjennom @esaf/core, så Ada får ekte varsler.
  const saraUserId = await createLogin('Sara Holm', 'sara@example.test')
  const [sara] = await db
    .insert(person)
    .values({
      fullName: 'Sara Holm',
      userId: saraUserId,
      claimedAt: new Date(),
      onboardedAt: new Date(),
      studyBackground: 'Industriell økonomi',
      city: 'Oslo',
    })
    .returning({ id: person.id })
  await db
    .insert(membership)
    .values({ personId: sara!.id, status: 'active', decidedAt: new Date() })
  await db.insert(personCohort).values({ personId: sara!.id, cohortId: cohortId.get(2016)! })
  await db
    .insert(personEmail)
    .values({ email: 'sara@example.test', personId: sara!.id, source: 'signup' })
  const saraViewer = await loadViewer(db, saraUserId)
  const [weekend] = await db
    .select({ id: post.id })
    .from(post)
    .where(sql`${post.authorPersonId} = ${people[0]!.id}`)
  const ada = formatMention({ personId: people[0]!.id, name: 'Ada Aasen' })
  await addComment(db, saraViewer, weekend!.id, {
    body: 'Jeg kommer gjerne og holder en workshop om salg lørdag formiddag.',
  })
  await addComment(db, saraViewer, weekend!.id, {
    body: `${ada}, trenger dere hjelp med middagen også? Jeg kan ta kontakt med et sted i Bakklandet.`,
  })

  console.log(
    `Seedet ${people.length + 1} oppdiktede personer, ${posts.length} innlegg og ${years.length} kull. Logg inn som admin@example.test eller sara@example.test, passord ${PASSWORD}.`,
  )
}
