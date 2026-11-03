import type { AuditPerson } from '@esaf/core'
import type { MemberRole } from '@esaf/db'
import { createFileRoute, isNotFound, Link, notFound } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { Bot, History, Terminal, UserRound } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Avatar, Button, Card, EmptyState, ErrorText } from '#/components/ui.tsx'
import { auditPageSize, fetchAuditLog } from '#/lib/admin.functions.ts'
import { boardRoleInSentence } from '#/lib/board.ts'
import { clockTime, dayKey, dayLabel, plural, timestamp } from '#/lib/format.ts'
import { roleNames } from '#/lib/roles.ts'
import { companyFieldLabels, profileFieldLabels } from '#/lib/sources.ts'

export const Route = createFileRoute('/_konto/admin/logg')({
  beforeLoad: ({ context: { viewer } }) => {
    if (!viewer.permissions.includes('audit.read')) throw notFound()
  },
  loader: () => fetchAuditLog({ data: {} }),
  head: () => ({ meta: [{ title: 'Logg – Admin – ESAF' }] }),
  component: AuditLog,
  errorComponent: ({ error }) => (
    <ErrorText>{error instanceof Error ? error.message : 'Noe gikk galt.'}</ErrorText>
  ),
})

type Entry = Awaited<ReturnType<typeof fetchAuditLog>>[number]

function AuditLog() {
  const first = Route.useLoaderData()
  const fetchPage = useServerFn(fetchAuditLog)
  // Eldre sider hører til den første siden de ble hentet etter. Hentes loggen på
  // nytt (ny navigasjon eller invalidering), begynner bla-ingen fra toppen igjen.
  const [older, setOlder] = useState<{ after: Entry[]; entries: Entry[]; done: boolean } | null>(
    null,
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const end = useRef<HTMLParagraphElement>(null)

  const more = older?.after === first ? older : null
  const entries = more ? [...first, ...more.entries] : first
  const done = more ? more.done : first.length < auditPageSize

  async function loadOlder() {
    const last = entries.at(-1)
    if (!last) return
    setLoading(true)
    setError(null)
    try {
      // Blar fra den siste hendelsen (tidspunkt og id), så hendelser med samme
      // tidspunkt, som en import skriver mange av, aldri hoppes over.
      const page = await fetchPage({ data: { beforeId: last.id } })
      const seen = new Set(entries.map((e) => e.id))
      const fresh = page.filter((e) => !seen.has(e.id))
      const finished = page.length < auditPageSize || fresh.length === 0
      flushSync(() => {
        setOlder({ after: first, entries: [...(more?.entries ?? []), ...fresh], done: finished })
        setAnnouncement(
          fresh.length ? `Viser ${plural(fresh.length, 'eldre hendelse', 'eldre hendelser')}.` : '',
        )
      })
      // Knappen forsvinner når alt er hentet; fokus flyttes til teksten som står der i stedet.
      if (finished) end.current?.focus()
    } catch (e) {
      setError(
        isNotFound(e)
          ? 'Du har ikke lenger tilgang til loggen. Last siden på nytt.'
          : e instanceof Error
            ? e.message
            : 'Kunne ikke hente eldre hendelser.',
      )
    } finally {
      setLoading(false)
    }
  }

  // Grupper på dag i norsk tid. Listen er allerede sortert nyeste først.
  const days: { key: string; label: string; entries: Entry[] }[] = []
  for (const entry of entries) {
    const key = dayKey(entry.createdAt)
    const day = days.at(-1)
    if (day?.key === key) day.entries.push(entry)
    else days.push({ key, label: dayLabel(entry.createdAt), entries: [entry] })
  }

  return (
    <div className="max-w-3xl">
      <p className="mb-5 text-sm text-stone-500">
        Hvem som har gjort hva med tilgang, roller, profiler, selskaper, sitater, forslag, styret,
        kullrepresentanter, arrangementer og andres innhold, nyeste først. Hendelsene kan ikke
        endres eller slettes i appen.
      </p>

      {entries.length === 0 ? (
        <EmptyState icon={History} title="Ingen hendelser ennå">
          Forespørsler, godkjenninger og rolleendringer havner her.
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {days.map((day) => (
            <section key={day.key} aria-labelledby={`dag-${day.key}`}>
              <h2 id={`dag-${day.key}`} className="mb-2 text-sm font-medium text-stone-500">
                {day.label}
              </h2>
              <Card>
                <ol className="divide-y divide-stone-100">
                  {day.entries.map((entry) => (
                    <LogEntry key={entry.id} entry={entry} />
                  ))}
                </ol>
              </Card>
            </section>
          ))}
        </div>
      )}

      <p role="status" className="sr-only">
        {announcement}
      </p>
      {error && (
        <div className="mt-4">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {entries.length > 0 && (
        <div className="mt-6 text-center">
          {!done ? (
            <Button variant="secondary" onClick={loadOlder} disabled={loading}>
              {loading ? 'Henter …' : 'Vis eldre'}
            </Button>
          ) : (
            more && (
              <p ref={end} tabIndex={-1} className="text-sm text-stone-500 focus:outline-none">
                Ingen eldre hendelser.
              </p>
            )
          )}
        </div>
      )}
    </div>
  )
}

function LogEntry({ entry: e }: { entry: Entry }) {
  const reason = text(e.details.reason)
  const excerpt =
    e.action === 'content.remove_comment'
      ? text(e.details.excerpt)
      : e.action === 'quote.remove'
        ? text(e.details.text)
        : null
  const extra = Object.hasOwn(sentences, e.action)
    ? []
    : Object.entries(e.details).filter(([key, value]) => key !== 'reason' && value !== null)
  return (
    <li className="flex gap-3 px-4 py-3.5">
      <ActorMark entry={e} />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-6 text-stone-700">
          {describe(e)}
          {e.viaMcp && (
            <span
              className="ml-1.5 inline-flex items-center gap-1 text-xs text-stone-500"
              title={
                e.viaMcp.kind === 'key'
                  ? 'Gjort fra en MCP-klient, med nøkkelen til personen'
                  : 'Gjort fra en MCP-klient personen har koblet til med innlogging. Navnet er det klienten oppga.'
              }
            >
              <Bot className="size-3.5" aria-hidden />
              via MCP («{e.viaMcp.name}»)
            </span>
          )}
        </p>
        {count(e.details.revokedTokens) > 0 && (
          <p className="mt-1 text-sm text-stone-600">
            {plural(count(e.details.revokedTokens), 'MCP-nøkkel', 'MCP-nøkler')} ble trukket
            tilbake.
          </p>
        )}
        {count(e.details.revokedConnections) > 0 && (
          <p className="mt-1 text-sm text-stone-600">
            {plural(count(e.details.revokedConnections), 'MCP-tilkobling', 'MCP-tilkoblinger')} ble
            koblet fra.
          </p>
        )}
        {excerpt && (
          <blockquote className="mt-1 border-l-2 border-stone-200 pl-3 text-sm text-stone-600">
            «{excerpt}»
          </blockquote>
        )}
        {reason && (
          <p className="mt-1 text-sm text-stone-600">
            <span className="text-stone-500">Begrunnelse:</span> {reason}
          </p>
        )}
        {extra.length > 0 && (
          <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-stone-500">
            {extra.map(([key, value]) => (
              <div key={key} className="flex min-w-0 gap-1">
                <dt>{key}:</dt>
                <dd className="truncate text-stone-700">
                  {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <time
        dateTime={new Date(e.createdAt).toISOString()}
        title={timestamp(e.createdAt)}
        className="shrink-0 text-xs leading-6 text-stone-500 tabular-nums"
      >
        {clockTime(e.createdAt)}
      </time>
    </li>
  )
}

/** Hvem som gjorde det: personen, eller et ikon for operatøren på kommandolinjen. */
function ActorMark({ entry: e }: { entry: Entry }) {
  if (e.actor) return <Avatar name={e.actor.fullName} size="sm" muted={!e.actor.active} />
  // Uten utfører er det operatøren, eller en som spurte selv før de hadde en person.
  const Icon =
    e.action === 'access.request' || e.action === 'password_link.request' ? UserRound : Terminal
  return (
    <span
      aria-hidden
      className="grid size-8 shrink-0 place-items-center rounded-full bg-stone-100 text-stone-500 ring-1 ring-stone-200 ring-inset"
    >
      <Icon className="size-4" />
    </span>
  )
}

/** En person i en setning. Profilen kan bare åpnes når personen er aktivt medlem. */
function Who({ person }: { person: AuditPerson | null }) {
  if (!person) return <>en slettet person</>
  if (!person.active) return <span className="font-medium text-stone-900">{person.fullName}</span>
  return (
    <Link
      to="/medlemmer/$personId"
      params={{ personId: person.personId }}
      className="font-medium text-stone-900 hover:text-brand-600"
    >
      {person.fullName}
    </Link>
  )
}

/** Selskapet i en setning, med lenke. Gamle slugger sendes videre til selskapet. */
function Company({ details }: { details: Entry['details'] }) {
  const name = text(details.name) ?? 'et selskap'
  const slug = text(details.slug)
  if (!slug) return <>{name}</>
  return (
    <Link
      to="/selskaper/$slug"
      params={{ slug }}
      className="font-medium text-stone-900 hover:text-brand-600"
    >
      {name}
    </Link>
  )
}

/**
 * Arrangementet i en setning, med lenke. Gamle hendelser fra før ESAF-helgen
 * ble et arrangement (`weekend.*`) har `weekendId`; id-en er den samme nå.
 */
function EventLink({ details }: { details: Entry['details'] }) {
  const name = text(details.name) ?? 'et arrangement'
  const eventId = text(details.eventId) ?? text(details.weekendId)
  if (!eventId) return <>{name}</>
  return (
    <Link
      to="/arrangementer/$typeSlug/$eventId"
      params={{ typeSlug: text(details.typeSlug) ?? 'esaf-helgen', eventId }}
      className="font-medium text-stone-900 hover:text-brand-600"
    >
      {name}
    </Link>
  )
}

/** Merket i en setning. Merker har ingen egen side; de vises på profilene. */
function BadgeLink({ details }: { details: Entry['details'] }) {
  return <span className="font-medium text-stone-900">«{text(details.name) ?? 'et merke'}»</span>
}

/** Typen i en setning, med lenke. */
function EventTypeLink({ details }: { details: Entry['details'] }) {
  const name = text(details.name) ?? 'en arrangementstype'
  const slug = text(details.slug)
  if (!slug) return <>{name}</>
  return (
    <Link
      to="/arrangementer/$typeSlug"
      params={{ typeSlug: slug }}
      className="font-medium text-stone-900 hover:text-brand-600"
    >
      {name}
    </Link>
  )
}

const roleNamesNb: Record<string, string> = {
  organizer: 'arrangør',
  speaker: 'foredragsholder',
  volunteer: 'frivillig',
}
/** «arrangør», eller «deltaker» uten rolle. */
const eventRole = (value: unknown) =>
  (typeof value === 'string' && roleNamesNb[value]) || 'deltaker'

/** «ES 2024» fra `graduationYear`. */
const cohortName = (details: Entry['details']) =>
  typeof details.graduationYear === 'number' ? `ES ${details.graduationYear}` : 'et kull'

/** Hvem et sitat er fra: personen, ellers navnet slik kilden skriver det. */
const speaker = ({ subject, details, entry }: Parts) =>
  entry.subject ? subject : (text(details.speaker) ?? 'en ukjent')

/** Som `emailKindNames` i @esaf/core, som ikke kan importeres i klienten. */
const emailKindNames: Record<string, string> = {
  invitation: 'Invitasjon',
  password_link: 'Lenke for nytt passord fra admin',
  password_reset: 'Glemt passord',
  verification: 'Bekreft e-postadressen',
  welcome: 'Du er med i ESAF',
  notification: 'Varsel',
  digest: 'Oppsummering av varsler',
}
const emailKindName = (kind: unknown) =>
  (typeof kind === 'string' && emailKindNames[kind]) || 'ukjent'

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const count = (value: unknown) => (typeof value === 'number' ? value : 0)
const list = (value: unknown) =>
  Array.isArray(value) && value.length ? value.map(String).join(', ') : 'ingen'
const linkRole = (value: unknown) =>
  ({ founder: 'gründer', es: 'ES-team', employee: 'ansatt' })[String(value)] ?? 'med'
const fieldName = (value: unknown) =>
  (text(value) &&
    ({ ...profileFieldLabels, ...companyFieldLabels } as Record<string, string>)[
      text(value)!
    ]?.toLocaleLowerCase('nb')) ??
  text(value) ??
  'ukjent'
const role = (value: unknown) =>
  typeof value === 'string' && value in roleNames
    ? roleNames[value as MemberRole]
    : (text(value) ?? 'ukjent rolle')

type Parts = { actor: ReactNode; subject: ReactNode; details: Entry['details']; entry: Entry }

/**
 * Hver handling koden skriver til `audit_event`, som en setning. Ukjente
 * handlinger (for eksempel nye som ikke har fått tekst ennå) vises med navnet
 * og detaljene sine, så ingenting skjules.
 */
const sentences: Record<string, (p: Parts) => ReactNode> = {
  'access.request': ({ details, entry }) => (
    <>
      {entry.actor || entry.subject ? <Who person={entry.actor ?? entry.subject} /> : 'En søker'} ba
      om tilgang{details.profilePersonId ? ' og valgte en profil fra kullisten' : ''}.
    </>
  ),
  'access.approve': ({ actor, subject, details }) =>
    details.profilePersonId ? (
      <>
        {actor} godkjente {subject} og koblet kontoen til profilen fra kullisten.
      </>
    ) : (
      <>
        {actor} godkjente {subject} som ny person.
      </>
    ),
  'access.reject': ({ actor, subject }) => (
    <>
      {actor} avslo forespørselen fra {subject}.
    </>
  ),
  'membership.approve': ({ actor, subject }) => (
    <>
      {actor} godkjente medlemskapet til {subject}.
    </>
  ),
  'membership.reject': ({ actor, subject }) => (
    <>
      {actor} avslo medlemskapet til {subject}.
    </>
  ),
  'membership.deactivate': ({ actor, subject, details }) =>
    details.previousRole && details.previousRole !== 'member' ? (
      <>
        {actor} deaktiverte {subject} og fjernet rollen som {role(details.previousRole)}.
      </>
    ) : (
      <>
        {actor} deaktiverte {subject}.
      </>
    ),
  'membership.reactivate': ({ actor, subject }) => (
    <>
      {actor} gjenopprettet tilgangen til {subject}.
    </>
  ),
  'security.remove_passkeys': ({ actor, subject, details }) => (
    <>
      {actor} fjernet {plural(count(details.count), 'passkey', 'passkeys')} for {subject}.
    </>
  ),
  'invitation.create': ({ actor, subject, details }) => (
    <>
      {actor} inviterte {text(details.email) ?? 'en e-postadresse'}
      {details.role && details.role !== 'member' && <> som {role(details.role)}</>}
      {details.profilePersonId ? <> til profilen til {subject}</> : null}.
    </>
  ),
  'invitation.revoke': ({ actor, details }) => (
    <>
      {actor} trakk tilbake invitasjonen til {text(details.email) ?? 'en e-postadresse'}.
    </>
  ),
  'invitation.use': ({ subject, details }) => (
    <>
      {subject} tok imot en invitasjon
      {details.role && details.role !== 'member' && <> som {role(details.role)}</>}
      {details.profileLinked ? ' og tok i bruk profilen fra kullisten' : ''}
      {details.account === 'existing' ? ' med kontoen sin' : ''}.
    </>
  ),
  'password_link.create': ({ actor, subject }) => (
    <>
      {actor} laget en lenke for nytt passord til {subject}.
    </>
  ),
  'password_link.request': ({ entry, details }) => (
    <>
      {entry.subject ? (
        <Who person={entry.subject} />
      ) : (
        (text(details.email) ?? 'En konto uten profil')
      )}{' '}
      ba om en lenke for nytt passord på e-post («Glemt passord?»).
    </>
  ),
  'password_link.revoke': ({ actor, subject }) => (
    <>
      {actor} trakk tilbake lenken for nytt passord til {subject}.
    </>
  ),
  'password_link.use': ({ subject }) => (
    <>{subject} valgte nytt passord med en lenke og ble logget ut på alle enheter.</>
  ),
  'role.change': ({ actor, subject, details }) => (
    <>
      {actor} endret rollen til {subject} fra {role(details.from)} til {role(details.to)}.
    </>
  ),
  'operator.grant_role': ({ actor, subject, details }) =>
    granted(actor, subject, role(details.role), Boolean(details.approvedRequest)),
  // Fra før roller fantes; da var admin den eneste rollen som kunne gis.
  'operator.grant_admin': ({ actor, subject, details }) =>
    granted(actor, subject, 'admin', Boolean(details.approvedRequest)),
  'operator.import_profiles': ({ actor, details }) => {
    const source = text(details.source)
    const cohorts = count(details.cohortsCreated)
    return (
      <>
        {actor} importerte {source ? `«${source}»` : 'en kulliste'} fra kommandolinjen:{' '}
        {plural(count(details.created), 'ny profil', 'nye profiler')}, {count(details.existing)}{' '}
        fantes fra før
        {cohorts > 0 && `, ${plural(cohorts, 'nytt kull', 'nye kull')}`}.
        {details.membershipStatus === 'pending' && ' Nye profiler venter på godkjenning.'}
      </>
    )
  },
  'operator.import_dataset': ({ actor, details }) => {
    const source = text(details.source)
    const counts = (details.counts ?? {}) as Record<
      string,
      { created?: unknown; updated?: unknown }
    >
    const sum = (key: 'created' | 'updated') =>
      Object.values(counts).reduce((n, c) => n + count(c?.[key]), 0)
    const options = Array.isArray(details.options) ? details.options.map(String) : []
    return (
      <>
        {actor} importerte {source ? `datasettet «${source}»` : 'et datasett'} fra kommandolinjen:{' '}
        {count(counts.companies?.created)} nye og {count(counts.companies?.updated)} endrede
        selskaper, {plural(count(counts.people?.created), 'ny profil', 'nye profiler')} og{' '}
        {count(counts.articles?.created)} saker i media ({sum('created')} nye og {sum('updated')}{' '}
        endrede rader i alt{options.length > 0 && `, ${options.join(', ')}`}).
      </>
    )
  },
  'profile.admin_edit': ({ actor, subject }) => (
    <>
      {actor} redigerte profilen til {subject}.
    </>
  ),
  'profile.link': ({ actor, subject }) => (
    <>
      {actor} koblet en konto til profilen til {subject}.
    </>
  ),
  'company.admin_edit': ({ actor, details }) => (
    <>
      {actor} redigerte <Company details={details} />.
    </>
  ),
  'company.admin_logo_upload': ({ actor, details }) => (
    <>
      {actor} {details.replaced ? 'byttet' : 'la inn'} logoen til <Company details={details} />.
    </>
  ),
  'company.admin_logo_remove': ({ actor, details }) => (
    <>
      {actor} fjernet logoen til <Company details={details} />.
    </>
  ),
  'company.merge': ({ actor, details }) => {
    const from = (details.from ?? {}) as Entry['details']
    const into = (details.into ?? {}) as Entry['details']
    return (
      <>
        {actor} slo sammen «{text(from.name) ?? 'et selskap'}» med <Company details={into} />.
      </>
    )
  },
  'company.admin_event_add': ({ actor, details }) => (
    <>
      {actor} la til en hendelse i historikken til <Company details={details} />.
    </>
  ),
  'company.admin_event_edit': ({ actor, details }) => (
    <>
      {actor} rettet en hendelse i historikken til <Company details={details} />.
    </>
  ),
  'company.admin_event_remove': ({ actor, details }) => (
    <>
      {actor} slettet en hendelse i historikken til <Company details={details} />.
    </>
  ),
  'company.admin_article_add': ({ actor, details }) => (
    <>
      {actor} la til en sak under «I media» hos <Company details={details} />.
    </>
  ),
  'company.admin_article_edit': ({ actor, details }) => (
    <>
      {actor} rettet en sak under «I media» hos <Company details={details} />.
    </>
  ),
  'company.admin_article_remove': ({ actor, details }) => (
    <>
      {actor} fjernet en sak under «I media» hos <Company details={details} />.
    </>
  ),
  'company.create': ({ actor, details }) => (
    <>
      {actor} opprettet <Company details={details} />.
    </>
  ),
  'company.delete': ({ actor, details }) => {
    const unlinked = count(details.experience) + count(details.esTeam)
    return (
      <>
        {actor} slettet «{text(details.name) ?? 'et selskap'}»
        {unlinked > 0 && ` og fjernet det fra ${plural(unlinked, 'profil', 'profiler')}`}.
      </>
    )
  },
  'company.admin_clear_field': ({ actor, details }) => (
    <>
      {actor} fjernet et importert felt ({fieldName(details.field)}) fra{' '}
      <Company details={details} />.
    </>
  ),
  'company.admin_event_confirm': ({ actor, details }) => (
    <>
      {actor} bekreftet en usikker hendelse i historikken til <Company details={details} />.
    </>
  ),
  'company.admin_suggestion_accept': ({ actor, subject, details }) => (
    <>
      {actor} godtok et forslag fra {subject} til <Company details={details} />.
    </>
  ),
  'company.admin_suggestion_reject': ({ actor, subject, details }) => (
    <>
      {actor} avslo et forslag fra {subject} til <Company details={details} />.
    </>
  ),
  'company.admin_link_accept': ({ actor, subject, details }) => (
    <>
      {actor} bekreftet at {subject} var {linkRole(details.role)} i <Company details={details} />.
    </>
  ),
  'company.admin_link_reject': ({ actor, subject, details }) => (
    <>
      {actor} avslo at {subject} var {linkRole(details.role)} i <Company details={details} />.
    </>
  ),
  'quote.add': (parts) => (
    <>
      {parts.actor} la inn et sitat fra {speaker(parts)}.
    </>
  ),
  'quote.confirm': (parts) => (
    <>
      {parts.actor} bekreftet hvem som sa et sitat fra {speaker(parts)}.
    </>
  ),
  'source.review': ({ actor, subject, details }) => {
    const fields = Array.isArray(details.fields) ? details.fields.length : 0
    return (
      <>
        {actor} så over {plural(fields, 'importert felt', 'importerte felt')}{' '}
        {details.entityType === 'person' ? <>på profilen til {subject}</> : 'på et selskap'}.
      </>
    )
  },
  'profile.create': ({ actor, subject, details }) => (
    <>
      {actor} la inn profilen til {subject}
      {typeof details.via === 'string' && details.via.endsWith('import') && ' under en import'}
      {details.via === 'batch' && ' sammen med flere'}.
    </>
  ),
  'profile.batch_create': ({ actor, details }) => (
    <>
      {actor} la inn {plural(count(details.created), 'profil', 'profiler')} på én gang
      {Array.isArray(details.cohorts) && details.cohorts.length > 0 && (
        <> i {details.cohorts.map((y) => `ES ${String(y)}`).join(', ')}</>
      )}
      {count(details.withPhoto) > 0 && <>, {count(details.withPhoto)} med bilde</>}.
    </>
  ),
  'profile.delete': ({ actor, details }) => (
    <>
      {actor} slettet profilen til {text(details.fullName) ?? 'en person'}, som ingen hadde tatt i
      bruk.
    </>
  ),
  'profile.admin_contact_fill': ({ actor, subject, details }) => (
    <>
      {actor} fylte inn{' '}
      {Array.isArray(details.fields) && details.fields.length === 2
        ? 'e-post og telefon'
        : Array.isArray(details.fields) && details.fields[0] === 'phone'
          ? 'telefon'
          : 'e-post'}{' '}
      på profilen til {subject}, som ingen har tatt i bruk.
    </>
  ),
  'source.add': ({ actor, subject, details }) => {
    const fields = Array.isArray(details.fields) ? details.fields.map(fieldName) : []
    return (
      <>
        {actor} la inn kilde for {fields.length ? fields.join(', ') : 'felt'}{' '}
        {details.entityType === 'person' ? <>på profilen til {subject}</> : 'på et selskap'}
        {Array.isArray(details.labels) && details.labels.length > 0 && (
          <> ({details.labels.map(String).join(', ')})</>
        )}
        .
      </>
    )
  },
  'profile.search_topics': ({ actor, subject, details }) => (
    <>
      {actor} satte søkeordene til {subject}: {list(details.topics)}.
    </>
  ),
  'mcp_token.create': ({ actor, details }) => (
    <>
      {actor} laget MCP-nøkkelen «{text(details.name) ?? 'uten navn'}»
      {details.readOnly === true && ' (bare lesing)'}.
    </>
  ),
  'mcp_token.revoke': ({ actor, details }) => (
    <>
      {actor} trakk tilbake MCP-nøkkelen «{text(details.name) ?? 'uten navn'}».
    </>
  ),
  'mcp_oauth.connect': ({ actor, details }) => (
    <>
      {actor} koblet til MCP-klienten «{text(details.name) ?? 'uten navn'}»
      {details.readOnly === true && ' (bare lesing)'}.
    </>
  ),
  'mcp_oauth.disconnect': ({ actor, details }) => (
    <>
      {actor} koblet fra MCP-klienten «{text(details.name) ?? 'uten navn'}».
    </>
  ),
  'profile.admin_cohorts': ({ actor, subject, details }) => (
    <>
      {actor} endret kullene til {subject} fra {list(details.from)} til {list(details.to)}.
    </>
  ),
  'profile.admin_email_add': ({ actor, subject }) => (
    <>
      {actor} la til en kjent e-postadresse for {subject}.
    </>
  ),
  'profile.admin_email_remove': ({ actor, subject }) => (
    <>
      {actor} fjernet en kjent e-postadresse fra {subject}.
    </>
  ),
  'profile.admin_clear_field': ({ actor, subject, details }) => (
    <>
      {actor} fjernet et importert felt ({fieldName(details.field)}) fra profilen til {subject}.
    </>
  ),
  'person.merge': ({ actor, subject, details }) => {
    const from = (details.from ?? {}) as Entry['details']
    return (
      <>
        {actor} slo sammen «{text(from.fullName) ?? 'en person'}» med {subject}.
      </>
    )
  },
  'review.dismiss_duplicate': ({ actor, details }) => {
    const first = (details.first ?? {}) as Entry['details']
    const second = (details.second ?? {}) as Entry['details']
    return (
      <>
        {actor} sa at «{text(first.name)}» og «{text(second.name)}» ikke er{' '}
        {details.kind === 'person_duplicate' ? 'samme person' : 'samme selskap'}.
      </>
    )
  },
  'cohort.rep_add': ({ actor, subject, details }) => (
    <>
      {actor} satte {subject} som kullrepresentant for {cohortName(details)}
      {details.otherCohort === true && ', selv om personen går i et annet kull'}.
    </>
  ),
  'cohort.rep_edit': ({ actor, subject, details }) => (
    <>
      {actor} rettet vervet til {subject} som kullrepresentant for {cohortName(details)}.
    </>
  ),
  'cohort.rep_end': ({ actor, subject, details }) => (
    <>
      {actor} avsluttet vervet til {subject} som kullrepresentant for {cohortName(details)}
      {typeof details.endYear === 'number' && ` (${details.endYear})`}.
    </>
  ),
  'cohort.rep_remove': ({ actor, subject, details }) => (
    <>
      {actor} slettet vervet til {subject} som kullrepresentant for {cohortName(details)}.
    </>
  ),
  'board.add': ({ actor, subject, details }) => (
    <>
      {actor} satte {subject} inn i styret som {boardRoleInSentence(details.role)}
      {typeof details.startYear === 'number' && ` fra ${details.startYear}`}.
    </>
  ),
  'board.edit': ({ actor, subject }) => (
    <>
      {actor} rettet vervet til {subject} i styret.
    </>
  ),
  'board.role_change': ({ actor, subject, details }) => {
    const from = (details.from ?? {}) as Entry['details']
    const to = (details.to ?? {}) as Entry['details']
    return (
      <>
        {actor} endret rollen til {subject} i styret
        {from.role !== to.role &&
          ` fra ${boardRoleInSentence(from.role)} til ${boardRoleInSentence(to.role)}`}
        {typeof details.year === 'number' && ` (${details.year})`}.
      </>
    )
  },
  'board.end': ({ actor, subject, details }) => (
    <>
      {actor} avsluttet vervet til {subject} som {boardRoleInSentence(details.role)}
      {typeof details.endYear === 'number' && ` (${details.endYear})`}.
    </>
  ),
  'board.remove': ({ actor, subject, details }) => (
    <>
      {actor} slettet vervet til {subject} som {boardRoleInSentence(details.role)}.
    </>
  ),
  // Fra før ESAF-helgen ble et arrangement (migrering 0019).
  'weekend.create': ({ actor, details }) => (
    <>
      {actor} opprettet <EventLink details={details} />.
    </>
  ),
  'weekend.edit': ({ actor, details }) => (
    <>
      {actor} redigerte <EventLink details={details} />.
    </>
  ),
  'weekend.delete': ({ actor, details }) => {
    const attendees = count(details.attendees)
    return (
      <>
        {actor} slettet «{text(details.name) ?? 'en ESAF-helg'}»
        {attendees > 0 && ` med ${plural(attendees, 'deltaker', 'deltakere')}`}.
      </>
    )
  },
  'weekend.attendance_add': ({ actor, subject, details, entry }) => (
    <>
      {actor} la til{' '}
      {entry.subject
        ? subject
        : typeof details.cohort === 'number'
          ? `${plural(count(details.added), 'person', 'personer')} fra ES ${details.cohort}`
          : plural(count(details.added), 'deltaker', 'deltakere')}{' '}
      {details.source === 'import' && !entry.subject ? 'fra en liste ' : ''}på{' '}
      <EventLink details={details} />.
    </>
  ),
  'weekend.attendance_remove': ({ actor, subject, details }) => (
    <>
      {actor} fjernet {subject} fra <EventLink details={details} />.
    </>
  ),
  'email.pause': ({ actor, details }) => (
    <>
      {actor} satte all e-post fra appen på pause
      {text(details.reason) ? `: «${text(details.reason)}»` : ''}.
    </>
  ),
  'email.resume': ({ actor, details }) => (
    <>
      {actor} slo på e-post fra appen igjen
      {text(details.reason) ? `: «${text(details.reason)}»` : ''}.
    </>
  ),
  'email.kind_off': ({ actor, details }) => (
    <>
      {actor} slo av e-posten «{emailKindName(details.kind)}»
      {text(details.reason) ? `: «${text(details.reason)}»` : ''}.
    </>
  ),
  'email.kind_on': ({ actor, details }) => (
    <>
      {actor} slo på e-posten «{emailKindName(details.kind)}» igjen.
    </>
  ),
  'email.block': ({ actor, details }) => (
    <>
      {actor} stoppet all e-post til {text(details.email) ?? 'en adresse'}
      {text(details.reason) ? `: «${text(details.reason)}»` : ''}.
    </>
  ),
  'email.unblock': ({ actor, details }) => (
    <>
      {actor} sendte e-post til {text(details.email) ?? 'en adresse'} igjen.
    </>
  ),
  'badge.create': ({ actor, details }) => (
    <>
      {actor} lagde merket <BadgeLink details={details} />
      {details.status === 'published' ? ' og publiserte det' : ' som utkast'}.
    </>
  ),
  'badge.edit': ({ actor, details }) => (
    <>
      {actor} endret merket <BadgeLink details={details} />
      {Array.isArray(details.fields) && details.fields.includes('rule')
        ? ', også hvem som får det'
        : ''}
      .
    </>
  ),
  'badge.publish': ({ actor, details }) => (
    <>
      {actor} publiserte merket <BadgeLink details={details} />.
    </>
  ),
  'badge.archive': ({ actor, details }) => (
    <>
      {actor} arkiverte merket <BadgeLink details={details} />.
    </>
  ),
  'badge.delete': ({ actor, details }) => (
    <>
      {actor} slettet merket «{text(details.name) ?? 'ukjent'}»
      {count(details.holders) ? ` (${count(details.holders)} hadde det)` : ''}.
    </>
  ),
  'badge.award': ({ actor, subject, details }) => (
    <>
      {actor} ga {subject} merket <BadgeLink details={details} />
      {text(details.citation) ? `: «${text(details.citation)}»` : ''}.
    </>
  ),
  'badge.citation': ({ actor, subject, details }) => (
    <>
      {actor} endret begrunnelsen for merket <BadgeLink details={details} /> til {subject}
      {text(details.citation) ? `: «${text(details.citation)}»` : ''}.
    </>
  ),
  'badge.revoke': ({ actor, subject, details }) => (
    <>
      {actor} tok merket <BadgeLink details={details} /> fra {subject}.
    </>
  ),
  'event_type.create': ({ actor, details }) => (
    <>
      {actor} opprettet arrangementstypen <EventTypeLink details={details} />.
    </>
  ),
  'event_type.edit': ({ actor, details }) => (
    <>
      {actor} redigerte arrangementstypen <EventTypeLink details={details} />
      {text(details.previousName) && text(details.previousName) !== text(details.name)
        ? ` (het «${text(details.previousName)}»)`
        : ''}
      .
    </>
  ),
  'event_type.delete': ({ actor, details }) => (
    <>
      {actor} slettet arrangementstypen «{text(details.name) ?? 'ukjent'}».
    </>
  ),
  'event.create': ({ actor, details }) => (
    <>
      {actor} opprettet <EventLink details={details} />
      {details.via === 'import' && ' under en import'}
      {details.via === 'history' && ' med «Legg inn historikk»'}.
    </>
  ),
  'event.edit': ({ actor, details }) => (
    <>
      {actor} redigerte <EventLink details={details} />
      {text(details.previousType) &&
        ` og flyttet det fra ${text(details.previousType)} til ${text(details.typeName) ?? 'en annen type'}`}
      .
    </>
  ),
  'event.delete': ({ actor, details }) => {
    const participants = count(details.participants)
    return (
      <>
        {actor} slettet «{text(details.name) ?? 'et arrangement'}»
        {participants > 0 && ` med ${plural(participants, 'deltaker', 'deltakere')}`}.
      </>
    )
  },
  'event.participant_add': ({ actor, subject, details, entry }) => (
    <>
      {actor} la til{' '}
      {entry.subject
        ? subject
        : typeof details.cohort === 'number'
          ? `${plural(count(details.added), 'person', 'personer')} fra ES ${details.cohort}`
          : plural(count(details.added), 'deltaker', 'deltakere')}{' '}
      {details.source === 'import' && !entry.subject ? 'fra en liste ' : ''}
      {typeof details.role === 'string' && `som ${eventRole(details.role)} `}på{' '}
      <EventLink details={details} />.
    </>
  ),
  'event.participant_edit': ({ actor, subject, details }) => {
    const from = (details.from ?? {}) as Entry['details']
    const to = (details.to ?? {}) as Entry['details']
    const roleChanged = from.role !== to.role
    return (
      <>
        {actor} {roleChanged ? 'endret rollen til' : 'rettet notatet om'} {subject} på{' '}
        <EventLink details={details} />
        {roleChanged && ` fra ${eventRole(from.role)} til ${eventRole(to.role)}`}.
      </>
    )
  },
  'event.participant_remove': ({ actor, subject, details }) => (
    <>
      {actor} fjernet {subject} fra <EventLink details={details} />.
    </>
  ),
  'event.history': ({ actor, details }) => {
    const skipped = count(details.skipped)
    const from = count(details.fromYear)
    const to = count(details.toYear)
    return (
      <>
        {actor} la inn historikk for{' '}
        <EventTypeLink details={{ ...details, name: details.typeName ?? null }} />:{' '}
        {plural(count(details.created), 'arrangement', 'arrangementer')}
        {from > 0 && (from === to ? ` i ${from}` : ` fra ${from} til ${to}`)}
        {skipped > 0 && `, ${skipped} fantes fra før`}.
      </>
    )
  },
  'event.import': ({ actor, details }) => {
    const events = Array.isArray(details.events) ? (details.events as Entry['details'][]) : []
    const created = count(details.profilesCreated)
    const newEvents = count(details.eventsCreated)
    return (
      <>
        {actor} importerte deltakelse fra «{text(details.fileName) ?? 'et regneark'}»:{' '}
        {plural(count(details.added), 'ny deltakelse', 'nye deltakelser')}
        {count(details.updated) > 0 &&
          `, ${plural(count(details.updated), 'endret rolle', 'endrede roller')}`}
        {newEvents > 0 && `, ${plural(newEvents, 'nytt arrangement', 'nye arrangementer')}`}
        {created > 0 && `, ${plural(created, 'ny profil', 'nye profiler')}`}
        {events.length === 1 && (
          <>
            {' '}
            på <EventLink details={events[0]!} />
          </>
        )}
        .
      </>
    )
  },
  'cohort.rep_import': ({ actor, details }) => {
    const created = count(details.profilesCreated)
    return (
      <>
        {actor} importerte kullrepresentanter fra «{text(details.fileName) ?? 'et regneark'}»:{' '}
        {plural(count(details.added), 'nytt verv', 'nye verv')}
        {count(details.updated) > 0 && `, ${plural(count(details.updated), 'rettet', 'rettet')}`}
        {created > 0 && `, ${plural(created, 'ny profil', 'nye profiler')}`}.
      </>
    )
  },
  'quote.edit': (parts) => (
    <>
      {parts.actor} rettet et sitat fra {speaker(parts)}.
    </>
  ),
  'quote.remove': (parts) => (
    <>
      {parts.actor} slettet et sitat fra {speaker(parts)}.
    </>
  ),
  'content.remove_post': ({ actor, subject, details }) => {
    const title = text(details.title)
    return (
      <>
        {actor} fjernet {title ? `innlegget «${title}»` : 'et innlegg'} av {subject}.
      </>
    )
  },
  'content.remove_comment': ({ actor, subject, details }) => {
    const postId = text(details.postId)
    return (
      <>
        {actor} fjernet en kommentar av {subject}
        {postId && (
          <>
            {' '}
            på{' '}
            <Link
              to="/feed/$postId"
              params={{ postId }}
              className="font-medium text-stone-900 hover:text-brand-600"
            >
              et innlegg
            </Link>
          </>
        )}
        .
      </>
    )
  },
}

function granted(actor: ReactNode, subject: ReactNode, roleName: string, approved: boolean) {
  return approved ? (
    <>
      {actor} godkjente {subject} og ga rollen {roleName} fra kommandolinjen.
    </>
  ) : (
    <>
      {actor} ga {subject} rollen {roleName} fra kommandolinjen.
    </>
  )
}

function describe(entry: Entry): ReactNode {
  const parts: Parts = {
    // Uten utfører er det operatøren på kommandolinjen. Unntaket er forespørsler:
    // søkerens midlertidige person slettes når kontoen kobles til en profil.
    actor: entry.actor ? <Who person={entry.actor} /> : 'En operatør',
    subject: <Who person={entry.subject} />,
    details: entry.details,
    entry,
  }
  if (Object.hasOwn(sentences, entry.action)) return sentences[entry.action]!(parts)
  return (
    <>
      {parts.actor} gjorde «{entry.action}»
      {entry.subject && (
        <>
          {' '}
          for <Who person={entry.subject} />
        </>
      )}
      .
    </>
  )
}
