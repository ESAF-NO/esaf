import { fileURLToPath } from 'node:url'
import { storageConfigFromEnv, storageEnvIssues, type StorageConfig } from '@esaf/core'
import { loadRootEnv } from '@esaf/db'
import { z } from 'zod'

const EXAMPLE_SECRET = 'bytt-meg-ut-med-minst-32-tilfeldige-tegn'

const isProduction = process.env.NODE_ENV === 'production'
if (!isProduction) loadRootEnv()

// En tom linje i .env (`S3_BUCKET=`) betyr ikke satt.
const unsetIfEmpty = (value: unknown) => (value === '' ? undefined : value)
const optional = <T extends z.ZodType>(type: T) => z.preprocess(unsetIfEmpty, type.optional())

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    BETTER_AUTH_SECRET: z.string().min(32, 'må være minst 32 tegn (openssl rand -base64 32)'),
    BETTER_AUTH_URL: z.url(),
    // Profilbilder og logoer: S3-kompatibel lagring (Cloudflare R2) når S3_-variablene
    // er satt, ellers filer på disk. Disk er bare lov utenfor produksjon. Reglene
    // ligger i @esaf/core (storageEnvIssues), så importen på kommandolinjen følger dem.
    S3_ENDPOINT: optional(z.url({ protocol: /^https?$/ })),
    S3_BUCKET: optional(z.string()),
    S3_REGION: z.preprocess(unsetIfEmpty, z.string().default('auto')),
    S3_ACCESS_KEY_ID: optional(z.string()),
    S3_SECRET_ACCESS_KEY: optional(z.string()),
    UPLOAD_DIR: optional(z.string()),
  })
  .superRefine((env, ctx) => {
    const production = env.NODE_ENV === 'production'
    for (const issue of storageEnvIssues(env, { production })) {
      ctx.addIssue({ code: 'custom', path: [issue.variable], message: issue.message })
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
  })

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`)
  throw new Error(
    `Ugyldige miljøvariabler for @esaf/app:\n${details.join('\n')}\nSe .env.example og README.`,
  )
}

export const env = parsed.data

export type { StorageConfig }

/** Hvor bildene lagres. Valideringen over sørger for S3 i produksjon. */
export const storageConfig: StorageConfig = storageConfigFromEnv(
  env,
  // Standard er .data/uploads i roten av repoet, uansett hvor dev-serveren startes fra.
  fileURLToPath(new URL('../../../../.data/uploads', import.meta.url)),
)
