import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { buildView, generatedSource, views } from '../scripts/build-views.ts'

describe('visningene (MCP Apps)', () => {
  it.each(views)(
    '$name er bygget fra kildene (kjør pnpm --filter @esaf/mcp build:views)',
    async (view) => {
      const html = await buildView(view.name)
      const committed = await readFile(
        new URL(`../src/views/${view.name}.generated.ts`, import.meta.url),
        'utf8',
      )
      expect(committed).toBe(generatedSource(view.constant, html))
    },
  )
})
