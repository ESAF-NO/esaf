import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createApiToken,
  createDiskStorage,
  createProfile,
  decideMembership,
  DomainError,
  grantRoleAsOperator,
  loadViewer,
  type ObjectStorage,
  type Viewer,
} from '@esaf/core'
import { createDb, loadRootEnv, runMigrations, schema, type Db } from '@esaf/db'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { eq, isNotNull, sql } from 'drizzle-orm'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MCP_RECIPES, MCP_TOOL_GROUPS } from '../src/catalog.ts'
import { createAdminMcpHttpHandler } from '../src/index.ts'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

const APP_URL = 'http://localhost:3000'
const ENDPOINT = `${APP_URL}/api/mcp`

const png = (size = 400) =>
  sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 200, g: 40, b: 40, alpha: 1 },
    },
  })
    .png()
    .toBuffer()

describe.skipIf(!url)('MCP-serveren over HTTP', () => {
  let db: Db
  let dir: string
  let storage: ObjectStorage
  let owner: Viewer
  let admin: Viewer
  let handle: (request: Request) => Promise<Response>
  /** Adressene verktøyene har bedt om å hente bilder fra. */
  const fetched: string[] = []

  beforeAll(async () => {
    await runMigrations(url!)
    db = createDb(url!)
    dir = await mkdtemp(join(tmpdir(), 'esaf-mcp-'))
    storage = createDiskStorage(dir)
    handle = createAdminMcpHttpHandler({
      db,
      storage,
      appUrl: APP_URL,
      clientAddress: (request) => request.headers.get('x-test-address') ?? '203.0.113.7',
      // Forutsigbar «modell»: rakett, romfart og space er samme begrep.
      embedder: {
        model: 'test-model',
        async embed(texts) {
          return texts.map((t) => {
            const space = (t.toLowerCase().match(/space|romfart|rakett|satellitt/g) ?? []).length
            const len = Math.hypot(0.3, space)
            return new Float32Array([0.3 / len, space / len])
          })
        },
      },
      // Ingen nettverk i testene: bildene lages her.
      fetchImage: async (imageUrl) => {
        fetched.push(imageUrl)
        if (imageUrl.includes('mangler')) throw new DomainError('Fikk svar 404 fra example.com.')
        return png()
      },
    })
  })
  afterAll(async () => {
    await db?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  async function account(name: string, { twoFactor = false } = {}) {
    const id = randomUUID()
    await db.insert(schema.user).values({
      id,
      name,
      email: `${name.toLowerCase()}@example.test`,
      emailVerified: true,
      twoFactorEnabled: twoFactor,
    })
    return id
  }

  beforeEach(async () => {
    fetched.length = 0
    await db.execute(
      sql`truncate ${schema.apiToken}, ${schema.fieldSource}, ${schema.auditEvent}, ${schema.membership}, ${schema.personCohort}, ${schema.personEmail}, ${schema.person}, ${schema.cohort}, ${schema.user}, ${schema.company}, ${schema.quote}, ${schema.invitation}, ${schema.event}, ${schema.eventParticipation} cascade`,
    )
    for (const [name, role] of [
      ['Eier', 'owner'],
      ['Admin', 'admin'],
    ] as const) {
      await account(name, { twoFactor: true })
      await grantRoleAsOperator(db, {
        email: `${name.toLowerCase()}@example.test`,
        reason: 'test',
        role,
      })
    }
    const users = await db.select().from(schema.user)
    owner = await loadViewer(db, users.find((u) => u.name === 'Eier')!.id)
    admin = await loadViewer(db, users.find((u) => u.name === 'Admin')!.id)
  })

  const tokenFor = async (viewer: Viewer, readOnly = false) =>
    (await createApiToken(db, viewer, { name: 'Claude Code', days: 30, readOnly })).token

  /** En ekte MCP-klient mot håndtereren, uten nettverk. */
  async function connect(token: string) {
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(ENDPOINT), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: (input, init) => handle(new Request(input, init)),
      }),
    )
    return client
  }

  async function call<T = Record<string, unknown>>(
    client: Client,
    name: string,
    args: object = {},
  ) {
    const result = await client.callTool({ name, arguments: args as Record<string, unknown> })
    const text = (result.content as { type: string; text: string }[])[0]!.text
    if (result.isError) throw new Error(text)
    return JSON.parse(text) as T
  }

  async function callError(client: Client, name: string, args: object = {}) {
    const result = await client.callTool({ name, arguments: args as Record<string, unknown> })
    expect(result.isError).toBe(true)
    return (result.content as { text: string }[])[0]!.text
  }

  const post = (headers: Record<string, string>) =>
    handle(
      new Request(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    )

  describe('tilgang', () => {
    it('avviser forespørsler uten gyldig nøkkel, fra andre nettsteder og fra kontoer uten rettigheten', async () => {
      const missing = await post({})
      expect(missing.status).toBe(401)
      expect(missing.headers.get('www-authenticate')).toMatch(/^Bearer realm="ESAF"/)
      expect((await post({ authorization: `Bearer esaf_${'x'.repeat(43)}` })).status).toBe(401)

      const token = await tokenFor(admin)
      expect(
        (await post({ authorization: `Bearer ${token}`, origin: 'https://evil.example' })).status,
      ).toBe(403)

      // Rollen tas bort: nøkkelen trekkes tilbake og virker ikke lenger.
      const { changeRole } = await import('@esaf/core')
      await changeRole(db, owner, { personId: admin!.personId!, role: 'member' })
      expect((await post({ authorization: `Bearer ${token}` })).status).toBe(401)
    })

    it('stopper mange avviste forsøk fra samme adresse', async () => {
      const statuses: number[] = []
      for (let i = 0; i < 22; i++)
        statuses.push((await post({ 'x-test-address': '198.51.100.9' })).status)
      expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true)
      expect(statuses.at(-1)).toBe(429)
    })

    it('en nøkkel med bare lesing ser bare verktøy som leser', async () => {
      const full = await connect(await tokenFor(admin))
      const read = await connect(await tokenFor(owner, true))
      const all = (await full.listTools()).tools
      const readOnly = (await read.listTools()).tools
      expect(all.length).toBeGreaterThan(60)
      expect(readOnly.every((t) => t.annotations?.readOnlyHint)).toBe(true)
      expect(readOnly.map((t) => t.name)).toContain('get_person')
      expect(readOnly.map((t) => t.name)).not.toContain('create_profiles')
      await expect(
        read.callTool({ name: 'create_company', arguments: { name: 'X' } }),
      ).rejects.toThrow(/not found/)
      const destructive = all.filter((t) => t.annotations?.destructiveHint).map((t) => t.name)
      expect(destructive).toEqual(
        expect.arrayContaining(['delete_profile', 'merge_people', 'delete_company']),
      )
      // Alle verktøy har beskrivelse og et JSON-skjema som modellen kan lese.
      for (const tool of all) {
        expect(tool.description?.length, tool.name).toBeGreaterThan(20)
        expect(tool.inputSchema.type, tool.name).toBe('object')
      }
      const { prompts } = await full.listPrompts()
      // Oversikten på adminsiden «MCP» viser nøyaktig det serveren har.
      const sorted = (names: readonly string[]) => [...names].sort()
      expect(sorted(MCP_TOOL_GROUPS.flatMap((g) => g.tools))).toEqual(
        sorted(all.map((t) => t.name)),
      )
      expect(sorted(MCP_RECIPES.map((r) => r.name))).toEqual(sorted(prompts.map((p) => p.name)))
      await full.close()
      await read.close()
    })

    it('rettighetene er kontoens egne: en admin kan ikke endre roller', async () => {
      const client = await connect(await tokenFor(admin))
      const overview = await call<{ actingAs: { role: string } }>(client, 'overview')
      expect(overview.actingAs.role).toBe('admin')
      expect(
        await callError(client, 'change_role', { personId: owner!.personId, role: 'member' }),
      ).toBe('Rollen din gir ikke tilgang til dette.')
      await client.close()
    })
  })

  describe('profiler', () => {
    it('lager et kull med bilder i to steg, og alt merkes med nøkkelen i loggen', async () => {
      await createProfile(db, admin, {
        fullName: 'Kari Nordmann',
        cohorts: [{ graduationYear: 2027, relation: 'student' }],
        emails: ['kari@example.test'],
        status: 'active',
      })
      const client = await connect(await tokenFor(admin))
      const profiles = [
        {
          ref: '1',
          fullName: 'Ola Nordmann',
          cohorts: [{ graduationYear: 2027 }],
          photoUrl: 'https://example.com/ola.jpg',
          studyBackground: 'Industriell økonomi',
        },
        { ref: '2', fullName: 'Kari Nordmann', cohorts: [{ graduationYear: 2027 }] },
        {
          ref: '3',
          fullName: 'Per Hansen',
          cohorts: [{ graduationYear: 2027 }],
          photoUrl: 'https://example.com/mangler.jpg',
        },
      ]
      const plan = await call<{
        dryRun: boolean
        counts: Record<string, number>
        rows: { status: string }[]
      }>(client, 'create_profiles', { profiles })
      expect(plan.dryRun).toBe(true)
      expect(plan.counts).toEqual({ create: 2, duplicate: 1, invalid: 0 })
      expect(fetched).toEqual([])
      expect(await db.$count(schema.person)).toBe(3)

      const done = await call<{
        created: number
        rows: { ref: string; personId: string | null; warnings: string[]; link: string | null }[]
      }>(client, 'create_profiles', { profiles, dryRun: false })
      expect(done.created).toBe(2)
      expect(fetched.sort()).toEqual([
        'https://example.com/mangler.jpg',
        'https://example.com/ola.jpg',
      ])
      const [ola, kari, per] = done.rows
      expect(ola!.link).toBe(`${APP_URL}/medlemmer/${ola!.personId}`)
      expect(kari!.personId).toBeNull()
      expect(per!.warnings[0]).toMatch(/Bildet ble ikke hentet/)

      const person = await call<{
        photo: string | null
        studyBackground: string
        cohorts: unknown[]
      }>(client, 'get_person', { personId: ola!.personId })
      expect(person.photo).toMatch(new RegExp(`^${APP_URL}/api/bilder/`))
      expect(person.studyBackground).toBe('Industriell økonomi')

      const tagged = await db
        .select({ action: schema.auditEvent.action })
        .from(schema.auditEvent)
        .where(isNotNull(schema.auditEvent.apiTokenId))
      expect(tagged.map((r) => r.action).sort()).toEqual([
        'profile.batch_create',
        'profile.create',
        'profile.create',
      ])
      const log = await call<{ action: string; viaMcp: string | null }[]>(
        client,
        'list_audit_log',
        {
          viaMcp: true,
        },
      )
      expect(log.every((e) => e.viaMcp === 'Claude Code')).toBe(true)
      await client.close()
    })

    it('oppdaterer bare feltene som sendes, med kilder, og rører aldri kontaktinfo på profiler med konto', async () => {
      const client = await connect(await tokenFor(admin))
      const [{ personId }] = (
        await call<{ rows: { personId: string }[] }>(client, 'create_profiles', {
          dryRun: false,
          profiles: [
            { fullName: 'Ada Lovelace', city: 'Oslo', cohorts: [{ graduationYear: 2020 }] },
          ],
        })
      ).rows as [{ personId: string }]

      const updated = await call<{
        contactFilled: string[]
        person: {
          city: string
          bio: string
          contact: { phone: string }
          sources: { field: string; label: string }[]
        }
      }>(client, 'update_person', {
        personId,
        bio: 'Gründer og daglig leder i Analytisk.',
        phone: '41234567',
        sources: [{ field: 'bio', url: 'https://www.analytisk.no/om', confidence: 'high' }],
      })
      expect(updated.person.city).toBe('Oslo')
      expect(updated.person.bio).toBe('Gründer og daglig leder i Analytisk.')
      expect(updated.contactFilled).toEqual(['phone'])
      expect(updated.person.contact.phone).toBe('+47 412 34 567')
      expect(updated.person.sources).toEqual([
        expect.objectContaining({ field: 'bio', label: 'analytisk.no' }),
      ])

      const experience = await call<{ company: string; experienceId: string }[]>(
        client,
        'add_experience',
        {
          personId,
          company: 'Analytisk',
          title: 'Daglig leder',
          founder: true,
        },
      )
      expect(experience).toMatchObject([{ company: 'Analytisk' }])
      expect(
        await call<unknown[]>(client, 'remove_experience', {
          personId,
          experienceId: experience[0]!.experienceId,
        }),
      ).toEqual([])

      expect(
        await callError(client, 'update_person', { personId: admin!.personId, phone: '41234567' }),
      ).toMatch(/bare personen selv/)

      // Alt eller ingenting: et annet telefonnummer enn det som står, avvises, og
      // bioen i samme kall lagres heller ikke.
      expect(
        await callError(client, 'update_person', {
          personId,
          bio: 'Noe helt annet.',
          phone: '99887766',
        }),
      ).toBeTruthy()
      const after = await call<{ bio: string; contact: { phone: string } }>(client, 'get_person', {
        personId,
      })
      expect(after.bio).toBe('Gründer og daglig leder i Analytisk.')
      expect(after.contact.phone).toBe('+47 412 34 567')

      // ES-selskapet byttes på navnet, selv om profilen har en id fra før.
      await call(client, 'update_person', { personId, esCompany: 'Gammelt AS' })
      const renamed = await call<{ person: { esCompany: { name: string } } }>(
        client,
        'update_person',
        { personId, esCompany: 'Nytt AS' },
      )
      expect(renamed.person.esCompany.name).toBe('Nytt AS')
      await client.close()
    })

    it('setter profilbilde fra en adresse, og sletter en profil med begrunnelse', async () => {
      const client = await connect(await tokenFor(admin))
      const { personId } = await createProfile(db, admin, {
        fullName: 'Med Bilde',
        cohorts: [],
        emails: [],
        status: 'active',
      })
      const photo = await call<{ photo: string }>(client, 'set_profile_photo', {
        personId,
        imageUrl: 'https://example.com/portrett.png',
        source: { label: 'entreprenorskolen.no', confidence: 'high' },
      })
      expect(photo.photo).toMatch(/\/api\/bilder\/.+-512\.webp$/)
      expect(await callError(client, 'set_profile_photo', { personId })).toMatch(/enten imageUrl/)
      expect(
        await callError(client, 'set_profile_photo', { personId, imageBase64: 'ikke base64!' }),
      ).toMatch(/base64/)

      expect(await callError(client, 'delete_profile', { personId, reason: 'x' })).toMatch(
        /Invalid|reason|tegn/i,
      )
      await call(client, 'delete_profile', { personId, reason: 'Lagt inn ved en feil' })
      expect(await db.select().from(schema.person).where(eq(schema.person.id, personId))).toEqual(
        [],
      )
      await client.close()
    })
  })

  describe('selskaper, sitater og arrangementer', () => {
    it('lager og beriker et selskap med logo, historikk, sak og sitat', async () => {
      const client = await connect(await tokenFor(admin))
      const created = await call<{ companyId: string; slug: string; status: string }>(
        client,
        'create_company',
        {
          name: 'Syrlig AS',
          website: 'syrlig.no',
          sources: [{ field: 'website', url: 'https://www.proff.no/syrlig', confidence: 'high' }],
        },
      )
      expect(created).toMatchObject({ slug: 'syrlig-as', status: 'unknown' })
      const { companyId } = created

      const updated = await call<{ tagline: string; website: string; status: string }>(
        client,
        'update_company',
        {
          companyId,
          tagline: 'Fermenterte drikker fra Trondheim',
          status: 'active',
        },
      )
      expect(updated).toMatchObject({ website: 'https://syrlig.no', status: 'active' })

      const logo = await call<{ logo: string }>(client, 'set_company_logo', {
        companyId,
        imageBase64: (await png(256)).toString('base64'),
      })
      expect(logo.logo).toMatch(/\/api\/logoer\//)

      await call(client, 'add_company_event', {
        companyId,
        year: 2019,
        type: 'founded',
        text: 'Selskapet ble grunnlagt.',
        sourceUrl: 'https://www.proff.no/syrlig',
      })
      await call(client, 'add_company_article', {
        companyId,
        url: 'https://www.adressa.no/sak?utm_source=x',
        title: 'Syrlig vokser',
        year: 2021,
      })
      await call(client, 'add_quote', {
        text: 'Vi startet på ES.',
        speakerName: 'Ola Nordmann',
        confidence: 'high',
        companyId,
        sourceUrl: 'https://www.adressa.no/sak',
      })
      const details = await call<{
        events: unknown[]
        articles: { url: string }[]
        quotes: unknown[]
        sources: { field: string }[]
      }>(client, 'get_company', { slug: 'syrlig-as' })
      expect(details.events).toHaveLength(1)
      expect(details.articles[0]!.url).toBe('https://www.adressa.no/sak')
      expect(details.quotes).toHaveLength(1)
      expect(details.sources.map((s) => s.field)).toEqual(['website'])

      const list = await call<{ total: number }>(client, 'list_companies', { missing: ['logo'] })
      expect(list.total).toBe(0)
      await client.close()
    })

    it('lager en type, et arrangement og legger til deltakere', async () => {
      const client = await connect(await tokenFor(admin))
      const type = await call<{ id: string; slug: string }>(client, 'create_event_type', {
        name: `Testkveld ${randomUUID().slice(0, 8)}`,
      })
      const { eventId } = await call<{ eventId: string }>(client, 'create_event', {
        typeId: type.id,
        name: 'Fagkveld vår 2024',
        startDate: '2024-03-01',
        datePrecision: 'semester',
      })
      await call(client, 'add_event_participants', {
        eventId,
        personIds: [admin!.personId],
        role: 'organizer',
      })
      const event = await call<{ startDate: string; groups: { people: { role: string }[] }[] }>(
        client,
        'update_event',
        { eventId, location: 'Trondheim' },
      )
      expect(event.startDate).toBe('2024-01-01')
      expect(event.groups.flatMap((g) => g.people)).toMatchObject([{ role: 'organizer' }])
      await client.close()
    })

    it('lager invitasjonslenker med appens adresse', async () => {
      const client = await connect(await tokenFor(admin))
      const link = await call<{ url: string; role: string }>(client, 'create_invitation', {
        email: 'ny@example.test',
      })
      expect(link.url).toMatch(new RegExp(`^${APP_URL}/invitasjon/[A-Za-z0-9_-]{43}$`))
      expect(
        await callError(client, 'create_invitation', { email: 'ny2@example.test', role: 'admin' }),
      ).toMatch(/hovedadmin/)
      await client.close()
    })
  })

  describe('finne folk og ES-universet', () => {
    it('søker på hva folk kan, og søkeord gjør dem lettere å finne', async () => {
      const client = await connect(await tokenFor(admin))
      const created = await call<{ rows: { personId: string }[] }>(client, 'create_profiles', {
        dryRun: false,
        profiles: [
          {
            fullName: 'Kari Rakett',
            cohorts: [{ graduationYear: 2014 }],
            bio: 'Kari bygger rakettmotorer i Trondheim.',
          },
          {
            fullName: 'Ola Annen',
            cohorts: [{ graduationYear: 2015 }],
            bio: 'Ola selger kaffe og elsker sykling.',
          },
        ],
      })
      const [kari, ola] = created.rows.map((r) => r.personId)
      const before = await call<{ hits: { personId: string }[] }>(client, 'find_people', {
        query: 'romfart',
      })
      expect(before.hits).toEqual([])

      const todo = await call<{ items: { personId: string; status: string; text: string[] }[] }>(
        client,
        'list_people_for_tagging',
        {},
      )
      expect(todo.items.find((i) => i.personId === ola)).toMatchObject({
        status: 'missing',
        text: [expect.stringContaining('kaffe')],
      })

      const tagged = await call<{ updated: number; indexed: number }>(client, 'set_search_topics', {
        people: [
          { personId: kari, topics: ['romfart', 'space', 'rakettmotorer'] },
          { personId: ola, topics: ['kaffe', 'coffee'] },
        ],
      })
      expect(tagged.updated).toBe(2)
      expect(tagged.indexed).toBeGreaterThanOrEqual(2)
      const after = await call<{
        semantic: boolean
        hits: { personId: string; reason: string; link: string }[]
      }>(client, 'find_people', { query: 'space' })
      expect(after.semantic).toBe(true)
      expect(after.hits.map((h) => h.personId)).toEqual([kari])
      expect(after.hits[0]!.link).toBe(`${APP_URL}/medlemmer/${kari}`)
      const left = await call<{ items: { personId: string }[] }>(
        client,
        'list_people_for_tagging',
        {},
      )
      expect(left.items.map((i) => i.personId)).not.toContain(kari)
      await client.close()
    })

    it('ES-universet er en MCP App med data i structuredContent', async () => {
      const client = await connect(await tokenFor(admin))
      const { tools } = await client.listTools()
      const tool = tools.find((t) => t.name === 'show_universe')!
      expect(tool._meta).toMatchObject({ ui: { resourceUri: 'ui://esaf/universe.html' } })
      const resource = await client.readResource({ uri: 'ui://esaf/universe.html' })
      const content = resource.contents[0] as { mimeType: string; text: string }
      expect(content.mimeType).toBe('text/html;profile=mcp-app')
      expect(content.text).toContain('ES-universet')
      expect(content.text).not.toMatch(/<script[^>]+src=/)

      await call(client, 'create_profiles', {
        dryRun: false,
        profiles: [
          { fullName: 'Kari Gründer', cohorts: [{ graduationYear: 2014 }], esCompany: 'Syrlig' },
        ],
      })
      const result = await client.callTool({ name: 'show_universe', arguments: {} })
      expect((result.content as { text: string }[])[0]!.text).toMatch(/^ES-universet: \d+ personer/)
      const data = result.structuredContent as {
        appUrl: string
        people: { name: string }[]
        companies: { name: string }[]
        links: { role: string }[]
      }
      expect(data.appUrl).toBe(APP_URL)
      expect(data.people.map((p) => p.name)).toContain('Kari Gründer')
      expect(data.companies.map((c) => c.name)).toEqual(['Syrlig'])
      expect(data.links).toEqual([expect.objectContaining({ role: 'es' })])
      await client.close()
    })
  })

  it('medlemmer uten adminrolle kan ikke lage nøkler', async () => {
    const id = await account('Medlem')
    const v = await loadViewer(db, id)
    await decideMembership(db, admin, { personId: v!.personId!, decision: 'approve' })
    await expect(tokenFor(await loadViewer(db, id))).rejects.toThrow()
  })
})
