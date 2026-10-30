/**
 * Bygger visningene (MCP Apps) til én HTML-fil hver, med skriptet inni, og
 * skriver dem som strenger til `src/views/*.generated.ts`. Filene sjekkes inn,
 * så serveren ikke trenger esbuild; en test sjekker at de er oppdatert.
 *
 *   pnpm --filter @esaf/mcp build:views
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))

export const views = [{ name: 'universe', constant: 'UNIVERSE_HTML' }] as const

/** HTML-en for en visning, med skriptet bygget og lagt inn. */
export async function buildView(name: string): Promise<string> {
  const result = await build({
    entryPoints: [`${root}views/${name}.ts`],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
  })
  const script = result.outputFiles[0]!.text.replace(/<\/script/gi, '<\\/script')
  const html = await readFile(`${root}views/${name}.html`, 'utf8')
  return html.replace('<!--SCRIPT-->', () => `<script>${script}</script>`)
}

export function generatedSource(constant: string, html: string) {
  return (
    '// Generert av `pnpm --filter @esaf/mcp build:views` fra views/. Ikke rediger.\n' +
    `export const ${constant} = ${JSON.stringify(html)}\n`
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const view of views) {
    const html = await buildView(view.name)
    await writeFile(
      `${root}src/views/${view.name}.generated.ts`,
      generatedSource(view.constant, html),
    )
    console.log(
      `views/${view.name} → src/views/${view.name}.generated.ts (${Math.round(html.length / 1024)} kB)`,
    )
  }
}
