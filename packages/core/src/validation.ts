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
