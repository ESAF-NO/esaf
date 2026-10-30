import { definePlugin } from 'nitro'

/** Starter bakgrunnsjobben som holder personsøket oppdatert (se `search.server.ts`). */
export default definePlugin(async () => {
  const { startSearchIndexing } = await import('../search.server.ts')
  startSearchIndexing()
})
