import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  allDatasetOptions,
  createTarGz,
  DatasetError,
  describeDatasetOptions,
  filterDataset,
  readDatasetBundle,
  readTarGz,
  writeDatasetBundle,
  type Dataset,
} from '../src/index.ts'

// Bare oppdiktede data. Ekte data fra berikelsen skal aldri ligge i repoet.

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 4, 5, 6])

const dataset = (): Dataset => ({
  companies: [
    {
      key: 'company:syrlig',
      name: 'Syrlig',
      tagline: 'Syltetøy med smak',
      description: null,
      website: 'https://syrlig.example',
      foundedYear: 2019,
      location: 'Trondheim',
      industries: ['Mat'],
      status: 'active',
      lastSeenOnEsSite: null,
      logo: { file: 'images/logos/syrlig.png', source: null, confidence: 'high' },
      fieldSources: {},
      timeline: [],
      articles: [
        {
          url: 'https://avis.example/syrlig',
          title: 'Syrlig vokser',
          date: '2021-05',
          publisher: 'Avisa',
          paywall: true,
          mentionsES: false,
        },
      ],
    },
  ],
  people: [
    {
      key: 'person:kari-2019',
      fullName: 'Kari Nordmann',
      graduationYears: [2019],
      emails: ['kari@example.test'],
      phone: '+47 400 00 000',
      linkedinUrl: null,
      studyBackground: null,
      bio: 'Lager syltetøy.',
      expertise: [],
      industries: [],
      photo: { file: 'images/photos/kari.jpg', source: null, confidence: 'high' },
      companies: [
        {
          companyKey: 'company:syrlig',
          role: 'founder',
          title: null,
          startYear: 2019,
          endYear: null,
        },
      ],
      fieldSources: {
        bio: {
          confidence: 'high',
          sources: [{ label: 'example.test', url: null, fetchedAt: null }],
        },
        photo: {
          confidence: 'high',
          sources: [{ label: 'example.test', url: null, fetchedAt: null }],
        },
      },
    },
  ],
  quotes: [
    {
      key: 'quote:1',
      text: 'ES ga oss motet.',
      speakerName: 'Kari Nordmann',
      speakerRole: null,
      date: null,
      personKey: 'person:kari-2019',
      companyKey: 'company:syrlig',
      source: null,
      confidence: 'high',
    },
  ],
})

const imageFiles = () =>
  new Map([
    ['images/logos/syrlig.png', png],
    ['images/photos/kari.jpg', jpg],
    ['images/photos/ubrukt.jpg', jpg],
  ])

/** Pakker filene på nytt med et manifest som stemmer, etter at noe er endret. */
function repack(files: Map<string, Uint8Array>, edit: (manifest: Record<string, unknown>) => void) {
  const manifest = JSON.parse(Buffer.from(files.get('manifest.json')!).toString('utf8'))
  edit(manifest)
  const entries = [...files].filter(([path]) => path !== 'manifest.json')
  return createTarGz([
    { path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
    ...entries.map(([path, data]) => ({ path, data })),
  ])
}

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

describe('tar', () => {
  it('pakker og pakker ut filene uendret, også lange stier', () => {
    const long = `images/photos/${'a'.repeat(70)}/${'b'.repeat(60)}.jpg`
    const archive = createTarGz([
      { path: 'manifest.json', data: Buffer.from('{}') },
      { path: long, data: jpg },
      { path: 'tom.txt', data: new Uint8Array() },
    ])
    const files = readTarGz(archive)
    expect([...files.keys()]).toEqual(['manifest.json', long, 'tom.txt'])
    expect(Buffer.from(files.get(long)!)).toEqual(Buffer.from(jpg))
    expect(files.get('tom.txt')!.byteLength).toBe(0)
  })

  it('avviser utrygge stier og ødelagte filer', () => {
    expect(() => createTarGz([{ path: '../ut.txt', data: jpg }])).toThrow(/Ugyldig sti/)
    expect(() => createTarGz([{ path: '/etc/passwd', data: jpg }])).toThrow(/Ugyldig sti/)
    expect(() => readTarGz(Buffer.from('ikke en tar'))).toThrow(/gyldig .tar.gz/)
    const archive = createTarGz([{ path: 'a.txt', data: jpg }])
    const broken = Buffer.from(archive)
    broken[broken.length - 12]! ^= 0xff
    expect(() => readTarGz(broken)).toThrow()
  })
})

describe('datasettbunten', () => {
  it('skriver og leser en bunt, med bare bildene som brukes', () => {
    const { archive, manifest } = writeDatasetBundle(
      dataset(),
      imageFiles(),
      new Date('2026-10-29T12:00:00Z'),
    )
    expect(manifest).toMatchObject({
      format: 'esaf-datasett',
      schemaVersion: 1,
      createdAt: '2026-10-29T12:00:00.000Z',
      counts: { companies: 1, people: 1, quotes: 1, articles: 1, photos: 1, logos: 1 },
    })
    expect(Object.keys(manifest.files)).not.toContain('images/photos/ubrukt.jpg')

    const bundle = readDatasetBundle(archive)
    expect(bundle.data).toEqual(dataset())
    expect([...bundle.images.keys()].sort()).toEqual([
      'images/logos/syrlig.png',
      'images/photos/kari.jpg',
    ])
    expect(bundle.warnings).toEqual([])
  })

  it('forkaster felt som ikke er i skjemaet, som fødselsdatoer', () => {
    const data = dataset()
    const person = {
      ...data.people[0]!,
      birthDate: '1990-01-01',
      brregRoles: [{ birthYearMatched: '1990' }],
    }
    const { archive } = writeDatasetBundle({ ...data, people: [person] }, imageFiles())
    const files = readTarGz(archive)
    const stored = Buffer.from(files.get('out/people.json')!).toString('utf8')
    expect(stored).not.toMatch(/birth|1990|brreg/i)
    expect(readDatasetBundle(archive).data.people[0]).not.toHaveProperty('birthDate')
  })

  it('avviser feil format, skjemaversjon og manifest', () => {
    const files = readTarGz(writeDatasetBundle(dataset(), imageFiles()).archive)
    expect(() => readDatasetBundle(repack(files, (m) => (m.format = 'noe-annet')))).toThrow(
      /Ikke en ESAF-datasettbunt/,
    )
    expect(() => readDatasetBundle(repack(files, (m) => (m.schemaVersion = 2)))).toThrow(
      /skjemaversjon 2/,
    )
    expect(() =>
      readDatasetBundle(repack(files, (m) => ((m.counts as Record<string, number>).people = 5))),
    ).toThrow(/Antallet i manifestet/)
    const withoutManifest = createTarGz([{ path: 'out/people.json', data: Buffer.from('[]') }])
    expect(() => readDatasetBundle(withoutManifest)).toThrow(/mangler manifest.json/)
  })

  it('avviser endrede, manglende og ekstra filer', () => {
    const files = readTarGz(writeDatasetBundle(dataset(), imageFiles()).archive)

    const changed = new Map(files)
    changed.set('images/photos/kari.jpg', png)
    expect(() => readDatasetBundle(repack(changed, () => {}))).toThrow(/endret eller ødelagt/)

    const missing = new Map(files)
    missing.delete('images/logos/syrlig.png')
    expect(() => readDatasetBundle(repack(missing, () => {}))).toThrow(/mangler i bunten/)

    const extra = new Map(files)
    extra.set('images/photos/smuglet.jpg', jpg)
    expect(() => readDatasetBundle(repack(extra, () => {}))).toThrow(/ikke i manifestet/)
  })

  it('avviser ugyldige data og bilder som mangler', () => {
    const files = readTarGz(writeDatasetBundle(dataset(), imageFiles()).archive)
    const broken = new Map(files)
    const people = Buffer.from(JSON.stringify([{ key: 'person:x', fullName: '', emails: [] }]))
    broken.set('out/people.json', people)
    expect(() =>
      readDatasetBundle(
        repack(
          broken,
          (m) => ((m.files as Record<string, string>)['out/people.json'] = sha(people)),
        ),
      ),
    ).toThrow(/out\/people.json, element 1: fullName/)

    expect(() => writeDatasetBundle(dataset(), new Map())).toThrow(DatasetError)
    const twice = dataset()
    twice.companies.push({ ...twice.companies[0]! })
    expect(() => writeDatasetBundle(twice, imageFiles())).toThrow(/Samme nøkkel/)
  })

  it('advarer om koblinger til noe som ikke er i bunten', () => {
    const data = dataset()
    data.people[0]!.companies.push({
      companyKey: 'company:finnes-ikke',
      role: 'employee',
      title: null,
      startYear: null,
      endYear: null,
    })
    data.quotes[0]!.personKey = 'person:finnes-ikke'
    const { warnings } = readDatasetBundle(writeDatasetBundle(data, imageFiles()).archive)
    expect(warnings).toEqual([
      expect.stringMatching(/1 koblinger fra personer/),
      expect.stringMatching(/1 sitater viser til/),
    ])
  })
})

describe('valgene for importen', () => {
  it('tar med alt som standard', () => {
    expect(filterDataset(dataset(), allDatasetOptions)).toEqual(dataset())
    expect(describeDatasetOptions(allDatasetOptions)).toEqual([])
  })

  it('--bare-selskaper tar bare med selskapene, med logo, historikk og saker', () => {
    const filtered = filterDataset(dataset(), { ...allDatasetOptions, onlyCompanies: true })
    expect(filtered.people).toEqual([])
    expect(filtered.quotes).toEqual([])
    expect(filtered.companies).toEqual(dataset().companies)
    expect(describeDatasetOptions({ ...allDatasetOptions, onlyCompanies: true })).toEqual([
      'bare selskaper',
    ])
  })

  it('--uten-profilbilder, --uten-bio og --uten-sitater', () => {
    const options = { onlyCompanies: false, photos: false, quotes: false, bio: false }
    const filtered = filterDataset(dataset(), options)
    expect(filtered.people[0]).toMatchObject({ photo: null, bio: null, fieldSources: {} })
    expect(filtered.people[0]!.emails).toEqual(['kari@example.test'])
    expect(filtered.quotes).toEqual([])
    expect(describeDatasetOptions(options)).toEqual([
      'uten profilbilder',
      'uten sitater',
      'uten bio',
    ])
  })

  it('endrer ikke dataene som sendes inn', () => {
    const data = dataset()
    filterDataset(data, { onlyCompanies: false, photos: false, quotes: true, bio: false })
    expect(data).toEqual(dataset())
  })
})
