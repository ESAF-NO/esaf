import { crc32, deflateSync } from 'node:zlib'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { DomainError, PHOTO_MAX_BYTES, processProfilePhoto } from '../src/index.ts'

type Rgb = [number, number, number]
const red: Rgb = [220, 30, 30]
const green: Rgb = [30, 200, 60]
const blue: Rgb = [30, 30, 220]

/** Et bilde i loddrette striper, i rekkefølge fra venstre. */
function stripes(width: number, height: number, colours: Rgb[]) {
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const colour = colours[Math.floor((x / width) * colours.length)]!
      pixels.set(colour, (y * width + x) * 3)
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
}

/**
 * Som et bilde fra en mobil tatt på høykant: lagret liggende med EXIF-
 * orientering 6 (skal roteres 90° med klokka), GPS-posisjon, opphavsrett,
 * XMP og en fargeprofil for Display P3.
 */
function phoneJpeg() {
  return stripes(1200, 800, [red, blue])
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { Copyright: 'Hemmelig hytte', Make: 'Testkamera' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '63/1 25/1 1234/100',
        GPSLongitudeRef: 'E',
        GPSLongitude: '10/1 23/1 0/1',
      },
    })
    .withXmp(
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Hemmelig fotograf</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>',
    )
    .withIccProfile('p3')
    .jpeg({ quality: 90 })
    .toBuffer()
}

async function pixel(image: Buffer, x: number, y: number) {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true })
  const i = (y * info.width + x) * info.channels
  return [...data.subarray(i, i + 3)]
}

const near = (actual: number[], expected: Rgb) =>
  actual.every((v, i) => Math.abs(v - expected[i]!) < 40)

/** En gyldig PNG-header som påstår at bildet er enormt, uten pikseldata å snakke om. */
function pngBomb(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // 8 bit
  header[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(1024))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function rejection(file: Uint8Array) {
  const error = await processProfilePhoto(file).then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(DomainError)
  return (error as DomainError).message
}

describe('behandling av profilbilder', () => {
  it('roterer etter EXIF, fjerner all metadata (også GPS) og beskjærer til kvadrat', async () => {
    const input = await phoneJpeg()
    // Fixturen har faktisk det som skal bort.
    const before = await sharp(input).metadata()
    expect(before).toMatchObject({ orientation: 6, hasProfile: true })
    expect(before.exif?.includes('Hemmelig hytte')).toBe(true)
    expect(before.exif?.includes(Buffer.from([0x25, 0x88]))).toBe(true) // GPS-IFD (0x8825)
    expect(before.xmp).toBeDefined()

    const { small, large } = await processProfilePhoto(input)
    for (const [image, side] of [
      [large, 512],
      [small, 192],
    ] as const) {
      const meta = await sharp(image).metadata()
      expect(meta).toMatchObject({
        format: 'webp',
        width: side,
        height: side,
        hasProfile: false,
        hasAlpha: false,
      })
      expect(meta.orientation).toBeUndefined()
      expect(meta.exif).toBeUndefined()
      expect(meta.xmp).toBeUndefined()
      expect(meta.iptc).toBeUndefined()
      expect(meta.icc).toBeUndefined()
      expect(image.includes('Hemmelig')).toBe(false)
    }
    // Høykant: venstre halvdel (rød) ligger øverst når bildet står riktig.
    expect(near(await pixel(large, 256, 100), red)).toBe(true)
    expect(near(await pixel(large, 256, 412), blue)).toBe(true)
  })

  it('beskjærer fra midten', async () => {
    const wide = await stripes(1500, 500, [green, red, blue]).png().toBuffer()
    const { large } = await processProfilePhoto(wide)
    expect(await sharp(large).metadata()).toMatchObject({ width: 500, height: 500 })
    for (const [x, y] of [
      [5, 5],
      [495, 5],
      [5, 495],
      [495, 495],
    ] as const) {
      expect(near(await pixel(large, x, y), red)).toBe(true)
    }
  })

  it('tar imot PNG og WebP, skalerer aldri opp og fyller gjennomsiktighet med hvitt', async () => {
    const transparent = await sharp({
      create: { width: 300, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer()
    const fromPng = await processProfilePhoto(transparent)
    expect(await sharp(fromPng.large).metadata()).toMatchObject({
      width: 200,
      height: 200,
      hasAlpha: false,
    })
    expect(await sharp(fromPng.small).metadata()).toMatchObject({ width: 192, height: 192 })
    expect(near(await pixel(fromPng.large, 100, 100), [255, 255, 255])).toBe(true)

    const webp = await stripes(800, 800, [green]).webp().toBuffer()
    const fromWebp = await processProfilePhoto(webp)
    expect(await sharp(fromWebp.large).metadata()).toMatchObject({ width: 512, height: 512 })
  })

  it('avviser alt som ikke er et lesbart JPEG-, PNG- eller WebP-bilde', async () => {
    const jpeg = await phoneJpeg()
    const text = new TextEncoder()
    expect(await rejection(new Uint8Array())).toMatch('tom')
    expect(await rejection(text.encode('Dette er ikke et bilde.jpg'))).toMatch(
      'JPEG, PNG eller WebP',
    )
    expect(
      await rejection(
        text.encode('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"></svg>'),
      ),
    ).toMatch('JPEG, PNG eller WebP')
    // Gyldige bilder i andre formater slippes heller ikke inn.
    expect(await rejection(await stripes(400, 400, [red]).gif().toBuffer())).toMatch(
      'JPEG, PNG eller WebP',
    )
    expect(await rejection(await stripes(400, 400, [red]).tiff().toBuffer())).toMatch(
      'JPEG, PNG eller WebP',
    )
    // Riktige magiske bytes, men ødelagt eller avkuttet innhold.
    expect(await rejection(Buffer.concat([jpeg.subarray(0, 4), Buffer.alloc(5000, 7)]))).toMatch(
      'klarte ikke å lese',
    )
    expect(await rejection(jpeg.subarray(0, Math.floor(jpeg.length / 2)))).toMatch(
      'klarte ikke å lese',
    )
    // En PNG fra en annen filtype under falskt flagg avvises også.
    const pngAsWebp = Buffer.from(await stripes(400, 400, [red]).png().toBuffer())
    pngAsWebp.write('RIFF', 0, 'latin1')
    pngAsWebp.write('WEBP', 8, 'latin1')
    expect(await rejection(pngAsWebp)).toMatch('klarte ikke å lese')
  })

  it('bildebiblioteket nekter selv å lese andre formater', async () => {
    const gif = await stripes(400, 400, [red]).gif().toBuffer()
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>')
    await expect(sharp(gif).metadata()).rejects.toThrow()
    await expect(sharp(svg).metadata()).rejects.toThrow()
    expect((await sharp(await stripes(9, 9, [red]).png().toBuffer()).metadata()).format).toBe('png')
  })

  it('avviser for store filer, for små bilder og dekompresjonsbomber', async () => {
    expect(await rejection(new Uint8Array(PHOTO_MAX_BYTES + 1))).toMatch('Maks 10 MB')
    expect(await rejection(await stripes(400, 100, [red]).png().toBuffer())).toMatch('for lite')
    expect(await rejection(pngBomb(30_000, 30_000))).toMatch('for mange piksler')
  })
})
