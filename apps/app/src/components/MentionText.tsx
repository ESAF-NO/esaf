import { Link } from '@tanstack/react-router'
import { Fragment } from 'react'
import { segments } from '#/lib/mentions.ts'

/**
 * Tekst der omtaler blir lenker til profilen. Bygges som React-elementer, aldri
 * som HTML, så teksten fra brukerne alltid vises som tekst.
 */
export function MentionText({ text }: { text: string }) {
  return segments(text).map((part, i) =>
    part.type === 'text' ? (
      <Fragment key={i}>{part.text}</Fragment>
    ) : (
      <Link
        key={i}
        to="/medlemmer/$personId"
        params={{ personId: part.personId }}
        className="rounded-sm font-medium text-brand-700 hover:underline"
      >
        @{part.name}
      </Link>
    ),
  )
}
