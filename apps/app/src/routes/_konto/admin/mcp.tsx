import { MCP_RECIPES, MCP_TOOL_COUNT, MCP_TOOL_GROUPS } from '@esaf/mcp/catalog'
import { createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { Bot, KeyRound, Plug, ShieldCheck, Sparkles, Terminal } from 'lucide-react'
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { Dialog, DialogActions } from '#/components/Dialog.tsx'
import { CopyButton } from '#/components/ShareLink.tsx'
import { Button, Card, cx, ErrorText, Field, Input, Select, Switch } from '#/components/ui.tsx'
import { fetchApiTokens, newApiToken, removeApiToken } from '#/lib/api-tokens.functions.ts'
import { longDay, timeAgo } from '#/lib/format.ts'
import { fetchMcpConnections, removeMcpConnection } from '#/lib/mcp-oauth.functions.ts'

/**
 * Admin-MCP-en: hva den er, oppsett for hver klient, hva den kan, klientene som
 * er koblet til, og MCP-nøkler for skript og klienter uten innlogging. Klientene
 * kobler til ved å logge inn i nettleseren (OAuth, se `mcp-oauth.ts` i
 * @esaf/core); en nøkkel vises én gang (`api-tokens.ts`). Oversikten over
 * verktøyene står i `@esaf/mcp/catalog`.
 */
export const Route = createFileRoute('/_konto/admin/mcp')({
  beforeLoad: ({ context: { viewer } }) => {
    if (!viewer.permissions.includes('mcp.access')) throw notFound()
  },
  loader: async () => {
    const [{ endpoint, tokens }, connections] = await Promise.all([
      fetchApiTokens(),
      fetchMcpConnections(),
    ])
    return { endpoint, tokens, connections }
  },
  head: () => ({ meta: [{ title: 'MCP – Admin – ESAF' }] }),
  component: Mcp,
  errorComponent: ({ error }) => (
    <ErrorText>{error instanceof Error ? error.message : 'Noe gikk galt.'}</ErrorText>
  ),
})

type ApiToken = Awaited<ReturnType<typeof fetchApiTokens>>['tokens'][number]
type Connection = Awaited<ReturnType<typeof fetchMcpConnections>>[number]

const examples = [
  'Legg inn ES 2026 fra dette regnearket, med bilder.',
  'Hvem i nettverket kan noe om romfart?',
  'Fyll ut alt vi mangler om Rakettverket, med kilder.',
  'Hvilke profiler fra ES 2015 mangler stilling?',
  'Skriv søkeord for alle som trenger det.',
  'Vis ES-universet.',
]

function Mcp() {
  const { endpoint, tokens, connections } = Route.useLoaderData()

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
                Koble Claude, ChatGPT eller Codex til ESAF ved å logge inn med ESAF-kontoen din. Da
                kan klienten gjøre alt du kan gjøre her under Admin: legge inn et nytt kull, rette
                og berike profiler og selskaper med informasjon fra nettet, rydde i Gjennomgang, og
                finne folk på hva de kan. Den gjør aldri mer enn du har lov til, og alt står i
                loggen merket med navnet på klienten.
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

      <Step n={1} title="Koble til klienten" icon={Terminal}>
        <Setup list={clients(endpoint)} />
      </Step>

      <Step n={2} title="Spør" icon={Sparkles}>
        <Catalog />
      </Step>

      <Card className="p-5 sm:p-6">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-stone-950">
          <Plug className="size-4 text-stone-500" aria-hidden /> Tilkoblet
        </h2>
        <Connections connections={connections} />
      </Card>

      <Card className="p-5 sm:p-6">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-stone-950">
            <KeyRound className="size-4 text-stone-500" aria-hidden /> MCP-nøkler
            <span className="font-normal text-stone-500">
              for skript og klienter som ikke kan logge inn
            </span>
          </summary>
          <div className="mt-4 space-y-4">
            <KeySection endpoint={endpoint} tokens={tokens} />
          </div>
        </details>
      </Card>

      <Card className="p-5 sm:p-6">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-950">
          <ShieldCheck className="size-4 text-stone-500" aria-hidden /> Regler
        </h2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-stone-600">
          <li>
            Bare admins som er logget inn med passkey eller tofaktor, kan koble til en klient. Den
            får aldri mer enn kontoen din har nå: mister du adminrollen, eller fjerner passkey og
            tofaktor, slutter den å virke.
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
            Klienten sender det den leser fra ESAF til sin egen modell (Claude hos Anthropic,
            ChatGPT og Codex hos OpenAI). Bruk en konto som ikke lagrer samtalene til trening.
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
// Tilkoblede klienter
// ---------------------------------------------------------------------------

function Connections({ connections }: { connections: Connection[] }) {
  const router = useRouter()
  const [removing, setRemoving] = useState<Connection | null>(null)
  if (!connections.length) {
    return (
      <p className="text-sm text-stone-600">
        Ingen klienter er koblet til ennå. Når du logger inn fra en klient og godkjenner den, står
        den her.
      </p>
    )
  }
  return (
    <>
      <ul className="divide-y divide-stone-100 rounded-xl ring-1 ring-stone-200 ring-inset">
        {connections.map((c) => (
          <li key={c.clientId} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
            <Plug className="size-4 shrink-0 text-stone-400" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-stone-900">
                {c.name ?? 'MCP-klient uten navn'}
                {c.readOnly && <span className="ml-2 font-normal text-stone-500">bare lesing</span>}
              </p>
              <p className="text-xs text-stone-500">
                Koblet til {longDay(c.connectedAt)} ·{' '}
                {c.lastActiveAt ? `aktiv ${timeAgo(c.lastActiveAt)}` : 'ikke brukt ennå'}
                {c.redirectHosts.length > 0 && <> · {c.redirectHosts.join(', ')}</>}
              </p>
            </div>
            <Button variant="danger" size="sm" onClick={() => setRemoving(c)}>
              Koble fra
            </Button>
          </li>
        ))}
      </ul>
      {removing && (
        <Disconnect
          connection={removing}
          onClose={() => setRemoving(null)}
          onDone={async () => {
            setRemoving(null)
            await router.invalidate()
          }}
        />
      )}
    </>
  )
}

function Disconnect({
  connection,
  onClose,
  onDone,
}: {
  connection: Connection
  onClose: () => void
  onDone: () => void
}) {
  const remove = useServerFn(removeMcpConnection)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function disconnect() {
    setBusy(true)
    setError(null)
    try {
      await remove({ data: { clientId: connection.clientId } })
      onDone()
    } catch (e) {
      setBusy(false)
      setError(e instanceof Error ? e.message : 'Kunne ikke koble fra klienten.')
    }
  }
  return (
    <Dialog
      title={`Koble fra «${connection.name ?? 'MCP-klient uten navn'}»?`}
      description="Klienten mister tilgangen med en gang. Vil du bruke den igjen, logger du inn og godkjenner den på nytt."
      onClose={onClose}
      busy={busy}
    >
      {error && <ErrorText>{error}</ErrorText>}
      <DialogActions>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Avbryt
        </Button>
        <Button variant="destructive" onClick={disconnect} disabled={busy} data-autofocus>
          {busy ? 'Kobler fra …' : 'Koble fra'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Nøkler
// ---------------------------------------------------------------------------

/** Nøklene og oppsettet med nøkkel. Den som nettopp ble laget, fylles inn i oppsettet. */
function KeySection({ endpoint, tokens }: { endpoint: string; tokens: ApiToken[] }) {
  // Nøkkelen som nettopp ble laget. Den finnes bare her, til siden lastes på nytt.
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null)
  return (
    <>
      <p className="text-sm text-stone-600">
        Bruk innlogging over når du kan. En nøkkel er for det som ikke kan logge inn i en nettleser,
        som skript og servere, og må holdes like hemmelig som et passord.
      </p>
      {created ? (
        <NewToken {...created} onDone={() => setCreated(null)} />
      ) : (
        <Keys tokens={tokens} onCreated={setCreated} />
      )}
      <Setup list={keyClients(endpoint, created?.token ?? KEY_PLACEHOLDER)} keyMissing={!created} />
    </>
  )
}

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
        Én nøkkel per maskin eller skript, så du kan trekke tilbake én uten å miste de andre. Med
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
        Nøkkelen «{name}» er laget. Kopier den nå, eller bruk oppsettet under, som allerede har den:
        du får ikke se den igjen. Den er like hemmelig som et passord.
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

/** Oppsett med innlogging (OAuth): adressen, så logger klienten inn selv. */
function clients(endpoint: string): Client[] {
  const approve = 'Logg inn med ESAF-kontoen din i nettleseren som åpnes, og godkjenn klienten.'
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      intro: 'Kjør i terminalen. Med --scope user virker den i alle mapper.',
      steps: [
        {
          text: 'Legg til serveren:',
          code: `claude mcp add --transport http --scope user esaf ${endpoint}`,
        },
        {
          text: (
            <>
              Skriv <Mono>/mcp</Mono> i Claude Code, velg «esaf» og «Authenticate». {approve}
            </>
          ),
        },
      ],
      check: (
        <>
          «esaf» skal stå som tilkoblet under <Mono>/mcp</Mono>. Innloggingen fornyes av seg selv;
          du logger inn på nytt etter 30 dager uten bruk.
        </>
      ),
    },
    {
      id: 'claude',
      label: 'Claude',
      intro:
        'I Claude på nettet, Claude Desktop og mobilappen. En connector du legger til, finnes i alle tre.',
      steps: [
        {
          text: (
            <>
              Gå til Innstillinger → Connectors og velg «Add custom connector». Gi den navnet ESAF
              og lim inn adressen:
            </>
          ),
          code: endpoint,
        },
        { text: <>Trykk «Connect». {approve}</> },
      ],
      check: (
        <>
          ESAF skal stå under verktøyene i en ny samtale. Her vises ES-universet som et interaktivt
          kart. På Team- og Enterprise-planer må en eier av Claude-organisasjonen legge til
          connectoren først.
        </>
      ),
    },
    {
      id: 'chatgpt',
      label: 'ChatGPT',
      intro:
        'Krever et betalt abonnement med utviklermodus (Developer mode) slått på under Innstillinger → Apps.',
      steps: [
        {
          text: (
            <>
              Under Innstillinger → Apps, lag en ny app med navnet ESAF, adressen under og
              autentisering «OAuth»:
            </>
          ),
          code: endpoint,
        },
        { text: approve },
      ],
      check: 'Velg ESAF under verktøyene i en ny samtale.',
    },
    {
      id: 'codex',
      label: 'Codex',
      intro: 'Kjør i terminalen.',
      steps: [
        { text: 'Legg til serveren:', code: `codex mcp add esaf --url ${endpoint}` },
        { text: <>Logg inn. {approve}</>, code: 'codex mcp login esaf' },
      ],
      check: (
        <>
          Sjekk med <Mono>codex mcp list</Mono>, eller <Mono>/mcp</Mono> i Codex.
        </>
      ),
    },
    {
      id: 'other',
      label: 'Andre',
      intro:
        'Klienter som støtter MCP over HTTP med innlogging (OAuth). De finner innloggingen selv ut fra adressen.',
      steps: [{ text: 'Adresse (Streamable HTTP):', code: endpoint }],
      check: 'Kan klienten ikke logge inn, bruk en MCP-nøkkel (under).',
    },
  ]
}

/** Oppsett med en MCP-nøkkel, for det som ikke kan logge inn. */
function keyClients(endpoint: string, key: string): Client[] {
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      intro: 'Kjør i terminalen.',
      steps: [
        {
          text: 'Legg til serveren med nøkkelen:',
          code: `claude mcp add --transport http --scope user esaf ${endpoint} --header "Authorization: Bearer ${key}"`,
        },
      ],
      check: (
        <>
          Sjekk med <Mono>/mcp</Mono> i Claude Code.
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
          Sjekk med <Mono>codex mcp list</Mono>.
        </>
      ),
    },
    {
      id: 'other',
      label: 'Skript og andre',
      intro: 'Send nøkkelen i et hode med hver forespørsel.',
      steps: [
        { text: 'Adresse (Streamable HTTP):', code: endpoint },
        { text: 'Hode:', code: `Authorization: Bearer ${key}` },
      ],
      check: 'Nøkkelen gir det samme som en innlogget klient, så ikke legg den i kode som deles.',
    },
  ]
}

function Setup({ list, keyMissing = false }: { list: Client[]; keyMissing?: boolean }) {
  const id = useId()
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
        {keyMissing && client.steps.some((s) => s.code?.includes(KEY_PLACEHOLDER)) && (
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
