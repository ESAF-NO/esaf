/**
 * Personsøket fra kommandolinjen. Se README, «Personsøk».
 *
 *   pnpm search:download-model     # laster ned modellen (gjøres når Docker-bildet bygges)
 *   pnpm search:reindex            # bygger indeksen for alle som er endret
 *   pnpm search:reindex --alle     # også de som ikke er endret (ny modell e.l.)
 *   pnpm search:query "space"      # prøv et søk som admin (bare lokalt)
 */
import { parseArgs } from 'node:util'
import { createDb, loadRootEnv, schema } from '@esaf/db'
import {
  createLocalEmbedder,
  defaultSearchModelDir,
  reindexPeople,
  searchPeopleByTopic,
  type Viewer,
} from '../src/index.ts'

loadRootEnv()
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { alle: { type: 'boolean', default: false } },
})
const command = positionals[0]
const embedder = createLocalEmbedder({ cacheDir: defaultSearchModelDir() })

if (command === 'download') {
  await embedder.ready()
  console.log(`Modellen ${embedder.model} ligger i ${defaultSearchModelDir()}.`)
  process.exit(0)
}
if (!process.env.DATABASE_URL) {
  console.error('Mangler DATABASE_URL.')
  process.exit(1)
}
const db = createDb(process.env.DATABASE_URL)

if (command === 'reindex') {
  if (values.alle) await db.delete(schema.personSearchIndex)
  const started = Date.now()
  let total = { indexed: 0, removed: 0 }
  for (;;) {
    const r = await reindexPeople(db, embedder, { limit: 100 })
    total = { indexed: total.indexed + r.indexed, removed: total.removed + r.removed }
    process.stdout.write(`\rIndeksert ${total.indexed} av ${r.total} …`)
    if (r.indexed === 0) break
  }
  console.log(
    `\nFerdig på ${Math.round((Date.now() - started) / 1000)} s: ${total.indexed} indeksert, ${total.removed} fjernet.`,
  )
} else if (command === 'query') {
  const host = new URL(process.env.DATABASE_URL).hostname
  if (host !== 'localhost' && host !== '127.0.0.1') {
    console.error('Prøvesøk er bare for en lokal database.')
    process.exit(1)
  }
  // Et søk som admin, så alle personer er med.
  const viewer: Viewer = {
    userId: 'cli',
    emailVerified: true,
    twoFactorEnabled: true,
    passkeySession: false,
    hasPasskey: false,
    personId: 'cli',
    membership: { status: 'active', role: 'owner' },
  }
  for (const q of positionals.slice(1)) {
    console.log(`\n«${q}»`)
    for (const hit of await searchPeopleByTopic(db, viewer, q, { embedder, limit: 8 })) {
      console.log(`  ${hit.fullName} [${hit.matchedBy}] ${hit.reason?.slice(0, 110) ?? ''}`)
    }
  }
} else {
  console.error('Bruk: search:download-model | search:reindex [--alle] | search:query "<søk>"')
  process.exit(1)
}
await db.close()
