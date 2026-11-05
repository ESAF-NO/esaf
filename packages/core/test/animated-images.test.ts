import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { processAssetImage } from '../src/index.ts'
import { inspectUpload, MAX_ANIMATED_PIXELS } from '../src/images.ts'

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
