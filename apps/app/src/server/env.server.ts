import { loadRootEnv } from '@esaf/db'
import { z } from 'zod'

const EXAMPLE_SECRET = 'bytt-meg-ut-med-minst-32-tilfeldige-tegn'

const isProduction = process.env.NODE_ENV === 'production'
if (!isProduction) loadRootEnv()

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    BETTER_AUTH_SECRET: z.string().min(32, 'må være minst 32 tegn (openssl rand -base64 32)'),
    BETTER_AUTH_URL: z.url(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return
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
