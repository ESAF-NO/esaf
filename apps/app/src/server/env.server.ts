import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRootEnv } from '@esaf/db'
import { z } from 'zod'

const EXAMPLE_SECRET = 'bytt-meg-ut-med-minst-32-tilfeldige-tegn'

const isProduction = process.env.NODE_ENV === 'production'
if (!isProduction) loadRootEnv()

// En tom linje i .env (`S3_BUCKET=`) betyr ikke satt.
const unsetIfEmpty = (value: unknown) => (value === '' ? undefined : value)
const optional = <T extends z.ZodType>(type: T) => z.preprocess(unsetIfEmpty, type.optional())

/** Alle må være satt for S3-lagring. `S3_REGION` er valgfri (`auto`, som R2 bruker). */
const s3Variables = [
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    BETTER_AUTH_SECRET: z.string().min(32, 'må være minst 32 tegn (openssl rand -base64 32)'),
    BETTER_AUTH_URL: z.url(),
    // Profilbilder: S3-kompatibel lagring (Cloudflare R2) når S3_-variablene er
    // satt, ellers filer på disk. Disk er bare lov utenfor produksjon.
    S3_ENDPOINT: optional(z.url({ protocol: /^https?$/ })),
    S3_BUCKET: optional(z.string()),
    S3_REGION: z.preprocess(unsetIfEmpty, z.string().default('auto')),
    S3_ACCESS_KEY_ID: optional(z.string()),
    S3_SECRET_ACCESS_KEY: optional(z.string()),
    UPLOAD_DIR: optional(z.string()),
  })
  .superRefine((env, ctx) => {
    const production = env.NODE_ENV === 'production'
    // Halvveis satt opp er en feil også i utvikling, ellers havner bildene stille på disk.
    if (production || s3Variables.some((key) => env[key] !== undefined)) {
      for (const key of s3Variables.filter((k) => env[k] === undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: production
            ? 'påkrevd i produksjon, for lagring av profilbilder (se README)'
            : 'mangler; sett alle S3_-variablene, eller ingen for å lagre bilder på disk',
        })
      }
    }
    if (!production) return
    if (env.BETTER_AUTH_SECRET === EXAMPLE_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['BETTER_AUTH_SECRET'],
        message: 'eksempelverdien fra .env.example kan ikke brukes i produksjon',
      })
    }
    const url = new URL(env.BETTER_AUTH_URL)
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (url.protocol !== 'https:' && !isLocal) {
      ctx.addIssue({
        code: 'custom',
        path: ['BETTER_AUTH_URL'],
        message: 'må bruke https i produksjon',
      })
    }
    if (env.S3_ENDPOINT && new URL(env.S3_ENDPOINT).protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_ENDPOINT'],
        message: 'må bruke https i produksjon',
      })
    }
    if (env.UPLOAD_DIR) {
      ctx.addIssue({
        code: 'custom',
        path: ['UPLOAD_DIR'],
        message: 'brukes bare i utvikling; i produksjon lagres bildene i S3/R2',
      })
    }
  })

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`)
  throw new Error(
    `Ugyldige miljøvariabler for @esaf/app:\n${details.join('\n')}\nSe .env.example og README.`,
  )
}

export const env = parsed.data

export type StorageConfig =
  | {
      driver: 's3'
      endpoint: string
      bucket: string
      region: string
      accessKeyId: string
      secretAccessKey: string
    }
  | { driver: 'disk'; dir: string }

/** Hvor profilbildene lagres. Valideringen over sørger for S3 i produksjon. */
function storageFromEnv(): StorageConfig {
  const {
    S3_ENDPOINT: endpoint,
    S3_BUCKET: bucket,
    S3_ACCESS_KEY_ID: accessKeyId,
    S3_SECRET_ACCESS_KEY: secretAccessKey,
  } = env
  if (endpoint && bucket && accessKeyId && secretAccessKey) {
    return { driver: 's3', endpoint, bucket, region: env.S3_REGION, accessKeyId, secretAccessKey }
  }
  // Standard er .data/uploads i roten av repoet, uansett hvor dev-serveren startes fra.
  const dir = env.UPLOAD_DIR ?? fileURLToPath(new URL('../../../../.data/uploads', import.meta.url))
  return { driver: 'disk', dir: resolve(dir) }
}

export const storageConfig = storageFromEnv()
