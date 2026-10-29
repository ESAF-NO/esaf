import type { Quote } from '@esaf/core'
import { Link, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { ArrowUpRight, Pencil, Quote as QuoteIcon, ShieldAlert, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Dialog, DialogActions } from './Dialog.tsx'
import {
  Avatar,
  Button,
  Card,
  cx,
  ErrorText,
  Field,
  Input,
  Select,
  Textarea,
  Verified,
} from './ui.tsx'
import {
  fetchEditableQuote,
  removeQuote,
  saveQuote,
  type QuoteFormValues,
} from '#/lib/quotes.functions.ts'
import { confidenceLabels } from '#/lib/sources.ts'

/** Lange sitater kortes ned til de er åpnet. */
const LONG = 360

function Speaker({ quote: q }: { quote: Quote }) {
  const { speaker } = q
  const name = (
    <span className="inline-flex items-center gap-1 font-medium text-stone-900 group-hover:text-brand-600">
      {speaker.name}
      <Verified claimed={speaker.claimed} className="size-3.5" />
    </span>
  )
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Avatar
        name={speaker.name}
        photo={speaker.photo}
        size="sm"
        muted={!speaker.personId || !speaker.claimed}
      />
      <span className="min-w-0 text-sm leading-snug">
        {speaker.personId ? (
          <Link to="/medlemmer/$personId" params={{ personId: speaker.personId }} className="group">
            {name}
          </Link>
        ) : (
          name
        )}
        {q.role && <span className="block text-xs text-stone-500">{q.role}</span>}
      </span>
    </span>
  )
}

/** «tu.no · 2019», med lenke til kilden i ny fane. */
function QuoteSource({ quote: q }: { quote: Quote }) {
  if (!q.source && !q.date) return null
  return (
    <span className="inline-flex items-center gap-1 text-xs text-stone-500">
      {q.source &&
        (q.source.url ? (
          <a
            href={q.source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 hover:text-brand-600"
          >
            {q.source.label}
            <ArrowUpRight className="size-3" aria-hidden />
          </a>
        ) : (
          q.source.label
        ))}
      {q.source && q.date && ' · '}
      {q.date?.slice(0, 4)}
    </span>
  )
}

function QuoteItem({ quote: q, showSpeaker }: { quote: Quote; showSpeaker: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const long = q.text.length > LONG

  async function remove() {
    const question = q.canEdit
      ? 'Slette sitatet? Det kan ikke angres, og slettingen logges.'
      : 'Fjerne sitatet fra profilen din? Det kan ikke angres.'
    if (!confirm(question)) return
    setError(null)
    try {
      await removeQuote({ data: { quoteId: q.id } })
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke slette sitatet.')
    }
  }

  return (
    <li className="py-4 first:pt-1 last:pb-0">
      {q.review && (
        <p className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200 ring-inset">
          <ShieldAlert className="size-3.5" aria-hidden /> Usikker taler · bare synlig for admins
        </p>
      )}
      <blockquote
        className={cx(
          'border-l-2 border-brand-200 pl-4 text-[15px] leading-relaxed whitespace-pre-line text-stone-700',
          long && !open && 'line-clamp-5',
        )}
      >
        {q.text}
      </blockquote>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 ml-4 text-sm font-medium text-brand-600 hover:underline"
        >
          {open ? 'Vis mindre' : 'Vis hele'}
        </button>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pl-4">
        {showSpeaker ? (
          <Speaker quote={q} />
        ) : (
          q.role && <span className="text-sm text-stone-600">{q.role}</span>
        )}
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <QuoteSource quote={q} />
          {q.confidence && (
            <span className="text-xs text-stone-400">{confidenceLabels[q.confidence]}</span>
          )}
          {q.canEdit && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditing(true)}
              aria-label="Rediger sitatet"
            >
              <Pencil className="size-3.5" aria-hidden />
            </Button>
          )}
          {q.canRemove && (
            <Button variant="danger" size="sm" onClick={remove} aria-label="Slett sitatet">
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          )}
        </span>
      </div>
      {error && (
        <div className="mt-2">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {editing && <EditQuoteDialog quoteId={q.id} onClose={() => setEditing(false)} />}
    </li>
  )
}

/**
 * Sitater på en profil eller selskapsside. På profilen er taleren gitt, så bare
 * rollen vises; på selskapssiden vises hvem som sa det.
 */
export function QuoteList({
  quotes,
  showSpeaker,
  title = 'Sitater',
}: {
  quotes: Quote[]
  showSpeaker: boolean
  title?: string
}) {
  if (!quotes.length) return null
  return (
    <Card className="p-5 sm:p-6">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-950">
        {title}
        {quotes.length > 1 && (
          <span className="font-normal text-stone-500 tabular-nums">{quotes.length}</span>
        )}
      </h2>
      <ul className="mt-3 divide-y divide-stone-100">
        {quotes.map((q) => (
          <QuoteItem key={q.id} quote={q} showSpeaker={showSpeaker} />
        ))}
      </ul>
    </Card>
  )
}

/** Et lite kort med et sitat fra en ES-er, til sidekolonnen på forsiden. */
export function FeaturedQuote({ quote: q }: { quote: Quote }) {
  return (
    <Card className="relative overflow-hidden p-5">
      <QuoteIcon
        className="absolute -top-1 right-3 size-16 rotate-180 fill-brand-50 text-brand-50"
        aria-hidden
      />
      <p className="relative text-[11px] font-semibold tracking-wider text-stone-400 uppercase">
        Sitat
      </p>
      <blockquote className="relative mt-2 line-clamp-6 text-[15px] leading-relaxed text-stone-800">
        «{q.text}»
      </blockquote>
      <div className="relative mt-4">
        <Speaker quote={q} />
      </div>
      {q.company && (
        <Link
          to="/selskaper/$slug"
          params={{ slug: q.company.slug }}
          className="relative mt-3 inline-block text-xs font-medium text-brand-600 hover:underline"
        >
          Les om {q.company.name}
        </Link>
      )}
    </Card>
  )
}

/** Admins retter tekst, taler, dato og kilde, og hvor sikker kilden er. */
export function EditQuoteDialog({ quoteId, onClose }: { quoteId: string; onClose: () => void }) {
  const router = useRouter()
  const load = useServerFn(fetchEditableQuote)
  const [values, setValues] = useState<QuoteFormValues | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    load({ data: { quoteId } })
      .then((q) => {
        if (!active) return
        setValues({
          text: q.text,
          speakerName: q.speakerName,
          speakerRole: q.speakerRole ?? '',
          date: q.date ?? '',
          sourceUrl: q.sourceUrl ?? '',
          sourceLabel: q.sourceLabel ?? '',
          confidence: q.confidence,
        })
      })
      .catch(
        (e: unknown) => active && setError(e instanceof Error ? e.message : 'Fant ikke sitatet.'),
      )
    return () => {
      active = false
    }
  }, [load, quoteId])

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!values) return
    setSaving(true)
    setError(null)
    try {
      await saveQuote({ data: { quoteId, values } })
      await router.invalidate()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
      setSaving(false)
    }
  }

  const set = (patch: Partial<QuoteFormValues>) => setValues((v) => (v ? { ...v, ...patch } : v))

  return (
    <Dialog
      title="Rediger sitat"
      description="Endringen logges. Sitater med lav sikkerhet vises bare for admins."
      onClose={onClose}
      busy={saving}
      className="max-w-lg"
    >
      {!values ? (
        error ? (
          <ErrorText>{error}</ErrorText>
        ) : (
          <p className="text-sm text-stone-500">Henter sitatet …</p>
        )
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Sitat">
            <Textarea
              value={values.text}
              onChange={(e) => set({ text: e.target.value })}
              rows={6}
              maxLength={2000}
              required
              data-autofocus
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Hvem sa det" hint="Navnet slik kilden skriver det.">
              <Input
                value={values.speakerName}
                onChange={(e) => set({ speakerName: e.target.value })}
                maxLength={120}
                required
              />
            </Field>
            <Field label="Rolle">
              <Input
                value={values.speakerRole}
                onChange={(e) => set({ speakerRole: e.target.value })}
                maxLength={160}
                placeholder="Daglig leder i …"
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Lenke til kilden">
              <Input
                value={values.sourceUrl}
                onChange={(e) => set({ sourceUrl: e.target.value })}
                inputMode="url"
                maxLength={500}
              />
            </Field>
            <Field label="Navn på kilden" hint="Tomt gir domenet i lenken.">
              <Input
                value={values.sourceLabel}
                onChange={(e) => set({ sourceLabel: e.target.value })}
                maxLength={80}
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Dato">
              <Input
                type="date"
                value={values.date}
                onChange={(e) => set({ date: e.target.value })}
              />
            </Field>
            <Field label="Sikker på hvem som sa det?">
              <Select
                value={values.confidence}
                onChange={(e) =>
                  set({ confidence: e.target.value as QuoteFormValues['confidence'] })
                }
              >
                <option value="high">Ja (høy)</option>
                <option value="medium">Ganske (middels)</option>
                <option value="low">Usikker (lav, skjules for medlemmer)</option>
              </Select>
            </Field>
          </div>
          {error && <ErrorText>{error}</ErrorText>}
          <DialogActions>
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Avbryt
            </Button>
            <Button type="submit" variant="brand" disabled={saving}>
              {saving ? 'Lagrer …' : 'Lagre'}
            </Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  )
}
