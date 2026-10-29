import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { DomainError, LOGO_MAX_BYTES, processCompanyLogo } from '../src/index.ts'

const red = { r: 220, g: 30, b: 30, alpha: 1 }
const clear = { r: 0, g: 0, b: 0, alpha: 0 }

/** En helt rød logo uten gjennomsiktighet. */
const logo = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 4, background: red } }).png()

/** Rammen rundt pikslene som ikke er gjennomsiktige. */
async function opaqueBox(image: Buffer) {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let [left, top, right, bottom] = [info.width, info.height, -1, -1]
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3]! > 128) {
        left = Math.min(left, x)
        right = Math.max(right, x)
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
      }
    }
  }
  return { width: right - left + 1, height: bottom - top + 1, left, top }
}

async function alphaAt(image: Buffer, x: number, y: number) {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return data[(y * info.width + x) * 4 + 3]!
}

async function rejection(file: Uint8Array) {
  const error = await processCompanyLogo(file).then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(DomainError)
  return (error as DomainError).message
}

describe('behandling av logoer', () => {
  it('skalerer inn i et kvadrat uten å beskjære, og beholder forholdet mellom sidene', async () => {
    const wide = await logo(800, 200).toBuffer()
    const { small, large } = await processCompanyLogo(wide)
    for (const [image, side] of [
      [large, 256],
      [small, 64],
    ] as const) {
      expect(await sharp(image).metadata()).toMatchObject({
        format: 'webp',
        width: side,
        height: side,
        hasAlpha: true,
        hasProfile: false,
      })
      // Hele bredden er med, sentrert i høyden, og fire ganger så bred som høy.
      const box = await opaqueBox(image)
      expect(box.width).toBe(side)
      expect(Math.abs(box.width / box.height - 4)).toBeLessThan(0.15)
      expect(Math.abs(box.top - (side - box.height) / 2)).toBeLessThanOrEqual(1)
    }
    // Kanten over og under logoen er gjennomsiktig, ikke hvit.
    expect(await alphaAt(large, 128, 5)).toBe(0)
    expect(await alphaAt(large, 128, 250)).toBe(0)
    expect(await alphaAt(large, 128, 128)).toBe(255)
  })

  it('beholder gjennomsiktighet inne i logoen', async () => {
    // Gjennomsiktig lerret med et rødt felt i midten.
    const input = await sharp({
      create: { width: 300, height: 300, channels: 4, background: clear },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 100, height: 100, channels: 4, background: red },
          })
            .png()
            .toBuffer(),
          left: 100,
          top: 100,
        },
      ])
      .png()
      .toBuffer()
    const { large } = await processCompanyLogo(input)
    expect(await sharp(large).metadata()).toMatchObject({ width: 256, height: 256 })
    expect(await alphaAt(large, 10, 10)).toBe(0)
    expect(await alphaAt(large, 128, 128)).toBe(255)
    const box = await opaqueBox(large)
    expect(Math.abs(box.width - 85)).toBeLessThanOrEqual(2)
  })

  it('tar imot JPEG og WebP, og skalerer aldri opp', async () => {
    const jpeg = await sharp({
      create: { width: 120, height: 80, channels: 3, background: { r: 10, g: 80, b: 200 } },
    })
      .jpeg()
      .toBuffer()
    const fromJpeg = await processCompanyLogo(jpeg)
    expect(await sharp(fromJpeg.large).metadata()).toMatchObject({ width: 120, height: 120 })
    expect(await sharp(fromJpeg.small).metadata()).toMatchObject({ width: 64, height: 64 })
    expect(await opaqueBox(fromJpeg.large)).toMatchObject({ width: 120, height: 80, top: 20 })

    const webp = await logo(500, 1000).webp().toBuffer()
    const fromWebp = await processCompanyLogo(webp)
    expect(await sharp(fromWebp.large).metadata()).toMatchObject({ width: 256, height: 256 })
    expect(await opaqueBox(fromWebp.large)).toMatchObject({ width: 128, height: 256 })
  })

  it('avviser SVG og alt annet som ikke er et lesbart JPEG-, PNG- eller WebP-bilde', async () => {
    const text = new TextEncoder()
    expect(await rejection(new Uint8Array())).toMatch('tom')
    expect(
      await rejection(
        text.encode('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"></svg>'),
      ),
    ).toMatch('JPEG, PNG eller WebP')
    expect(
      await rejection(
        text.encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'),
      ),
    ).toMatch('JPEG, PNG eller WebP')
    expect(await rejection(await logo(400, 400).gif().toBuffer())).toMatch('JPEG, PNG eller WebP')
    const png = await logo(400, 400).toBuffer()
    expect(await rejection(png.subarray(0, Math.floor(png.length / 2)))).toMatch(
      'klarte ikke å lese',
    )
    // En PNG under falskt WebP-flagg.
    const pngAsWebp = Buffer.from(png)
    pngAsWebp.write('RIFF', 0, 'latin1')
    pngAsWebp.write('WEBP', 8, 'latin1')
    expect(await rejection(pngAsWebp)).toMatch('klarte ikke å lese')
  })

  it('avviser for store filer og for små logoer', async () => {
    expect(await rejection(new Uint8Array(LOGO_MAX_BYTES + 1))).toMatch('Maks 10 MB')
    expect(await rejection(await logo(48, 48).toBuffer())).toMatch('for liten')
    // Smal, men lang nok: godtas.
    expect(await processCompanyLogo(await logo(200, 20).toBuffer())).toBeDefined()
  })
})
