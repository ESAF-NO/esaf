import type { Nodes } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

/**
 * Innlegg og kommentarer skrives i Markdown (GFM). Teksten tolkes med samme
 * parser som appen viser den med, så utdrag blir ren tekst og ikke halve
 * Markdown-konstruksjoner som `**` og `[tekst](https://…)`.
 */
const parser = unified().use(remarkParse).use(remarkGfm)

// Et utdrag trenger bare starten av teksten, så lange innlegg tolkes ikke i sin helhet.
const SOURCE_LIMIT = 4_000

/** Blokker som skal skilles med mellomrom, så avsnitt og listepunkter ikke flyter sammen. */
const blocks = new Set<Nodes['type']>([
  'blockquote',
  'code',
  'heading',
  'list',
  'listItem',
  'paragraph',
  'table',
  'tableCell',
  'tableRow',
  'thematicBreak',
])

function collect(node: Nodes, out: string[]) {
  switch (node.type) {
    // Rå HTML vises som tekst i appen, så den står som tekst her også.
    case 'text':
    case 'inlineCode':
    case 'code':
    case 'html':
      out.push(node.value)
      break
    case 'image':
    case 'imageReference':
      out.push(node.alt ?? '')
      break
    case 'break':
      out.push(' ')
      break
    // Lenkedefinisjoner er usynlige, og fotnoter hører ikke hjemme i et utdrag.
    case 'definition':
    case 'footnoteDefinition':
    case 'footnoteReference':
      return
    default:
      if ('children' in node) for (const child of node.children) collect(child, out)
  }
  if (blocks.has(node.type)) out.push(' ')
}

/**
 * Markdown som ren tekst på én linje. Lenker blir lenketeksten, så en omtale
 * som `@[Kari Nordmann](personId)` blir «@Kari Nordmann».
 */
export function markdownToPlainText(markdown: string): string {
  const out: string[] = []
  collect(parser.parse(markdown.slice(0, SOURCE_LIMIT)), out)
  return out.join('').replace(/\s+/g, ' ').trim()
}
