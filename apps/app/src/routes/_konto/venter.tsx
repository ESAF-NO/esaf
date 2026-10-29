import { createFileRoute, Link } from '@tanstack/react-router'
import { BadgeCheck, Clock, MailCheck, UserX } from 'lucide-react'
import { AccessSteps, AuthCard } from '#/components/AuthLayout.tsx'
import { Avatar } from '#/components/ui.tsx'
import { fetchAccessState } from '#/lib/access.functions.ts'
import { esPeriod } from '#/lib/format.ts'

export const Route = createFileRoute('/_konto/venter')({
  loader: () => fetchAccessState(),
  head: () => ({ meta: [{ title: 'Venter på godkjenning – ESAF' }] }),
  component: Waiting,
})

function Waiting() {
  const { request, email } = Route.useLoaderData()

  if (request?.status === 'rejected') {
    return (
      <AuthCard
        title="Vi fikk ikke bekreftet hvem du er"
        subtitle="Styret har ikke godkjent forespørselen. Mener du dette er feil, ta kontakt med ESAF-styret, så ser vi på det igjen."
      >
        <div className="flex items-center gap-3 rounded-2xl bg-stone-50 p-4 text-sm text-stone-600 ring-1 ring-stone-200/70 ring-inset">
          <UserX className="size-5 shrink-0 text-stone-400" aria-hidden />
          Kontoen er knyttet til {email}.
        </div>
      </AuthCard>
    )
  }

  const firstName = request?.fullName.split(' ')[0]
  return (
    <>
      <AccessSteps current={3} className="mb-6" />
      <AuthCard
        eyebrow="Forespørselen er sendt"
        title={firstName ? `Takk, ${firstName}!` : 'Takk!'}
        subtitle="En i ESAF-styret sjekker at du er den du sier, og slipper deg inn. Du kan lukke siden og logge inn igjen senere."
      >
        {request && (
          <div className="divide-y divide-stone-100 rounded-2xl ring-1 ring-stone-200/70">
            <div className="flex items-center gap-3.5 p-4">
              <Avatar name={request.fullName} size="md" muted />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-stone-950">{request.fullName}</p>
                <p className="text-sm text-stone-500">
                  {request.graduationYear
                    ? `ES ${request.graduationYear} (${esPeriod(request.graduationYear)})`
                    : 'Kull ikke oppgitt'}
                </p>
              </div>
              <Link to="/velkommen" className="text-sm font-medium text-brand-600 hover:underline">
                Endre
              </Link>
            </div>
            <ul className="space-y-2.5 p-4 text-sm text-stone-600">
              <li className="flex items-center gap-2.5">
                <MailCheck className="size-4 shrink-0 text-brand-600" aria-hidden />
                Bekreftet e-post: {email}
              </li>
              {request.profile && (
                <li className="flex items-center gap-2.5">
                  <BadgeCheck className="size-4 shrink-0 text-brand-600" aria-hidden />
                  Adressen står i kullisten på profilen din
                </li>
              )}
              <li className="flex items-center gap-2.5">
                <Clock className="size-4 shrink-0 text-stone-400" aria-hidden />
                Venter på godkjenning fra styret
              </li>
            </ul>
          </div>
        )}
      </AuthCard>
    </>
  )
}
