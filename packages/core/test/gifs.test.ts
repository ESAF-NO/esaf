import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import {
  createGifSearch,
  DomainError,
  GifsUnavailableError,
  processAssetImage,
  type Viewer,
} from '../src/index.ts'
import { inspectUpload, MAX_ANIMATED_PIXELS } from '../src/images.ts'

const viewer = {
  personId: '11111111-1111-4111-8111-111111111111',
  userId: 'u',
  emailVerified: true,
  membership: { status: 'active', role: 'member' },
} as unknown as Viewer

const gif = (over: Record<string, unknown> = {}) => ({
  id: 'abc123',
  title: 'Dans',
  rating: 'g',
  images: {
    fixed_width: {
      url: 'https://media1.giphy.com/media/abc123/200w.gif',
      webp: 'https://media1.giphy.com/media/abc123/200w.webp',
      width: '200',
      height: '150',
    },
    downsized_medium: { url: 'https://media2.giphy.com/media/abc123/giphy.gif' },
  },
  ...over,
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const list = (data: unknown[], total = data.length) =>
  json({ data, pagination: { total_count: total, count: data.length } })

async function animation(width: number, height: number, frames: number) {
  const images = await Promise.all(
    Array.from({ length: frames }, (_, i) =>
      sharp({
        // Alle bildene må være ulike: like bilder etter hverandre slås sammen til ett.
        create: {
          width,
          height,
          channels: 3,
          background: { r: (i * 37) % 256, g: (i * 11) % 256, b: 90 },
        },
      })
        .png()
        .toBuffer(),
    ),
  )
  return sharp(images, { join: { animated: true } })
    .gif({ delay: 80 })
    .toBuffer()
}

describe('GIF-søket', () => {
  it('sender aldersgrensen og gir forhåndsvisningen', async () => {
    const fetch = vi.fn(async () => list([gif()]))
    const page = await createGifSearch('nøkkel', { fetch }).search(viewer, ' Dans ')
    const url = new URL(String((fetch.mock.calls as unknown[][])[0]![0]))
    expect(url.pathname).toBe('/v1/gifs/search')
    expect(url.searchParams.get('q')).toBe('dans')
    expect(url.searchParams.get('rating')).toBe('pg')
    expect(page.results).toEqual([
      {
        id: 'abc123',
        title: 'Dans',
        preview: {
          url: 'https://media1.giphy.com/media/abc123/200w.webp',
          width: 200,
          height: 150,
        },
      },
    ])
    expect(page.nextOffset).toBeNull()
  })

  it('viser det som er populært uten søkeord', async () => {
    const fetch = vi.fn(async () => list([gif()]))
    await createGifSearch('k', { fetch }).search(viewer, '')
    expect(String((fetch.mock.calls as unknown[][])[0]![0])).toContain('/v1/gifs/trending')
  })

  it('tar bort treff med for høy aldersgrense eller forhåndsvisning fra andre steder', async () => {
    const elsewhere = gif({
      id: 'b',
      images: {
        fixed_width: { url: 'https://evil.example/x.gif', width: '1', height: '1' },
      },
    })
    const fetch = vi.fn(async () => list([gif({ id: 'a', rating: 'r' }), elsewhere, gif()]))
    const page = await createGifSearch('k', { fetch }).search(viewer, 'x')
    expect(page.results.map((g) => g.id)).toEqual(['abc123'])
  })

  it('mellomlagrer, så samme søk ikke bruker av nøkkelen', async () => {
    const fetch = vi.fn(async () => list([gif()]))
    const gifs = createGifSearch('k', { fetch })
    await gifs.search(viewer, 'dans')
    await gifs.search(viewer, 'DANS')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('stopper den som søker for raskt', async () => {
    const gifs = createGifSearch('k', { fetch: async () => list([]) })
    for (let i = 0; i < 30; i++) await gifs.search(viewer, `ord ${i}`)
    await expect(gifs.search(viewer, 'en til')).rejects.toThrow('veldig raskt')
  })

  it('sier fra med en vanlig melding, uten nøkkelen, når GIPHY feiler', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const gifs = createGifSearch('hemmelig', { fetch: async () => json({}, 429) })
    const error = await gifs.search(viewer, 'x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DomainError)
    expect(JSON.stringify(log.mock.calls)).not.toContain('hemmelig')
    log.mockRestore()
  })

  it('krever et aktivt medlem', async () => {
    const fetch = vi.fn(async () => list([]))
    const outsider = { ...viewer, membership: null } as unknown as Viewer
    await expect(createGifSearch('k', { fetch }).search(outsider, 'x')).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('når GIPHY ikke kan brukes', () => {
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {})

  it('lar GIPHY være i fred i fem minutter etter at grensen er nådd', async () => {
    const log = quiet()
    let time = 1_000_000
    const fetch = vi.fn(async () => json({}, 429))
    const gifs = createGifSearch('k', { fetch, now: () => time })
    await expect(gifs.search(viewer, 'a')).rejects.toBeInstanceOf(GifsUnavailableError)
    await expect(gifs.search(viewer, 'b')).rejects.toBeInstanceOf(GifsUnavailableError)
    expect(fetch).toHaveBeenCalledTimes(1)
    time += 5 * 60_000 + 1
    await expect(gifs.search(viewer, 'c')).rejects.toBeInstanceOf(GifsUnavailableError)
    expect(fetch).toHaveBeenCalledTimes(2)
    log.mockRestore()
  })

  it('gir gamle svar på samme søk i stedet for å feile', async () => {
    const log = quiet()
    let time = 1_000_000
    let limited = false
    const fetch = vi.fn(async () => (limited ? json({}, 429) : list([gif()])))
    const gifs = createGifSearch('k', { fetch, now: () => time })
    const first = await gifs.search(viewer, 'dans')
    time += 11 * 60_000
    limited = true
    expect(await gifs.search(viewer, 'dans')).toEqual(first)
    log.mockRestore()
  })

  it('mellomlagrer det populære lenger enn søk', async () => {
    let time = 1_000_000
    const fetch = vi.fn(async () => list([gif()]))
    const gifs = createGifSearch('k', { fetch, now: () => time })
    await gifs.search(viewer, '')
    time += 59 * 60_000
    await gifs.search(viewer, '')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('å velge en GIF fra et søk koster ingen kall, heller ikke når grensen er nådd', async () => {
    const log = quiet()
    let limited = false
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (!String(url).includes('api.giphy.com')) return new Response(new Uint8Array([1]))
      return limited ? json({}, 429) : list([gif()])
    })
    const gifs = createGifSearch('k', { fetch })
    await gifs.search(viewer, 'dans')
    limited = true
    await gifs.search(viewer, 'noe annet').catch(() => {})
    expect((await gifs.download('abc123')).title).toBe('Dans')
    log.mockRestore()
  })
})

describe('nedlasting av en valgt GIF', () => {
  const bytes = new Uint8Array([1, 2, 3])

  it('henter fila uten å følge omdirigeringer', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('api.giphy.com') ? json({ data: gif() }) : new Response(bytes),
    )
    const file = await createGifSearch('k', { fetch }).download('abc123')
    expect(file.title).toBe('Dans')
    expect([...file.bytes]).toEqual([1, 2, 3])
    const [url, init] = (fetch.mock.calls as unknown as [string, RequestInit][])[1]!
    expect(url).toBe('https://media2.giphy.com/media/abc123/giphy.gif')
    expect(init.redirect).toBe('error')
  })

  it('godtar bare id-er, så ingen kan styre adressen', async () => {
    const fetch = vi.fn(async () => json({}))
    const gifs = createGifSearch('k', { fetch })
    for (const id of ['../search', 'a/b', 'a?b=1', 'https://evil.example', '']) {
      await expect(gifs.download(id)).rejects.toThrow('Fant ikke')
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('henter ikke filer fra andre steder enn GIPHY', async () => {
    const evil = gif({
      images: { downsized_medium: { url: 'http://169.254.169.254/latest/meta-data' } },
    })
    const fetch = vi.fn(async () => json({ data: evil }))
    await expect(createGifSearch('k', { fetch }).download('abc123')).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('nekter en id med for høy aldersgrense, også når nettleseren sender den', async () => {
    const fetch = vi.fn(async () => json({ data: gif({ rating: 'r' }) }))
    await expect(createGifSearch('k', { fetch }).download('abc123')).rejects.toThrow('Fant ikke')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('slutter å lese når fila blir for stor, selv uten oppgitt størrelse', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent++
        controller.enqueue(chunk)
      },
    })
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('api.giphy.com') ? json({ data: gif() }) : new Response(body),
    )
    await expect(createGifSearch('k', { fetch }).download('abc123')).rejects.toThrow('for stor')
    expect(sent).toBeLessThan(40)
  })
})

describe('animasjoner', () => {
  it('blir animert WebP i begge størrelser, med riktig høyde og uten forstørring', async () => {
    const processed = await processAssetImage(await animation(600, 300, 5))
    expect(processed).toMatchObject({ width: 600, height: 300 })
    const large = await sharp(processed.large).metadata()
    const small = await sharp(processed.small).metadata()
    expect(large).toMatchObject({ format: 'webp', pages: 5, width: 600 })
    expect(small).toMatchObject({ format: 'webp', pages: 5, width: 400 })
  })

  it('skalerer store animasjoner ned', async () => {
    const processed = await processAssetImage(await animation(1000, 500, 3))
    expect(processed).toMatchObject({ width: 800, height: 400 })
  })

  it('behandler en GIF med ett bilde som et vanlig bilde', async () => {
    const still = await sharp({
      create: { width: 300, height: 200, channels: 3, background: '#335' },
    })
      .gif()
      .toBuffer()
    const processed = await processAssetImage(still)
    expect(processed).toMatchObject({ width: 300, height: 200 })
    expect((await sharp(processed.large).metadata()).pages ?? 1).toBe(1)
  })

  it('avviser animasjoner over pikselgrensen før de behandles', async () => {
    const frames = Math.ceil(MAX_ANIMATED_PIXELS / (1000 * 1000)) + 1
    await expect(processAssetImage(await animation(1000, 1000, frames))).rejects.toThrow(
      'Animasjonen er for stor',
    )
  })

  it('slipper ikke GIF inn som profilbilde eller logo', async () => {
    await expect(inspectUpload(await animation(100, 100, 2))).rejects.toThrow(
      'JPEG, PNG eller WebP',
    )
  })
})
