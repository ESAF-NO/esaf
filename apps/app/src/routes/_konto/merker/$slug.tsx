import type { BadgeDetails } from '@esaf/core'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { ArrowLeft, Eye, EyeOff, Pencil } from 'lucide-react'
import { useState } from 'react'
import { BadgeMedal, BadgeProgressBar } from '#/components/Badges.tsx'
import { Avatar, Button, buttonClass, Card, ErrorText, Verified } from '#/components/ui.tsx'
import { fetchBadge, hideOwnBadge } from '#/lib/badges.functions.ts'
import { kull, plural } from '#/lib/format.ts'

export const Route = createFileRoute('/_konto/merker/$slug')({
  loader: ({ params }) => fetchBadge({ data: { slug: params.slug } }),
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.name ?? 'Merke'} – ESAF` }] }),
  component: BadgePage,
  notFoundComponent: () => (
    <div className="mx-auto max-w-3xl">
      <BackLink />
      <Card className="p-6 text-sm text-stone-600">Fant ikke merket. Det kan være fjernet.</Card>
    </div>
  ),
})

function BackLink() {
  return (
    <Link
      to="/merker"
      className="mb-5 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900"
    >
      <ArrowLeft className="size-4" aria-hidden /> Merker
    </Link>
  )
}

/** Regler som handler om arrangementer: da hjelper det å fylle inn «Var du der?». */
const aboutEvents = (b: BadgeDetails) => b.kind.startsWith('event_')

function BadgePage() {
  const b = Route.useLoaderData()
  const { viewer } = Route.useRouteContext()
  const own = b.own
  return (
    <div className="mx-auto max-w-3xl">
      <BackLink />

      {b.status !== 'published' && (
        <p className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
          {b.status === 'draft'
            ? 'Utkast: bare admins ser merket, og ingen har fått det ennå.'
            : 'Arkivert: merket vises ikke for medlemmer.'}
        </p>
      )}

      <Card className="p-6 sm:p-8">
        <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:items-start sm:text-left">
          <BadgeMedal badge={b} earned={own?.earned ?? false} size="lg" />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight text-stone-950">{b.name}</h1>
            <p className="mt-1 text-[15px] text-stone-700">{b.description}</p>
            <p className="mt-2 text-sm text-stone-500">
              {b.manual
                ? 'Deles ut av styret.'
                : `Slik får du det: ${b.ruleText.charAt(0).toLocaleLowerCase('nb')}${b.ruleText.slice(1)}.`}{' '}
              {b.holders === 0
                ? 'Ingen har det ennå.'
                : `${plural(b.holders, 'medlem', 'medlemmer')} har det.`}
            </p>
            {viewer.permissions.includes('badges.manage') && (
              <Link
                to="/admin/merker"
                search={{ merke: b.id }}
                className={buttonClass({ variant: 'secondary', size: 'sm' }, 'mt-4')}
              >
                <Pencil className="size-3.5" aria-hidden /> Endre merket
              </Link>
            )}
          </div>
        </div>
        <OwnStatus badge={b} />
      </Card>

      <section aria-labelledby="har-merket" className="mt-8">
        <h2 id="har-merket" className="mb-3 text-sm font-semibold text-stone-950">
          Har merket
        </h2>
        {b.holderList.length ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {b.holderList.map((h) => (
              <li key={h.personId}>
                <Link
                  to="/medlemmer/$personId"
                  params={{ personId: h.personId }}
                  className="flex items-center gap-3 rounded-xl bg-white p-3 shadow-card ring-1 ring-stone-200/70 transition hover:ring-stone-300"
                >
                  <Avatar name={h.fullName} photo={h.photo} size="md" muted={!h.claimed} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1 text-sm font-medium text-stone-950">
                      <span className="truncate">{h.fullName}</span>
                      <Verified claimed={h.claimed} />
                    </p>
                    <p className="truncate text-xs text-stone-500">
                      {[
                        kull(h.cohortYears),
                        h.achievedOn ? `siden ${h.achievedOn.slice(0, 4)}` : null,
                        h.hidden ? 'skjult for andre' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    {h.citation && (
                      <p className="mt-0.5 text-xs text-stone-600 italic">«{h.citation}»</p>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-stone-500">Ingen har merket ennå. Bli den første!</p>
        )}
      </section>
    </div>
  )
}

/** Hvordan den innloggede står: har merket (og kan skjule det), eller hvor langt hen har kommet. */
function OwnStatus({ badge: b }: { badge: BadgeDetails }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const own = b.own
  if (!own) return null

  async function setHidden(hidden: boolean) {
    setBusy(true)
    setError(null)
    try {
      await hideOwnBadge({ data: { badgeId: b.id, hidden } })
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
    } finally {
      setBusy(false)
    }
  }

  if (own.earned) {
    return (
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-stone-100 pt-5">
        <p className="text-sm text-stone-700">
          <span className="font-medium text-stone-950">Du har dette merket</span>
          {own.achievedOn && ` siden ${own.achievedOn.slice(0, 4)}`}.
          {own.citation && (
            <span className="mt-1 block text-stone-600 italic">«{own.citation}»</span>
          )}
          {own.hidden && (
            <span className="mt-1 block text-stone-500">
              Skjult: andre ser det ikke på profilen din eller i lista.
            </span>
          )}
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setHidden(!own.hidden)}
          disabled={busy}
        >
          {own.hidden ? (
            <>
              <Eye className="size-4" aria-hidden /> Vis på profilen
            </>
          ) : (
            <>
              <EyeOff className="size-4" aria-hidden /> Skjul fra profilen
            </>
          )}
        </Button>
        {error && (
          <div className="w-full">
            <ErrorText>{error}</ErrorText>
          </div>
        )}
      </div>
    )
  }
  if (!own.progress) return null
  return (
    <div className="mt-6 border-t border-stone-100 pt-5">
      <p className="mb-2 text-sm font-medium text-stone-950">Så langt har du kommet</p>
      <BadgeProgressBar progress={own.progress} color={b.color} />
      {aboutEvents(b) && (
        <p className="mt-3 text-sm text-stone-600">
          Mangler noe?{' '}
          <Link to="/var-du-der" className="font-medium text-brand-700 hover:text-brand-800">
            Kryss av for arrangementene du var på
          </Link>
          .
        </p>
      )}
    </div>
  )
}
