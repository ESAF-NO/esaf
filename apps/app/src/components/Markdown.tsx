import { Link } from '@tanstack/react-router'
import { memo, useId, useMemo, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type ExtraProps, type UrlTransform } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { cx } from './ui.tsx'

/**
 * Innlegg og kommentarer skrives i Markdown (GitHub-varianten) og vises som
 * React-elementer, aldri som HTML-streng. Rå HTML vises som tekst, bilder blir
 * lenker (eksterne bilder ville avslørt hvem som leser), og bare http(s)- og
 * mailto-lenker beholdes. Utdrag i feeden lages som ren tekst i @esaf/core.
 */

/** En omtale skrevet som `@[Navn](personId)`. */
export type Mention = { personId: string; name: string }

const PERSON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Den delen av Markdown-syntakstreet (mdast) pluginen under trenger.
type MdNode = {
  type: string
  value?: string
  url?: string
  alt?: string | null
  children?: MdNode[]
  data?: Record<string, unknown>
}

const textOf = (node: MdNode): string => node.value ?? (node.children ?? []).map(textOf).join('')

/**
 * Går gjennom syntakstreet før det blir til elementer:
 * - `@` rett foran en lenke til en person-ID er en omtale. Lenken merkes, så den
 *   vises med `renderMention`. Siden det skjer i treet, blir `@[…](…)` i kode stående.
 * - Bilder blir lenker til bildet, eller bare teksten når de står inne i en lenke.
 */
function remarkEsaf() {
  const visit = (node: MdNode, inLink: boolean) => {
    const children = node.children
    if (!children) return
    children.forEach((child, i) => {
      const before = children[i - 1]
      if (
        child.type === 'link' &&
        before?.type === 'text' &&
        before.value?.endsWith('@') &&
        PERSON_ID.test(child.url ?? '')
      ) {
        before.value = before.value.slice(0, -1)
        child.data = {
          ...child.data,
          hProperties: { dataMentionId: child.url, dataMentionName: textOf(child) },
        }
      } else if (child.type === 'image' || child.type === 'imageReference') {
        const text = { type: 'text', value: child.alt || child.url || '' }
        children[i] = inLink
          ? text
          : child.type === 'image'
            ? { type: 'link', url: child.url, children: [text] }
            : { ...child, type: 'linkReference', children: [text] }
      }
      visit(children[i]!, inLink || child.type === 'link' || child.type === 'linkReference')
    })
  }
  return (tree: MdNode) => visit(tree, false)
}

const remarkPlugins = [remarkGfm, remarkBreaks, remarkEsaf]

/** Bare vanlige nettadresser, e-post og fotnoter. Alt annet (javascript:, data:, relative stier) fjernes. */
const safeUrl: UrlTransform = (url) => (/^(https?:\/\/|mailto:|#)/i.test(url) ? url : null)

const linkClass =
  'font-medium text-brand-700 underline decoration-brand-700/30 underline-offset-2 transition hover:decoration-brand-700'

function MentionLink({ personId, name }: Mention) {
  return (
    <Link
      to="/medlemmer/$personId"
      params={{ personId }}
      className="font-medium text-brand-700 hover:underline"
    >
      @{name}
    </Link>
  )
}

function createComponents(renderMention: (mention: Mention) => ReactNode): Components {
  // Overskrifter blir uthevet tekst. Store titler hører ikke hjemme midt i et innlegg.
  // Fotnotene har en usynlig overskrift (`sr-only`) som skjermlesere skal finne.
  const heading = ({
    node,
    className,
    ...props
  }: ExtraProps & { className?: string; id?: string; children?: ReactNode }) => (
    <p className={cx('font-semibold text-stone-900', className)} {...props} />
  )
  return {
    a: ({ node, href, className, children, ...props }) => {
      const mentionId = node?.properties.dataMentionId
      if (typeof mentionId === 'string') {
        return renderMention({
          personId: mentionId,
          name: String(node?.properties.dataMentionName ?? ''),
        })
      }
      // Adressen var ikke trygg: vis teksten uten lenke.
      if (!href) return <>{children}</>
      const external = !href.startsWith('#')
      return (
        <a
          {...props}
          href={href}
          className={cx(linkClass, className)}
          target={/^https?:/i.test(href) ? '_blank' : undefined}
          rel={external ? 'noopener noreferrer nofollow ugc' : undefined}
        >
          {children}
        </a>
      )
    },
    // Nås bare om noe slipper forbi pluginen over. Eksterne bilder lastes aldri.
    img: ({ alt }) => <>{alt}</>,
    h1: heading,
    h2: heading,
    h3: heading,
    h4: heading,
    h5: heading,
    h6: heading,
    strong: ({ node, ...props }) => <strong className="font-semibold text-stone-900" {...props} />,
    ul: ({ node, className, ...props }) => (
      <ul
        className={cx(
          'space-y-1 pl-5 marker:text-stone-400 [li>&]:mt-1',
          className?.includes('contains-task-list') ? 'list-none pl-1' : 'list-disc',
          className,
        )}
        {...props}
      />
    ),
    ol: ({ node, className, ...props }) => (
      <ol
        className={cx('list-decimal space-y-1 pl-5 marker:text-stone-400 [li>&]:mt-1', className)}
        {...props}
      />
    ),
    li: ({ node, className, ...props }) => (
      <li className={cx('pl-0.5 [&>p+p]:mt-2', className)} {...props} />
    ),
    input: ({ node, ...props }) => (
      <input {...props} className="mr-1.5 size-3.5 translate-y-0.5 accent-brand-600" />
    ),
    blockquote: ({ node, ...props }) => (
      <blockquote
        className="space-y-2 border-l-2 border-stone-300 pl-3.5 text-stone-600"
        {...props}
      />
    ),
    code: ({ node, className, ...props }) => (
      <code
        className={cx(
          'rounded-md bg-stone-100 px-1.5 py-0.5 font-mono text-[0.875em] text-stone-800',
          className,
        )}
        {...props}
      />
    ),
    pre: ({ node, ...props }) => (
      <pre
        className="overflow-x-auto rounded-xl bg-stone-50 px-4 py-3 font-mono text-[0.875em] leading-relaxed text-stone-800 ring-1 ring-stone-200 ring-inset [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[1em]"
        {...props}
      />
    ),
    hr: () => <hr className="border-stone-200" />,
    table: ({ node, ...props }) => (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left" {...props} />
      </div>
    ),
    th: ({ node, ...props }) => (
      <th
        className="border-b border-stone-300 px-2.5 py-1.5 font-semibold text-stone-900"
        {...props}
      />
    ),
    td: ({ node, ...props }) => (
      <td className="border-b border-stone-200 px-2.5 py-1.5 align-top" {...props} />
    ),
  }
}

const defaultMention = (mention: Mention) => <MentionLink {...mention} />

/**
 * Viser Markdown fra et innlegg eller en kommentar.
 *
 * `renderMention` bestemmer hvordan omtaler (`@[Navn](personId)`) vises. Standard
 * er en lenke til profilen.
 */
export const Markdown = memo(function Markdown({
  children,
  className,
  renderMention = defaultMention,
}: {
  children: string
  className?: string
  renderMention?: (mention: Mention) => ReactNode
}) {
  // Fotnoter får id-er i dokumentet. Et eget prefiks per tekst hindrer kollisjoner
  // når flere kommentarer på samme side har fotnoter.
  const prefix = `md${useId().replace(/[^\w-]/g, '')}-`
  const components = useMemo(() => createComponents(renderMention), [renderMention])
  return (
    <div className={cx('space-y-3 wrap-break-word', className)}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        remarkRehypeOptions={{
          clobberPrefix: prefix,
          footnoteLabel: 'Fotnoter',
          footnoteBackLabel: 'Tilbake til teksten',
        }}
        urlTransform={safeUrl}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
})
