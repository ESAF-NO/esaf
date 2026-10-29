import type { CompanyArticle } from '@esaf/core'
import { useRouter } from '@tanstack/react-router'
import { ArrowUpRight, Lock, Newspaper, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Dialog, DialogActions } from './Dialog.tsx'
import { Button, Card, ErrorText, Field, Input, Select } from './ui.tsx'
import {
  removeCompanyArticle,
  saveCompanyArticle,
  type CompanyArticleFormValues,
} from '#/lib/companies.functions.ts'
import { proposeCompanyArticle } from '#/lib/contributions.functions.ts'
import { monthNames, partialDate } from '#/lib/format.ts'

/** Så mange vises før «Vis alle». */
const VISIBLE = 5

/** Skjemaverdiene for en sak, eller tomme for en ny. */
function formValues(article: CompanyArticle | null): CompanyArticleFormValues {
  if (!article) {
    return {
      url: '',
      title: '',
      publisher: '',
      year: null,
      month: null,
      day: null,
      paywall: false,
      mentionsEs: false,
    }
  }
  const [y, m, d] = article.publishedAt?.split('-').map(Number) ?? []
  return {
    url: article.url,
    title: article.title,
    publisher: article.publisher ?? '',
    year: y ?? null,
    month: y && article.publishedPrecision !== 'year' ? m! : null,
    day: y && article.publishedPrecision === 'day' ? d! : null,
    paywall: article.paywall,
    mentionsEs: article.mentionsEs,
  }
}

/** Utgiveren, datoen og merkene under tittelen. */
export function ArticleMeta({
  publisher,
  publishedAt,
  publishedPrecision,
  paywall,
  mentionsEs,
}: Pick<CompanyArticle, 'publishedAt' | 'publishedPrecision' | 'paywall' | 'mentionsEs'> & {
  publisher: string
}) {
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500">
      <span className="font-medium text-stone-700">{publisher}</span>
      {publishedAt && (
        <span className="tabular-nums">{partialDate(publishedAt, publishedPrecision)}</span>
      )}
      {paywall && (
        <span className="inline-flex items-center gap-1">
          <Lock className="size-3" aria-hidden /> Betalingsmur
        </span>
      )}
      {mentionsEs && (
        <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700 ring-1 ring-brand-200 ring-inset">
          Nevner ES
        </span>
      )}
    </p>
  )
}

function ArticleRow({
  article: a,
  canEdit,
  onEdit,
}: {
  article: CompanyArticle
  canEdit: boolean
  onEdit: (article: CompanyArticle) => void
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove() {
    if (!confirm(`Fjerne «${a.title}» fra «I media»?`)) return
    setBusy(true)
    setError(null)
    try {
      await removeCompanyArticle({ data: { articleId: a.id } })
      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noe gikk galt.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <a
          href={a.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm leading-snug font-medium break-words text-stone-900 hover:text-brand-600"
        >
          {a.title}
          <ArrowUpRight className="ml-0.5 inline size-3.5 text-stone-400" aria-hidden />
          <span className="sr-only"> (åpnes i ny fane)</span>
        </a>
        <ArticleMeta {...a} publisher={a.publisherLabel} />
        {error && (
          <div className="mt-2">
            <ErrorText>{error}</ErrorText>
          </div>
        )}
      </div>
      {canEdit && (
        <span className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onEdit(a)}
            disabled={busy}
            aria-label={`Rediger «${a.title}»`}
          >
            <Pencil className="size-3.5" aria-hidden />
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={remove}
            disabled={busy}
            aria-label={`Fjern «${a.title}»`}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </span>
      )}
    </li>
  )
}

/**
 * «I media» på selskapssiden: saker om selskapet, nyeste først og de uten dato
 * sist. De som kan redigere selskapet, legger til, retter og fjerner saker; andre
 * medlemmer foreslår dem.
 */
export function CompanyArticles({
  companyId,
  name,
  articles,
  canEdit,
  adminEdit,
}: {
  companyId: string
  name: string
  articles: CompanyArticle[]
  /** Kan legge til og rette selv. Andre medlemmer foreslår saker i stedet. */
  canEdit: boolean
  /** Redigerer som admin uten å være knyttet til selskapet; endringer logges. */
  adminEdit: boolean
}) {
  const [editing, setEditing] = useState<CompanyArticle | 'new' | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [suggested, setSuggested] = useState(false)
  const shown = showAll ? articles : articles.slice(0, VISIBLE)

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-950">
          I media
          {articles.length > 0 && (
            <span className="font-normal text-stone-500 tabular-nums">{articles.length}</span>
          )}
        </h2>
        <Button variant="secondary" size="sm" onClick={() => setEditing('new')}>
          <Plus className="size-4" aria-hidden /> {canEdit ? 'Legg til' : 'Foreslå sak'}
        </Button>
      </div>
      {suggested && (
        <p role="status" className="mt-2 text-sm text-emerald-700">
          Takk! Forslaget er sendt til dem som kan redigere {name}.
        </p>
      )}
      {articles.length > 0 ? (
        <>
          <ul id={`saker-${companyId}`} className="mt-4 divide-y divide-stone-100">
            {shown.map((a) => (
              <ArticleRow key={a.id} article={a} canEdit={canEdit} onEdit={setEditing} />
            ))}
          </ul>
          {articles.length > VISIBLE && (
            <div className="mt-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAll((v) => !v)}
                aria-expanded={showAll}
                aria-controls={`saker-${companyId}`}
              >
                {showAll ? 'Vis færre' : `Vis alle ${articles.length}`}
              </Button>
            </div>
          )}
        </>
      ) : (
        <p className="mt-2 flex items-start gap-2 text-sm text-stone-500">
          <Newspaper className="mt-0.5 size-4 shrink-0 text-stone-400" aria-hidden />
          {canEdit
            ? `Ingen saker ennå. Legg til intervjuer og nyhetssaker om ${name}.`
            : `Ingen saker ennå. Har du sett ${name} omtalt i media? Foreslå saken.`}
        </p>
      )}
      {editing && (
        <ArticleDialog
          companyId={companyId}
          article={editing === 'new' ? null : editing}
          adminEdit={adminEdit}
          suggest={!canEdit}
          onClose={() => setEditing(null)}
          onSuggested={() => setSuggested(true)}
        />
      )}
    </Card>
  )
}

function ArticleDialog({
  companyId,
  article,
  adminEdit,
  suggest,
  onClose,
  onSuggested,
}: {
  companyId: string
  article: CompanyArticle | null
  adminEdit: boolean
  /** Sendes som forslag til dem som kan redigere, med en valgfri kommentar. */
  suggest: boolean
  onClose: () => void
  onSuggested: () => void
}) {
  const router = useRouter()
  const [values, setValues] = useState(() => formValues(article))
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<CompanyArticleFormValues>) => setValues((v) => ({ ...v, ...patch }))

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      if (suggest) {
        await proposeCompanyArticle({ data: { companyId, values, note } })
        onSuggested()
      } else {
        await saveCompanyArticle({
          data: article ? { articleId: article.id, values } : { companyId, values },
        })
      }
      await router.invalidate()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lagre.')
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={suggest ? 'Foreslå en sak' : article ? 'Rediger sak' : 'Ny sak i media'}
      description={
        suggest
          ? 'De som kan redigere selskapet, ser over forslaget. Du får varsel når det er behandlet.'
          : adminEdit
            ? 'Du redigerer som admin, og endringen logges.'
            : 'Bare lenken, tittelen og datoen lagres, ikke teksten i saken.'
      }
      onClose={onClose}
      busy={saving}
      className="max-w-lg"
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Lenke">
          <Input
            value={values.url}
            onChange={(e) => set({ url: e.target.value })}
            inputMode="url"
            maxLength={1000}
            placeholder="https://www.adressa.no/…"
            required
            data-autofocus
          />
        </Field>
        <Field label="Tittel">
          <Input
            value={values.title}
            onChange={(e) => set({ title: e.target.value })}
            maxLength={300}
            required
          />
        </Field>
        <Field label="Avis eller nettsted" hint="Tomt gir domenet i lenken.">
          <Input
            value={values.publisher}
            onChange={(e) => set({ publisher: e.target.value })}
            maxLength={120}
            placeholder="Adresseavisen"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-[6rem_minmax(0,1fr)_5rem]">
          <Field label="År">
            <Input
              value={values.year ?? ''}
              onChange={(e) => {
                const digits = e.target.value.replace(/\D/g, '').slice(0, 4)
                set({
                  year: digits ? Number(digits) : null,
                  ...(digits ? {} : { month: null, day: null }),
                })
              }}
              inputMode="numeric"
              pattern="[0-9]{4}"
              maxLength={4}
              placeholder="Ukjent"
            />
          </Field>
          <Field label="Måned">
            <Select
              value={values.month ?? ''}
              onChange={(e) =>
                set({
                  month: e.target.value ? Number(e.target.value) : null,
                  ...(e.target.value ? {} : { day: null }),
                })
              }
              disabled={values.year === null}
            >
              <option value="">Ukjent</option>
              {monthNames.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Dag">
            <Input
              value={values.day ?? ''}
              onChange={(e) => {
                const digits = e.target.value.replace(/\D/g, '').slice(0, 2)
                set({ day: digits ? Number(digits) : null })
              }}
              inputMode="numeric"
              maxLength={2}
              disabled={values.month === null}
            />
          </Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="sr-only">Merker</legend>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-stone-700">
            <input
              type="checkbox"
              checked={values.paywall}
              onChange={(e) => set({ paywall: e.target.checked })}
              className="size-4 rounded border-stone-300 accent-brand-600"
            />
            Bak betalingsmur
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-stone-700">
            <input
              type="checkbox"
              checked={values.mentionsEs}
              onChange={(e) => set({ mentionsEs: e.target.checked })}
              className="size-4 rounded border-stone-300 accent-brand-600"
            />
            Saken nevner Entreprenørskolen
          </label>
        </fieldset>
        {suggest && (
          <Field label="Kommentar" hint="Valgfritt. Hjelper dem som skal godta forslaget.">
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </Field>
        )}
        {error && <ErrorText>{error}</ErrorText>}
        <DialogActions>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Avbryt
          </Button>
          <Button type="submit" variant="brand" disabled={saving}>
            {saving ? (suggest ? 'Sender …' : 'Lagrer …') : suggest ? 'Send forslag' : 'Lagre'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
