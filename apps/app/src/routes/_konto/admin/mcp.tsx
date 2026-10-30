import { MCP_RECIPES, MCP_TOOL_COUNT, MCP_TOOL_GROUPS } from '@esaf/mcp/catalog'
import { createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { Bot, KeyRound, ShieldCheck, Sparkles, Terminal } from 'lucide-react'
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { Dialog, DialogActions } from '#/components/Dialog.tsx'
import { CopyButton } from '#/components/ShareLink.tsx'
import { Button, Card, cx, ErrorText, Field, Input, Select, Switch } from '#/components/ui.tsx'
import { fetchApiTokens, newApiToken, removeApiToken } from '#/lib/api-tokens.functions.ts'
import { longDay, timeAgo } from '#/lib/format.ts'

/**
 * Admin-MCP-en: hva den er, nøklene, oppsett for hver klient og hva den kan.
 * Nøkkelen vises én gang. Reglene står i `api-tokens.ts` i @esaf/core og i
 * @esaf/mcp; oversikten over verktøyene i `@esaf/mcp/catalog`.
 */
export const Route = createFileRoute('/_konto/admin/mcp')({
  beforeLoad: ({ context: { viewer } }) => {
    if (!viewer.permissions.includes('mcp.access')) throw notFound()
  },
  loader: () => fetchApiTokens(),
  head: () => ({ meta: [{ title: 'MCP – Admin – ESAF' }] }),
  component: Mcp,
  errorComponent: ({ error }) => (
    <ErrorText>{error instanceof Error ? error.message : 'Noe gikk galt.'}</ErrorText>
  ),
})

type ApiToken = Awaited<ReturnType<typeof fetchApiTokens>>['tokens'][number]

const examples = [
  'Legg inn ES 2026 fra dette regnearket, med bilder.',
  'Hvem i nettverket kan noe om romfart?',
  'Fyll ut alt vi mangler om Rakettverket, med kilder.',
  'Hvilke profiler fra ES 2015 mangler stilling?',
  'Skriv søkeord for alle som trenger det.',
  'Vis ES-universet.',
]

function Mcp() {
  const { endpoint, tokens } = Route.useLoaderData()
  // Nøkkelen som nettopp ble laget. Den finnes bare her, til siden lastes på nytt.
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null)

  return (
    <div className="space-y-6">
      <Card className="p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <span className="hidden rounded-xl bg-brand-50 p-2.5 text-brand-700 ring-1 ring-brand-100 sm:block">
            <Bot className="size-6" aria-hidden />
          </span>
          <div className="min-w-0 space-y-3">
            <div>
              <h2 className="text-base font-semibold text-stone-950">
                Gjør adminarbeid ved å skrive hva du vil ha gjort
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-stone-600">
                Koble Claude Code, Codex eller Claude Desktop til ESAF med en MCP-nøkkel. Da kan
                klienten gjøre alt du kan gjøre her under Admin: legge inn et nytt kull, rette og
                berike profiler og selskaper med informasjon fra nettet, rydde i Gjennomgang, og
                finne folk på hva de kan. Den gjør aldri mer enn du har lov til, og alt står i
                loggen merket med navnet på nøkkelen.
              </p>
            </div>
            <ul className="flex flex-wrap gap-2">
              {examples.map((e) => (
                <li
                  key={e}
                  className="rounded-full bg-stone-50 px-3 py-1 text-xs text-stone-700 ring-1 ring-stone-200 ring-inset"
                >
                  «{e}»
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Card>

      <Step n={1} title="Lag en nøkkel" icon={KeyRound}>
        {created ? (
          <NewToken {...created} onDone={() => setCreated(null)} />
        ) : (
          <Keys tokens={tokens} onCreated={setCreated} />
        )}
      </Step>

      <Step n={2} title="Koble til klienten" icon={Terminal}>
        <Setup endpoint={endpoint} token={created?.token ?? null} />
      </Step>

      <Step n={3} title="Spør" icon={Sparkles}>
        <Catalog />
      </Step>

      <Card className="p-5 sm:p-6">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-950">
          <ShieldCheck className="size-4 text-stone-500" aria-hidden /> Regler
        </h2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-stone-600">
          <li>
            Nøkkelen gir aldri mer enn kontoen din har nå. Mister du adminrollen, eller fjerner
            passkey og tofaktor, slutter den å virke.
          </li>
          <li>
            Endringer i mange profiler på én gang vises alltid som en plan først; ingenting lagres
            før du har sagt ja.
          </li>
          <li>
            Profiler gir aldri noen tilgang. Bare invitasjoner gjør det, og klienten lager dem bare
            når du ber om det.
          </li>
          <li>
            Det klienten finner på nettet, lagres med kilde og vises som «ikke bekreftet» til
            personen bekrefter det. Aldri sensitive opplysninger.
          </li>
          <li>
            Klienten sender det den leser fra ESAF til sin egen modell (Claude hos Anthropic, Codex
            hos OpenAI). Bruk en konto som ikke lagrer samtalene til trening.
          </li>
        </ul>
      </Card>
    </div>
  )
}

function Step({
  n,
  title,
  icon: Icon,
  children,
}: {
  n: number
  title: string
  icon: typeof Bot
  children: ReactNode
}) {
  return (
    <Card className="p-5 sm:p-6">
      <h2 className="mb-4 flex items-center gap-2.5 text-sm font-semibold text-stone-950">
        <span className="grid size-6 place-items-center rounded-full bg-stone-900 text-xs text-white tabular-nums">
          {n}
        </span>
        {title}
        <Icon className="size-4 text-stone-400" aria-hidden />
      </h2>
      <div className="space-y-4">{children}</div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Nøkler
// ---------------------------------------------------------------------------

const lifetimes = [
  { days: 30, label: '30 dager' },
  { days: 90, label: '90 dager' },
  { days: 365, label: 'Ett år' },
]

function Keys({
  tokens,
  onCreated,
}: {
  tokens: ApiToken[]
  onCreated: (created: { token: string; name: string }) => void
}) {
  const router = useRouter()
  const create = useServerFn(newApiToken)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [readOnly, setReadOnly] = useState(false)
  const [revoking, setRevoking] = useState<ApiToken | null>(null)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    setError(null)
    try {
      const result = await create({
        data: { name: String(form.get('name')), days: Number(form.get('days')), readOnly },
      })
      onCreated({ token: result.token, name: result.view.name })
      setCreating(false)
      setReadOnly(false)
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lage nøkkelen.')
    } finally {
      setBusy(false)
    }
  }

  const active = tokens.filter((t) => t.status === 'active')
  const old = tokens.filter((t) => t.status !== 'active')

  return (
    <>
      <p className="text-sm text-stone-600">
        Én nøkkel per maskin eller klient, så du kan trekke tilbake én uten å miste de andre. Med
        «Bare lesing» kan klienten slå opp og søke, men ikke endre noe.
      </p>
      {active.length > 0 && (
        <ul className="divide-y divide-stone-100 rounded-xl ring-1 ring-stone-200 ring-inset">
          {active.map((t) => (
            <TokenRow key={t.id} token={t} onRevoke={() => setRevoking(t)} />
          ))}
        </ul>
      )}

      {creating ? (
        <form
          onSubmit={onSubmit}
          className="space-y-3 rounded-xl p-4 ring-1 ring-stone-200 ring-inset"
        >
          <Field label="Navn" hint="Så du kjenner den igjen, for eksempel hvor den brukes.">
            <Input
              name="name"
              maxLength={80}
              placeholder="Claude Code på laptopen"
              autoComplete="off"
              required
              autoFocus
            />
          </Field>
          <Field label="Gyldig i">
            <Select name="days" defaultValue="90">
              {lifetimes.map((l) => (
                <option key={l.days} value={l.days}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>
          <Switch
            checked={readOnly}
            onChange={setReadOnly}
            label="Bare lesing"
            description="Klienten kan slå opp og søke, men ikke endre noe."
          />
          {error && <ErrorText>{error}</ErrorText>}
          <div className="flex gap-2">
            <Button type="submit" variant="brand" disabled={busy}>
              {busy ? 'Lager …' : 'Lag nøkkel'}
            </Button>
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={busy}>
              Avbryt
            </Button>
          </div>
        </form>
      ) : (
        <Button variant={active.length ? 'secondary' : 'brand'} onClick={() => setCreating(true)}>
          <KeyRound className="size-4" aria-hidden />
          Ny MCP-nøkkel
        </Button>
      )}

      {old.length > 0 && (
        <details className="text-sm text-stone-600">
          <summary className="cursor-pointer text-stone-500">
            Utløpte og tilbaketrukne ({old.length})
          </summary>
          <ul className="mt-2 divide-y divide-stone-100 rounded-xl ring-1 ring-stone-200 ring-inset">
            {old.map((t) => (
              <TokenRow key={t.id} token={t} />
            ))}
          </ul>
        </details>
      )}

      {revoking && (
        <RevokeToken
          token={revoking}
          onClose={() => setRevoking(null)}
          onDone={async () => {
            setRevoking(null)
            await router.invalidate()
          }}
        />
      )}
    </>
  )
}

function TokenRow({ token: t, onRevoke }: { token: ApiToken; onRevoke?: () => void }) {
  const status =
    t.status === 'active'
      ? `Gyldig til ${longDay(t.expiresAt)}`
      : t.status === 'expired'
        ? `Utløpt ${longDay(t.expiresAt)}`
        : `Trukket tilbake ${longDay(t.revokedAt!)}`
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
      <KeyRound className="size-4 shrink-0 text-stone-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-stone-900">
          {t.name}
          {t.readOnly && <span className="ml-2 font-normal text-stone-500">bare lesing</span>}
        </p>
        <p className="text-xs text-stone-500">
          <span className="font-mono">{t.prefix}…</span> · {status} ·{' '}
          {t.lastUsedAt ? `brukt ${timeAgo(t.lastUsedAt)}` : 'aldri brukt'}
        </p>
      </div>
      {onRevoke && (
        <Button variant="danger" size="sm" onClick={onRevoke}>
          Trekk tilbake
        </Button>
      )}
    </li>
  )
}

/** Nøkkelen, én gang. Oppsettet under fylles ut med den. */
function NewToken({ token, name, onDone }: { token: string; name: string; onDone: () => void }) {
  return (
    <div className="space-y-3 rounded-xl bg-amber-50/60 p-4 ring-1 ring-amber-200 ring-inset">
      <p className="text-sm text-stone-700">
        Nøkkelen «{name}» er laget. Kopier den nå, eller bruk kommandoene under, som allerede har
        den: du får ikke se den igjen. Den er like hemmelig som et passord.
      </p>
      <code className="block rounded-lg bg-white p-3 font-mono text-sm break-all text-stone-900 ring-1 ring-stone-200 ring-inset">
        {token}
      </code>
      <div className="flex flex-wrap gap-2">
        <CopyButton text={token} label="Kopier nøkkelen" />
        <Button variant="brand" size="sm" onClick={onDone}>
          Jeg har tatt vare på den
        </Button>
      </div>
    </div>
  )
}

function RevokeToken({
  token,
  onClose,
  onDone,
}: {
  token: ApiToken
  onClose: () => void
  onDone: () => void
}) {
  const remove = useServerFn(removeApiToken)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function revoke() {
    setBusy(true)
    setError(null)
    try {
      await remove({ data: { id: token.id } })
      onDone()
    } catch (e) {
      setBusy(false)
      setError(e instanceof Error ? e.message : 'Kunne ikke trekke tilbake nøkkelen.')
    }
  }
  return (
    <Dialog
      title={`Trekke tilbake «${token.name}»?`}
      description="Klienter som bruker nøkkelen, mister tilgangen med en gang. Det kan ikke angres."
      onClose={onClose}
      busy={busy}
    >
      {error && <ErrorText>{error}</ErrorText>}
      <DialogActions>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Avbryt
        </Button>
        <Button variant="destructive" onClick={revoke} disabled={busy} data-autofocus>
          {busy ? 'Trekker tilbake …' : 'Trekk tilbake'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Oppsett per klient
// ---------------------------------------------------------------------------

const KEY_PLACEHOLDER = '<nøkkelen>'

type Client = {
  id: string
  label: string
  intro: ReactNode
  steps: { text: ReactNode; code?: string }[]
  check: ReactNode
}

function clients(endpoint: string, key: string): Client[] {
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      intro: 'Kjør i terminalen. Med --scope user virker den i alle mapper.',
      steps: [
        {
          text: 'Legg til serveren:',
          code: `claude mcp add --transport http --scope user esaf ${endpoint} --header "Authorization: Bearer ${key}"`,
        },
      ],
      check: (
        <>
          Sjekk med <Mono>/mcp</Mono> i Claude Code: «esaf» skal stå som tilkoblet.
        </>
      ),
    },
    {
      id: 'codex',
      label: 'Codex',
      intro: 'Codex leser nøkkelen fra en miljøvariabel, så den ikke står i oppsettet.',
      steps: [
        {
          text: (
            <>
              Legg nøkkelen i <Mono>~/.zshrc</Mono> (eller <Mono>~/.bashrc</Mono>), og åpne en ny
              terminal:
            </>
          ),
          code: `export ESAF_MCP_TOKEN="${key}"`,
        },
        {
          text: 'Legg til serveren:',
          code: `codex mcp add esaf --url ${endpoint} --bearer-token-env-var ESAF_MCP_TOKEN`,
        },
      ],
      check: (
        <>
          Sjekk med <Mono>codex mcp list</Mono>, eller <Mono>/mcp</Mono> i Codex.
        </>
      ),
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      intro: (
        <>
          Claude Desktop kobler til med <Mono>mcp-remote</Mono>, som krever Node.js. «Legg til
          connector» i innstillingene virker ikke: den krever innlogging med OAuth, som ESAF ikke
          har.
        </>
      ),
      steps: [
        {
          text: (
            <>
              Åpne Innstillinger → Developer → Edit Config (filen{' '}
              <Mono>claude_desktop_config.json</Mono>) og legg inn dette. Har filen andre servere
              fra før, legg «esaf» inn under <Mono>mcpServers</Mono> ved siden av dem.
            </>
          ),
          code: JSON.stringify(
            {
              mcpServers: {
                esaf: {
                  command: 'npx',
                  args: ['-y', 'mcp-remote', endpoint, '--header', 'Authorization:${ESAF_AUTH}'],
                  env: { ESAF_AUTH: `Bearer ${key}` },
                },
              },
            },
            null,
            2,
          ),
        },
        { text: 'Avslutt Claude Desktop helt og åpne den igjen.' },
      ],
      check: (
        <>
          «esaf» skal stå under verktøyene i en ny samtale. Her vises ES-universet som et
          interaktivt kart.
        </>
      ),
    },
    {
      id: 'other',
      label: 'Andre',
      intro: 'Klienter som kan koble til en MCP-server over HTTP med et eget hode.',
      steps: [
        { text: 'Adresse (Streamable HTTP):', code: endpoint },
        { text: 'Hode:', code: `Authorization: Bearer ${key}` },
      ],
      check: 'Claude.ai i nettleseren og ChatGPT krever OAuth og kan ikke kobles til ennå.',
    },
  ]
}

function Setup({ endpoint, token }: { endpoint: string; token: string | null }) {
  const id = useId()
  const list = clients(endpoint, token ?? KEY_PLACEHOLDER)
  const [selected, setSelected] = useState(list[0]!.id)
  const client = list.find((c) => c.id === selected) ?? list[0]!
  return (
    <>
      <div role="tablist" aria-label="Klient" className="flex flex-wrap gap-2">
        {list.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            id={`${id}-${c.id}`}
            aria-selected={c.id === client.id}
            aria-controls={`${id}-panel`}
            onClick={() => setSelected(c.id)}
            className={cx(
              'rounded-full px-3 py-1.5 text-sm font-medium ring-1 transition ring-inset',
              c.id === client.id
                ? 'bg-stone-900 text-white ring-stone-900'
                : 'bg-white text-stone-600 ring-stone-200 hover:ring-stone-300',
            )}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${client.id}`}
        className="space-y-4"
      >
        <p className="text-sm text-stone-600">{client.intro}</p>
        {!token && client.steps.some((s) => s.code?.includes(KEY_PLACEHOLDER)) && (
          <p className="text-xs text-stone-500">
            Bytt ut <Mono>{KEY_PLACEHOLDER}</Mono> med nøkkelen. Lager du en ny nøkkel over, fylles
            den inn her.
          </p>
        )}
        <ol className="space-y-4">
          {client.steps.map((step, i) => (
            <li key={i} className="space-y-2">
              <p className="text-sm text-stone-800">
                <span className="mr-1.5 text-stone-400 tabular-nums">{i + 1}.</span>
                {step.text}
              </p>
              {step.code && (
                <>
                  <pre className="overflow-x-auto rounded-xl bg-stone-50 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-stone-900 ring-1 ring-stone-200 ring-inset [overflow-wrap:anywhere]">
                    {step.code}
                  </pre>
                  <CopyButton text={step.code} label="Kopier" />
                </>
              )}
            </li>
          ))}
        </ol>
        <p className="text-sm text-stone-600">{client.check}</p>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Hva den kan
// ---------------------------------------------------------------------------

function Catalog() {
  return (
    <>
      <p className="text-sm text-stone-600">
        Skriv hva du vil ha gjort, med vanlige ord. For de vanligste jobbene har serveren ferdige
        oppskrifter. I Claude Code ligger de som kommandoer (for eksempel{' '}
        <Mono>/mcp__esaf__onboard_cohort</Mono>), men det holder å be om det.
      </p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {MCP_RECIPES.map((r) => (
          <li key={r.name} className="rounded-xl p-4 ring-1 ring-stone-200 ring-inset">
            <p className="text-sm font-medium text-stone-900">{r.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-stone-600">{r.description}</p>
            <p className="mt-2 text-xs text-stone-500 italic">«{r.example}»</p>
          </li>
        ))}
      </ul>
      <div>
        <p className="mb-2 text-sm font-medium text-stone-800">Alle {MCP_TOOL_COUNT} verktøyene</p>
        <ul className="divide-y divide-stone-100 rounded-xl ring-1 ring-stone-200 ring-inset">
          {MCP_TOOL_GROUPS.map((g) => (
            <li key={g.id}>
              <details className="group p-3">
                <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3">
                  <span className="text-sm font-medium text-stone-900">{g.title}</span>
                  <span className="text-xs text-stone-500 tabular-nums">{g.tools.length}</span>
                </summary>
                <p className="mt-1.5 text-xs leading-relaxed text-stone-600">{g.description}</p>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {g.tools.map((t) => (
                    <li
                      key={t}
                      className="rounded bg-stone-50 px-1.5 py-0.5 font-mono text-[11px] text-stone-700 ring-1 ring-stone-200 ring-inset"
                    >
                      {t}
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[0.9em]">{children}</span>
}
