import { domainToUnicode } from 'node:url'
import { z } from 'zod'

/** Valgfri tekst. Tomme felt lagres som `null`. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Maks ${max} tegn.`)
    .transform((v) => (v === '' ? null : v))
    .nullable()

/**
 * Stikkord skrevet med bare små bokstaver får stor forbokstav, så samme emne ser
 * likt ut på tvers av profiler og import («strategi» → «Strategi»). «iOS» og
 * «B2B-salg» røres ikke.
 */
export const tidyTag = (tag: string) =>
  tag === tag.toLocaleLowerCase('nb') ? tag.charAt(0).toLocaleUpperCase('nb') + tag.slice(1) : tag

/** Stikkord (emner, bransjer): maks 10 à 40 tegn. Duplikater fjernes uavhengig av store/små bokstaver. */
export const tagList = (one: string, many: string) =>
  z
    .array(z.string().trim().min(1).max(40, `Hvert ${one} kan ha maks 40 tegn.`).transform(tidyTag))
    .max(10, `Maks 10 ${many}.`)
    .transform((tags) =>
      tags.filter(
        (t, i) =>
          tags.findIndex((o) => o.toLocaleLowerCase('nb') === t.toLocaleLowerCase('nb')) === i,
      ),
    )

/** Et årstall fra og med `min`, og høyst ett år fram i tid. */
export const yearInput = (min: number) =>
  z
    .number()
    .int()
    .min(min, 'Ugyldig årstall.')
    .refine(
      (y) => y <= new Date().getFullYear() + 1,
      'Årstallet kan ikke være så langt fram i tid.',
    )
    .nullable()

/**
 * Lenken bare hvis den er http eller https, ellers `null`. Brukes på kildelenker
 * fra import før de sendes til nettleseren, så en lenke aldri kan kjøre kode.
 */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}

/** Valgfri kildelenke: en full http- eller https-adresse. */
export const optionalSourceUrl = optionalText(500).transform((v, ctx) => {
  if (v === null) return null
  const url = safeHttpUrl(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`)
  if (!url || !/^[^.]+(\.[^.]+)+$/.test(new URL(url).hostname)) {
    ctx.addIssue({ code: 'custom', message: 'Ugyldig lenke til kilden.' })
    return z.NEVER
  }
  return url
})

/** Domenet i en lenke uten «www.», til å vise som navnet på kilden. */
export function hostLabel(url: string | null): string | null {
  if (!url) return null
  try {
    return domainToUnicode(new URL(url).hostname).replace(/^www\./, '') || null
  } catch {
    return null
  }
}
