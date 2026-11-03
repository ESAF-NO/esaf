import type {
  EmailBlock,
  EmailLogEntry,
  EmailOverview,
  EmailSwitch,
  EmailTemplate,
} from '@esaf/core'
import type { EmailKind, EmailStatus, NotificationEmailFrequency } from '@esaf/db'
import { createFileRoute, isNotFound, Link, notFound, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { AlertTriangle, Check, Eye, Mail, MailX, PauseCircle, PlayCircle, Send } from 'lucide-react'
import { useRef, useState } from 'react'
import { Dialog, DialogActions } from '#/components/Dialog.tsx'
import { SearchInput } from '#/components/SearchInput.tsx'
import { Button, Card, cx, EmptyState, ErrorText, Field, Input, Select } from '#/components/ui.tsx'
import {
  emailLogPageSize,
  fetchEmailAdmin,
  fetchEmailLog,
  blockAddress,
  sendEmailTest,
  unblockAddress,
  updateEmailKind,
  updateEmailPaused,
} from '#/lib/email-admin.functions.ts'
import { plural, timestamp } from '#/lib/format.ts'

export const Route = createFileRoute('/_konto/admin/e-post')({
  beforeLoad: ({ context: { viewer } }) => {
    if (!viewer.permissions.includes('audit.read')) throw notFound()
  },
  loader: async () => {
    const [admin, log] = await Promise.all([fetchEmailAdmin(), fetchEmailLog({ data: {} })])
    return { ...admin, log }
  },
  head: () => ({ meta: [{ title: 'E-post – Admin – ESAF' }] }),
  component: EmailAdmin,
  errorComponent: ({ error }) => (
    <ErrorText>{error instanceof Error ? error.message : 'Noe gikk galt.'}</ErrorText>
  ),
})

type Data = { overview: EmailOverview }

// Verdiene fra @esaf/core kan ikke importeres i klienten; navnene står her.
const statusNames: Record<EmailStatus, string> = {
  sent: 'Sendt',
  bounced: 'Avvist av mottakeren',
  failed: 'Feilet',
}

const frequencyNames: Record<NotificationEmailFrequency, string> = {
  instant: 'Med en gang',
  daily: 'Daglig',
  weekly: 'Ukentlig',
  off: 'Av',
}

const frequencyOrder: NotificationEmailFrequency[] = ['instant', 'daily', 'weekly', 'off']

/** Én oransje skala fra mørk til lys for hvor ofte, og grått for «av». */
const frequencyColors: Record<NotificationEmailFrequency, string> = {
  instant: 'bg-brand-700',
  daily: 'bg-brand-500',
  weekly: 'bg-brand-300',
  off: 'bg-stone-300',
}

const errorNames: Record<string, string> = {
  bounced: 'adressen tar ikke imot e-post',
  rejected: 'avvist av Cloudflare (oppsettet)',
  throttled: 'for mange på kort tid',
  unavailable: 'Cloudflare svarte ikke',
  paused: 'e-post var på pause',
  disabled: 'denne e-posten var slått av',
  blocked: 'adressen er stoppet',
  error: 'ukjent feil',
}

const number = new Intl.NumberFormat('nb-NO')

function EmailAdmin() {
  const data = Route.useLoaderData()
  const kindNames = Object.fromEntries(data.overview.kinds.map((k) => [k.kind, k.name])) as Record<
    EmailKind,
    string
  >
  return (
    <div className="space-y-10">
      <p className="max-w-3xl text-sm text-stone-500">
        Alt appen sender på e-post: hvilke e-poster det er, når de sendes og til hvem, og hvordan
        det har gått. Bare emnet lagres, ikke innholdet, fordi lenkene i e-postene er hemmelige.
        Loggen slettes etter ett år.
      </p>
      <Setup sending={data.sending} setup={data.setup} toggle={data.toggle} />
      <Numbers overview={data.overview} />
      <Templates
        templates={data.templates}
        sending={data.sending && !data.toggle.paused}
        toggle={data.toggle}
      />
      <Blocks blocks={data.blocks} />
      <Preferences overview={data.overview} />
      <SentLog
        first={data.log}
        kindNames={kindNames}
        blocked={new Set(data.blocks.map((b) => b.email))}
      />
    </div>
  )
}

function Setup({
  sending,
  setup,
  toggle,
}: {
  sending: boolean
  setup: string
  toggle: EmailSwitch
}) {
  const { viewer } = Route.useRouteContext()
  const canManage = viewer.permissions.includes('email.manage')
  const [changing, setChanging] = useState(false)
  if (!sending) {
    return (
      <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200 ring-inset">
        <AlertTriangle className="size-4 shrink-0" aria-hidden />
        E-post er ikke satt opp på serveren (EMAIL_PROVIDER). Ingenting sendes; invitasjoner må
        deles for hånd.
      </p>
    )
  }
  const changed = toggle.changedAt
    ? ` ${toggle.changedBy ? `av ${toggle.changedBy.fullName} ` : ''}${timestamp(toggle.changedAt)}`
    : ''
  return (
    <section aria-labelledby="bryter">
      <h2 id="bryter" className="sr-only">
        Av og på
      </h2>
      <Card
        className={cx(
          'flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5',
          toggle.paused && 'bg-amber-50 ring-amber-200',
        )}
      >
        <div className="flex min-w-0 items-start gap-3">
          {toggle.paused ? (
            <PauseCircle className="mt-0.5 size-5 shrink-0 text-amber-700" aria-hidden />
          ) : (
            <Check className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden />
          )}
          <div className="min-w-0 text-sm">
            <p className="font-medium text-stone-950">
              {toggle.paused ? 'E-post er på pause' : 'E-post er på'}
            </p>
            <p className="mt-0.5 text-stone-600">
              {toggle.paused
                ? `Ingenting sendes. Satt på pause${changed}${toggle.reason ? `: «${toggle.reason}»` : ''}.`
                : `Sendes med ${setup}.${toggle.changedAt ? ` Slått på igjen${changed}.` : ''}`}
            </p>
          </div>
        </div>
        {canManage && (
          <Button
            variant={toggle.paused ? 'primary' : 'secondary'}
            onClick={() => setChanging(true)}
          >
            {toggle.paused ? (
              <>
                <PlayCircle className="size-4" aria-hidden /> Slå på igjen
              </>
            ) : (
              <>
                <PauseCircle className="size-4" aria-hidden /> Sett på pause
              </>
            )}
          </Button>
        )}
      </Card>
      {changing && <SwitchDialog pause={!toggle.paused} onClose={() => setChanging(false)} />}
    </section>
  )
}

function SwitchDialog({ pause, onClose }: { pause: boolean; onClose: () => void }) {
  const router = useRouter()
  const update = useServerFn(updateEmailPaused)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await update({ data: { paused: pause, reason: reason.trim() || undefined } })
      await router.invalidate()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke endre det.')
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={pause ? 'Sette all e-post på pause?' : 'Slå på e-post igjen?'}
      description={
        pause
          ? 'Gjelder med en gang, for alle e-postene appen sender.'
          : 'E-post sendes som før med en gang.'
      }
      onClose={onClose}
      busy={busy}
    >
      <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-stone-600">
        {pause ? (
          <>
            <li>Varsler, oppsummeringer og velkomster sendes ikke.</li>
            <li>Invitasjoner og lenker for nytt passord lages, men du må dele lenken selv.</li>
            <li>Registrering og «Glemt passord?» er stengt så lenge.</li>
          </>
        ) : (
          <>
            <li>Registrering og «Glemt passord?» åpner igjen.</li>
            <li>
              Varslene som kom mens e-post var på pause, sendes ikke, så ingen får en bunke gamle
              varsler. Velkomster til nye medlemmer sendes.
            </li>
          </>
        )}
      </ul>
      <Field label="Hvorfor? (valgfritt)" hint="Står i loggen og på denne siden.">
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          data-autofocus
        />
      </Field>
      {error && (
        <div className="mt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      <DialogActions>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Avbryt
        </Button>
        <Button variant={pause ? 'destructive' : 'primary'} onClick={confirm} disabled={busy}>
          {busy ? 'Lagrer …' : pause ? 'Sett på pause' : 'Slå på igjen'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Tallene
// ---------------------------------------------------------------------------

function Numbers({ overview }: { overview: Data['overview'] }) {
  const { last30 } = overview
  const tiles = [
    { label: 'Sendt siste 30 dager', value: last30.sent },
    { label: 'Feilet', value: last30.failed, warn: last30.failed > 0 },
    { label: 'Avvist av mottakeren', value: last30.bounced, warn: last30.bounced > 0 },
    { label: 'Kan få varsler på e-post', value: overview.recipients },
  ]
  return (
    <section aria-labelledby="tall" className="space-y-4">
      <h2 id="tall" className="text-base font-semibold text-stone-950">
        Sendt
      </h2>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="p-4">
            <dt className="text-xs font-medium text-stone-500">{t.label}</dt>
            <dd
              className={cx(
                'mt-1 text-2xl font-semibold tabular-nums',
                t.warn ? 'text-red-700' : 'text-stone-950',
              )}
            >
              {number.format(t.value)}
            </dd>
          </Card>
        ))}
      </dl>
      <DailyChart daily={overview.daily} />
      <KindTable kinds={overview.kinds} />
    </section>
  )
}

const dayFormat = new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'short' })
const showDay = (day: string) => dayFormat.format(new Date(`${day}T12:00:00`))

/** Sendte e-poster per dag, de siste 30 dagene. Feil står i hjelpeteksten og i tabellen under. */
function DailyChart({ daily }: { daily: Data['overview']['daily'] }) {
  const max = Math.max(1, ...daily.map((d) => d.sent))
  const [hover, setHover] = useState<number | null>(null)
  const shown = hover === null ? null : daily[hover]!
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-stone-900">E-poster per dag, siste 30 dager</h3>
        <p className="text-xs text-stone-500 tabular-nums" aria-live="polite">
          {shown
            ? `${showDay(shown.day)}: ${plural(shown.sent, 'sendt', 'sendt')}${shown.failed ? `, ${shown.failed} feilet` : ''}`
            : `Opptil ${number.format(max)} på én dag`}
        </p>
      </div>
      <div
        className="mt-4 flex h-28 items-end gap-0.5 border-b border-stone-200"
        onMouseLeave={() => setHover(null)}
      >
        {daily.map((d, i) => (
          <div
            key={d.day}
            className="group flex h-full flex-1 items-end"
            onMouseEnter={() => setHover(i)}
            role="img"
            aria-label={`${showDay(d.day)}: ${d.sent} sendt${d.failed ? `, ${d.failed} feilet` : ''}`}
          >
            <div
              className={cx(
                'w-full rounded-t-[4px] transition-colors',
                d.sent ? 'bg-brand-500' : 'bg-transparent',
                hover === i && 'bg-brand-700',
                d.failed > 0 && 'ring-2 ring-red-500 ring-offset-1',
              )}
              style={{ height: d.sent ? `${Math.max(4, (d.sent / max) * 100)}%` : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-xs text-stone-400 tabular-nums">
        <span>{showDay(daily[0]!.day)}</span>
        <span>I dag</span>
      </div>
      <p className="mt-2 text-xs text-stone-500">Dager med feil har rød ring rundt søylen.</p>
    </Card>
  )
}

function KindTable({ kinds }: { kinds: Data['overview']['kinds'] }) {
  const cell = (c: { sent: number; failed: number; bounced: number }) => (
    <>
      {number.format(c.sent)}
      {c.failed + c.bounced > 0 && (
        <span className="ml-1.5 text-xs text-red-700">({c.failed + c.bounced} feilet)</span>
      )}
    </>
  )
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-stone-500">
          <tr className="border-b border-stone-100">
            <th scope="col" className="px-4 py-2.5 font-medium">
              E-post
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">
              7 dager
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">
              30 dager
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">
              Totalt
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              Sist
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100 tabular-nums">
          {kinds.map((k) => (
            <tr key={k.kind}>
              <th scope="row" className="px-4 py-2.5 font-medium text-stone-900">
                {k.name}
              </th>
              <td className="px-4 py-2.5 text-right whitespace-nowrap">{cell(k.last7)}</td>
              <td className="px-4 py-2.5 text-right whitespace-nowrap">{cell(k.last30)}</td>
              <td className="px-4 py-2.5 text-right whitespace-nowrap">{cell(k.total)}</td>
              <td className="px-4 py-2.5 whitespace-nowrap text-stone-500">
                {k.lastAt ? timestamp(k.lastAt) : '–'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Malene
// ---------------------------------------------------------------------------

/** Hva det betyr at en e-post er av, for dem som slår den av. */
const offNotes: Record<EmailTemplate['kind'], string> = {
  invitation: 'Invitasjonene lages, men du må dele lenken selv.',
  verification: 'Registrering er stengt så lenge den er av.',
  welcome: 'Velkomstene som venter, sendes når den slås på igjen (innen en uke).',
  password_reset: '«Glemt passord?» er stengt så lenge den er av.',
  password_link: 'Lenkene lages, men du må dele dem selv.',
  notification: 'Varsler som kommer mens den er av, sendes ikke når den slås på igjen.',
  digest: 'Det som kommer mens den er av, kommer ikke med når den slås på igjen.',
}

function Templates({
  templates,
  sending,
  toggle,
}: {
  templates: EmailTemplate[]
  sending: boolean
  toggle: EmailSwitch
}) {
  const { viewer } = Route.useRouteContext()
  const canManage = viewer.permissions.includes('email.manage')
  const [previewing, setPreviewing] = useState<EmailTemplate | null>(null)
  return (
    <section aria-labelledby="maler" className="space-y-4">
      <div>
        <h2 id="maler" className="text-base font-semibold text-stone-950">
          E-postene og når de sendes
        </h2>
        <p className="mt-1 text-sm text-stone-500">
          Forhåndsvisningene bruker oppdiktede personer, og lenkene i dem virker ikke. «Send test
          til meg» bruker navnet og kullet ditt. Ekte e-poster hilser med fornavnet når vi vet hvem
          de går til.
        </p>
      </div>
      <Card className="divide-y divide-stone-100">
        {templates.map((t) => {
          const state = toggle.kinds.find((k) => k.kind === t.kind)
          const off = state ? !state.enabled : false
          return (
            <article
              key={t.kind}
              className={cx('grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:p-5', off && 'bg-stone-50')}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium text-stone-950">{t.name}</h3>
                  {off && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                      Av
                    </span>
                  )}
                </div>
                {off && state && (
                  <p className="mt-1 text-sm text-amber-800">
                    Slått av
                    {state.changed
                      ? ` ${state.changed.by ? `av ${state.changed.by.fullName} ` : ''}${timestamp(state.changed.at)}`
                      : ''}
                    {state.reason ? `: «${state.reason}»` : ''}. {offNotes[t.kind]}
                  </p>
                )}
                <p className="mt-0.5 text-sm text-stone-500">Emne: «{t.sample.subject}»</p>
                <dl className="mt-3 grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[8rem_1fr]">
                  <dt className="text-stone-500">Når</dt>
                  <dd className="text-stone-800">{t.trigger}</dd>
                  <dt className="text-stone-500">Til</dt>
                  <dd className="text-stone-800">{t.recipient}</dd>
                  <dt className="text-stone-500">Tidspunkt</dt>
                  <dd className="text-stone-800">{t.timing}</dd>
                  <dt className="text-stone-500">Avmelding</dt>
                  <dd className="text-stone-800">
                    {t.unsubscribe ?? 'Ingen: sendes bare når noe skjer med personen selv.'}
                  </dd>
                </dl>
              </div>
              <div className="flex flex-wrap items-start gap-2 sm:w-48 sm:flex-col sm:items-stretch">
                {canManage && state && <KindSwitch kind={t.kind} enabled={state.enabled} />}
                <Button variant="secondary" size="sm" onClick={() => setPreviewing(t)}>
                  <Eye className="size-4" aria-hidden /> Forhåndsvis
                </Button>
                <TestButton kind={t.kind} sending={sending} />
              </div>
            </article>
          )
        })}
      </Card>
      {previewing && <PreviewDialog template={previewing} onClose={() => setPreviewing(null)} />}
    </section>
  )
}

function KindSwitch({ kind, enabled }: { kind: EmailTemplate['kind']; enabled: boolean }) {
  const router = useRouter()
  const update = useServerFn(updateEmailKind)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function change(next: boolean) {
    setBusy(true)
    setError(null)
    try {
      await update({ data: { kind, enabled: next } })
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke endre det.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-1">
      <label
        className={cx(
          'flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-sm ring-1 ring-stone-200 ring-inset',
          busy && 'opacity-60',
        )}
      >
        <span className="font-medium text-stone-800">{enabled ? 'Sendes' : 'Av'}</span>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(e) => change(e.target.checked)}
          className="peer sr-only"
        />
        <span className="relative h-5 w-8 shrink-0 rounded-full bg-stone-300 transition peer-checked:bg-brand-600 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-2 after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-white after:shadow after:transition peer-checked:after:translate-x-3" />
      </label>
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  )
}

function TestButton({ kind, sending }: { kind: EmailTemplate['kind']; sending: boolean }) {
  const send = useServerFn(sendEmailTest)
  const [state, setState] = useState<
    { busy: true } | { busy: false; done?: string; error?: string }
  >({ busy: false })
  async function run() {
    setState({ busy: true })
    try {
      const { to } = await send({ data: { kind } })
      setState({ busy: false, done: `Sendt til ${to}` })
    } catch (e) {
      setState({ busy: false, error: e instanceof Error ? e.message : 'Kunne ikke sende.' })
    }
  }
  return (
    <div className="space-y-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={!sending || state.busy}
        onClick={run}
        title={
          sending
            ? 'Sender eksempelet til adressen du logger inn med'
            : 'E-post er av eller på pause'
        }
        className="w-full"
      >
        <Send className="size-4" aria-hidden /> {state.busy ? 'Sender …' : 'Send test til meg'}
      </Button>
      <p role="status" className="max-w-48 text-xs">
        {!state.busy && state.done && <span className="text-emerald-700">{state.done}</span>}
        {!state.busy && state.error && <span className="text-red-700">{state.error}</span>}
      </p>
    </div>
  )
}

function PreviewDialog({ template, onClose }: { template: EmailTemplate; onClose: () => void }) {
  const [view, setView] = useState<'html' | 'text'>('html')
  return (
    <Dialog
      title={template.name}
      description={`Emne: «${template.sample.subject}»`}
      onClose={onClose}
      className="sm:max-w-3xl"
    >
      <div className="mb-3 inline-flex rounded-lg bg-stone-100 p-0.5 text-sm" role="group">
        {(['html', 'text'] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => setView(v)}
            className={cx(
              'rounded-md px-3 py-1 font-medium',
              view === v ? 'bg-white text-stone-950 shadow-sm' : 'text-stone-500',
            )}
          >
            {v === 'html' ? 'Slik den ser ut' : 'Ren tekst'}
          </button>
        ))}
      </div>
      {view === 'html' ? (
        <iframe
          title={`Eksempel: ${template.name}`}
          // Ingen skript, skjemaer eller navigering: bare visning.
          sandbox=""
          srcDoc={template.sample.html}
          className="h-[60vh] w-full rounded-lg ring-1 ring-stone-200"
        />
      ) : (
        <pre className="h-[60vh] overflow-auto rounded-lg bg-stone-50 p-4 text-sm whitespace-pre-wrap text-stone-800 ring-1 ring-stone-200">
          {template.sample.text}
        </pre>
      )}
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Stoppede adresser
// ---------------------------------------------------------------------------

function Blocks({ blocks }: { blocks: EmailBlock[] }) {
  const { viewer } = Route.useRouteContext()
  const canManage = viewer.permissions.includes('email.manage')
  const router = useRouter()
  const block = useServerFn(blockAddress)
  const unblock = useServerFn(unblockAddress)
  const [email, setEmail] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key)
    setError(null)
    try {
      await fn()
      await router.invalidate()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
      return false
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-labelledby="stoppet" className="space-y-4">
      <div>
        <h2 id="stoppet" className="text-base font-semibold text-stone-950">
          Stoppede adresser
        </h2>
        <p className="mt-1 text-sm text-stone-500">
          Appen sender ingenting til disse adressene: ingen varsler, invitasjoner eller lenker for
          nytt passord. Lenkene lages likevel, og du deler dem selv.
        </p>
      </div>
      {canManage && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            const ok = await act('ny', () =>
              block({ data: { email, reason: reason.trim() || undefined } }),
            )
            if (ok) {
              setEmail('')
              setReason('')
            }
          }}
        >
          <Field label="E-postadresse" className="min-w-56 flex-1">
            <Input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={254}
            />
          </Field>
          <Field label="Hvorfor? (valgfritt)" className="min-w-56 flex-1">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
          <Button type="submit" variant="secondary" disabled={busy !== null}>
            <MailX className="size-4" aria-hidden /> {busy === 'ny' ? 'Stopper …' : 'Stopp e-post'}
          </Button>
        </form>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      {blocks.length === 0 ? (
        <p className="text-sm text-stone-500">Ingen adresser er stoppet.</p>
      ) : (
        <Card className="divide-y divide-stone-100">
          {blocks.map((b) => (
            <div key={b.email} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium break-all text-stone-900">{b.email}</p>
                <p className="mt-0.5 text-xs text-stone-500">
                  {b.person ? (
                    <Link
                      to="/medlemmer/$personId"
                      params={{ personId: b.person.personId }}
                      className="font-medium text-stone-700 hover:underline"
                    >
                      {b.person.fullName}
                    </Link>
                  ) : (
                    'Ingen profil'
                  )}{' '}
                  · stoppet {b.createdBy ? `av ${b.createdBy.fullName} ` : ''}
                  {timestamp(b.createdAt)}
                  {b.reason ? ` · «${b.reason}»` : ''}
                </p>
              </div>
              {canManage && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => act(b.email, () => unblock({ data: { email: b.email } }))}
                >
                  {busy === b.email ? 'Lagrer …' : 'Send igjen'}
                </Button>
              )}
            </div>
          ))}
        </Card>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Valgene for varsler
// ---------------------------------------------------------------------------

function Preferences({ overview }: { overview: Data['overview'] }) {
  return (
    <section aria-labelledby="valg" className="space-y-4">
      <div>
        <h2 id="valg" className="text-base font-semibold text-stone-950">
          Hva medlemmene har valgt for varsler på e-post
        </h2>
        <p className="mt-1 text-sm text-stone-500">
          {plural(overview.recipients, 'aktivt medlem', 'aktive medlemmer')} med bekreftet
          e-postadresse. De som ikke har valgt selv, har standarden.
        </p>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600" aria-label="Forklaring">
        {frequencyOrder.map((f) => (
          <li key={f} className="flex items-center gap-1.5">
            <span className={cx('size-2.5 rounded-sm', frequencyColors[f])} aria-hidden />
            {frequencyNames[f]}
          </li>
        ))}
      </ul>
      <Card className="divide-y divide-stone-100">
        {overview.preferences.map((p) => {
          const total = frequencyOrder.reduce((sum, f) => sum + p.counts[f], 0)
          return (
            <div key={p.id} className="p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium text-stone-900">{p.label}</h3>
                <p className="text-xs text-stone-500">Standard: {frequencyNames[p.default]}</p>
              </div>
              {total > 0 && (
                <div className="mt-2 flex h-2.5 gap-0.5 overflow-hidden rounded-full" aria-hidden>
                  {frequencyOrder
                    .filter((f) => p.counts[f] > 0)
                    .map((f) => (
                      <div
                        key={f}
                        className={frequencyColors[f]}
                        style={{ width: `${(p.counts[f] / total) * 100}%` }}
                      />
                    ))}
                </div>
              )}
              <p className="mt-2 text-xs text-stone-600 tabular-nums">
                {frequencyOrder.map((f) => `${frequencyNames[f]} ${p.counts[f]}`).join(' · ')}
              </p>
            </div>
          )
        })}
      </Card>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Loggen
// ---------------------------------------------------------------------------

type Filter = { kind?: EmailKind; status?: EmailStatus; q?: string }

function SentLog({
  first,
  kindNames,
  blocked,
}: {
  first: EmailLogEntry[]
  kindNames: Record<EmailKind, string>
  /** Adressene som er stoppet. */
  blocked: Set<string>
}) {
  const fetchPage = useServerFn(fetchEmailLog)
  // Det som vises hører til siden fra loaderen det ble hentet etter. Kommer en ny
  // side (navigering eller invalidering), begynner listen og filtrene på nytt.
  const fresh = {
    base: first,
    filter: {} as Filter,
    entries: first,
    done: first.length < emailLogPageSize,
  }
  const [stored, setStored] = useState<{
    base: EmailLogEntry[]
    filter: Filter
    entries: EmailLogEntry[]
    done: boolean
  }>(fresh)
  const { filter, entries, done } = stored.base === first ? stored : fresh
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)
  const filtered = Boolean(filter.kind || filter.status || filter.q)

  async function load(next: Filter, beforeId?: string) {
    const id = ++request.current
    setLoading(true)
    setError(null)
    if (!beforeId) setStored({ base: first, filter: next, entries, done })
    try {
      const page = await fetchPage({ data: { ...next, beforeId } })
      if (id !== request.current) return
      setStored({
        base: first,
        filter: next,
        entries: beforeId ? [...entries, ...page] : page,
        done: page.length < emailLogPageSize,
      })
    } catch (e) {
      if (id !== request.current) return
      setError(
        isNotFound(e)
          ? 'Du har ikke lenger tilgang. Last siden på nytt.'
          : e instanceof Error
            ? e.message
            : 'Kunne ikke hente e-postene.',
      )
    } finally {
      if (id === request.current) setLoading(false)
    }
  }

  function change(patch: Filter) {
    void load({ ...filter, ...patch })
  }

  return (
    <section aria-labelledby="logg" className="space-y-4">
      <h2 id="logg" className="text-base font-semibold text-stone-950">
        E-poster som er sendt
      </h2>
      <div className="flex flex-wrap gap-2">
        <div className="min-w-56 flex-1">
          <SearchInput
            query={filter.q ?? ''}
            onSearch={(q) => change({ q: q.trim() || undefined })}
            placeholder="Søk i adresse, navn eller emne"
            aria-label="Søk i e-postene"
          />
        </div>
        <Select
          aria-label="Type"
          value={filter.kind ?? ''}
          onChange={(e) => change({ kind: (e.target.value || undefined) as EmailKind | undefined })}
          className="w-auto"
        >
          <option value="">Alle typer</option>
          {Object.entries(kindNames).map(([kind, name]) => (
            <option key={kind} value={kind}>
              {name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Utfall"
          value={filter.status ?? ''}
          onChange={(e) =>
            change({ status: (e.target.value || undefined) as EmailStatus | undefined })
          }
          className="w-auto"
        >
          <option value="">Alle utfall</option>
          {(Object.keys(statusNames) as EmailStatus[]).map((s) => (
            <option key={s} value={s}>
              {statusNames[s]}
            </option>
          ))}
        </Select>
      </div>
      {error && <ErrorText>{error}</ErrorText>}
      {entries.length === 0 ? (
        <EmptyState icon={Mail} title={filtered ? 'Ingen e-poster passer' : 'Ingen e-poster ennå'}>
          {filtered
            ? 'Prøv et annet søk eller filter.'
            : 'E-postene appen sender, vises her med mottaker og utfall.'}
        </EmptyState>
      ) : (
        <Card className="divide-y divide-stone-100" aria-busy={loading}>
          {entries.map((e) => (
            <LogRow
              key={e.id}
              entry={e}
              kindName={kindNames[e.kind]}
              blocked={blocked.has(e.toEmail)}
            />
          ))}
        </Card>
      )}
      {!done && entries.length > 0 && (
        <Button
          variant="secondary"
          disabled={loading}
          onClick={() => load(filter, entries.at(-1)!.id)}
        >
          {loading ? 'Henter …' : 'Vis eldre'}
        </Button>
      )}
    </section>
  )
}

function LogRow({
  entry: e,
  kindName,
  blocked,
}: {
  entry: EmailLogEntry
  kindName: string
  blocked: boolean
}) {
  const { viewer } = Route.useRouteContext()
  const canManage = viewer.permissions.includes('email.manage')
  const router = useRouter()
  const block = useServerFn(blockAddress)
  const [busy, setBusy] = useState(false)
  const failed = e.status !== 'sent'
  return (
    <div className="flex gap-3 px-4 py-3">
      <div
        className={cx(
          'mt-0.5 grid size-7 shrink-0 place-items-center rounded-full',
          failed ? 'bg-red-50 text-red-700' : 'bg-stone-100 text-stone-500',
        )}
      >
        {failed ? (
          <MailX className="size-3.5" aria-hidden />
        ) : (
          <Mail className="size-3.5" aria-hidden />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-stone-900">{e.subject}</p>
        <p className="mt-0.5 text-sm text-stone-600">
          {e.person ? (
            <Link
              to="/medlemmer/$personId"
              params={{ personId: e.person.personId }}
              className="font-medium text-stone-800 hover:underline"
            >
              {e.person.fullName}
            </Link>
          ) : (
            <span className="text-stone-500">Ingen profil</span>
          )}{' '}
          <span className="break-all text-stone-500">· {e.toEmail}</span>
        </p>
        <p className="mt-0.5 text-xs text-stone-500">
          {kindName}
          {e.items > 1 && ` · ${e.items} varsler`} · {timestamp(e.createdAt)}
          {failed && (
            <span className="font-medium text-red-700">
              {' '}
              · {statusNames[e.status]}
              {e.errorReason && e.status === 'failed'
                ? `: ${errorNames[e.errorReason] ?? e.errorReason}`
                : ''}
            </span>
          )}
        </p>
      </div>
      {blocked ? (
        <span className="self-center rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600">
          Stoppet
        </span>
      ) : (
        canManage && (
          <Button
            variant="ghost"
            size="sm"
            className="self-center"
            disabled={busy}
            title="Appen sender ikke mer til denne adressen"
            onClick={async () => {
              setBusy(true)
              try {
                await block({ data: { email: e.toEmail } })
                await router.invalidate()
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Stopper …' : 'Stopp'}
          </Button>
        )
      )}
    </div>
  )
}
