import type { CompanyLogoUrls, Experience } from '@esaf/core'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { ArrowLeft, BriefcaseBusiness, Lock, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { PhotoUpload } from '#/components/PhotoUpload.tsx'
import { CompanyInput, type CompanyValue } from '#/components/CompanyInput.tsx'
import { TagInput } from '#/components/TagInput.tsx'
import {
  Button,
  Card,
  CompanyLogo,
  cx,
  ErrorText,
  Field,
  Input,
  Textarea,
} from '#/components/ui.tsx'
import { industrySuggestions } from '#/lib/industries.ts'
import { fetchEditableProfile, saveProfile } from '#/lib/profiles.functions.ts'

export const Route = createFileRoute('/_konto/medlemmer/$personId/rediger')({
  loader: ({ params }) => fetchEditableProfile({ data: { personId: params.personId } }),
  head: () => ({ meta: [{ title: 'Rediger profil – ESAF' }] }),
  component: EditProfile,
})

const expertiseSuggestions = [
  'Fundraising',
  'B2B-salg',
  'Go-to-market',
  'Produktledelse',
  'Prising',
  'Rekruttering',
  'Styrearbeid',
  'Tidligfaseinvestering',
  'Markedsføring',
  'Forretningsutvikling',
  'Strategi',
  'Hardware',
  'Programvareutvikling',
  'Maskinlæring',
  'IP og patenter',
  'Juss for oppstart',
  'Økonomi og regnskap',
  'Ledelse',
  'Internasjonal ekspansjon',
  'Offentlige anbud',
]

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <Card className="grid gap-6 p-5 sm:p-6 md:grid-cols-[200px_minmax(0,1fr)]">
      <div>
        <h2 className="text-sm font-semibold text-stone-950">{title}</h2>
        {description && (
          <p className="mt-1 text-xs leading-relaxed text-stone-500">{description}</p>
        )}
      </div>
      <div className="min-w-0 space-y-4">{children}</div>
    </Card>
  )
}

function Toggle({
  name,
  defaultChecked,
  label,
}: {
  name: string
  defaultChecked: boolean
  label: string
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl bg-stone-50 px-3 py-2.5 ring-1 ring-stone-200 ring-inset">
      <span className="text-sm text-stone-700">{label}</span>
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="peer sr-only" />
      <span className="relative h-6 w-10 shrink-0 rounded-full bg-stone-300 transition peer-checked:bg-brand-600 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-2 after:absolute after:top-0.5 after:left-0.5 after:size-5 after:rounded-full after:bg-white after:shadow after:transition peer-checked:after:translate-x-4" />
    </label>
  )
}

/** Én rad i skjemaet. Årstall er tekst mens man skriver. */
type Role = {
  key: string
  company: string
  /** Selskapet som ble valgt i forslagslisten. */
  companyId: string | null
  /** Logoen til det valgte selskapet. */
  logo: CompanyLogoUrls | null
  title: string
  startYear: string
  endYear: string
  current: boolean
  founder: boolean
}

const toRole = (e: Experience): Role => ({
  key: e.id,
  company: e.company,
  companyId: e.companyId,
  logo: e.companyLogo,
  title: e.title ?? '',
  startYear: e.startYear ? String(e.startYear) : '',
  endYear: e.endYear ? String(e.endYear) : '',
  current: e.endYear === null,
  founder: e.founder,
})

const blankRole = (): Role => ({
  key: crypto.randomUUID(),
  company: '',
  companyId: null,
  logo: null,
  title: '',
  startYear: '',
  endYear: '',
  current: true,
  founder: false,
})

const thisYear = new Date().getFullYear()

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  children: ReactNode
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-stone-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 rounded border-stone-300 text-brand-600 accent-brand-600"
      />
      {children}
    </label>
  )
}

function RoleEditor({
  role,
  onChange,
  onRemove,
}: {
  role: Role
  onChange: (patch: Partial<Role>) => void
  onRemove: () => void
}) {
  return (
    <div className="rounded-xl bg-stone-50/70 p-4 ring-1 ring-stone-200 ring-inset">
      <div className="flex items-start gap-3">
        {role.company.trim() ? (
          <CompanyLogo
            name={role.company}
            logo={role.companyId ? role.logo : null}
            size="sm"
            className="mt-6 hidden sm:inline-grid"
          />
        ) : (
          <span className="mt-6 hidden size-9 shrink-0 place-items-center rounded-lg bg-white text-stone-400 ring-1 ring-stone-200 ring-inset sm:grid">
            <BriefcaseBusiness className="size-4" aria-hidden />
          </span>
        )}
        <div className="min-w-0 flex-1 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <CompanyInput
              label="Selskap"
              value={{ name: role.company, companyId: role.companyId }}
              onChange={({ name, companyId, logo }) =>
                onChange({ company: name, companyId, logo: logo ?? null })
              }
              placeholder="Equinor"
              autoFocus={!role.company && !role.title}
            />
            <Field label="Stilling">
              <Input
                value={role.title}
                onChange={(e) => onChange({ title: e.target.value })}
                maxLength={120}
                placeholder="Daglig leder"
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Fra" className="w-24">
              <Input
                value={role.startYear}
                onChange={(e) => onChange({ startYear: e.target.value.replace(/\D/g, '') })}
                inputMode="numeric"
                maxLength={4}
                placeholder="2019"
              />
            </Field>
            <Field label="Til" className="w-24">
              <Input
                value={role.current ? '' : role.endYear}
                onChange={(e) => onChange({ endYear: e.target.value.replace(/\D/g, '') })}
                inputMode="numeric"
                maxLength={4}
                placeholder={role.current ? 'nå' : String(thisYear)}
                disabled={role.current}
              />
            </Field>
            <div className="flex flex-wrap gap-x-4 gap-y-2 pb-2.5">
              <Check checked={role.current} onChange={(current) => onChange({ current })}>
                Jobber her nå
              </Check>
              <Check checked={role.founder} onChange={(founder) => onChange({ founder })}>
                Grunnla selskapet
              </Check>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="-mt-1 -mr-1 grid size-8 shrink-0 place-items-center rounded-lg text-stone-400 transition hover:bg-red-50 hover:text-red-600"
          aria-label={`Fjern ${role.company || 'erfaringen'}`}
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  )
}

/** Gjør skjemaradene om til det serveren tar imot. Tomme rader hoppes over. */
function toExperience(roles: Role[]) {
  const year = (v: string) => (v ? Number(v) : null)
  const filled = roles.filter((r) => r.company.trim() || r.title.trim())
  for (const r of filled) {
    const label = r.company.trim() || r.title.trim()
    if (!r.company.trim()) throw new Error(`Skriv inn selskapet for «${label}».`)
    if (!r.current && !r.endYear) {
      throw new Error(`Fyll inn når du sluttet i ${label}, eller kryss av for at du jobber der nå.`)
    }
    for (const y of [r.startYear, r.current ? '' : r.endYear]) {
      if (y && (Number(y) < 1950 || Number(y) > thisYear + 1)) {
        throw new Error(`«${y}» er ikke et gyldig årstall (${label}).`)
      }
    }
  }
  return filled.map((r) => ({
    companyId: r.companyId,
    company: r.company,
    title: r.title,
    startYear: year(r.startYear),
    endYear: r.current ? null : year(r.endYear),
    founder: r.founder,
  }))
}

function EditProfile() {
  const profile = Route.useLoaderData()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [roles, setRoles] = useState<Role[]>(() => profile.experience.map(toRole))
  const [expertise, setExpertise] = useState(profile.expertise)
  const [industries, setIndustries] = useState(profile.industries)
  const [esCompany, setEsCompany] = useState<CompanyValue>({
    name: profile.esCompany ?? '',
    companyId: profile.esCompanyId,
  })

  const patchRole = (key: string, patch: Partial<Role>) =>
    setRoles((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const text = (name: string) => String(form.get(name) ?? '')
    setSaving(true)
    setError(null)
    try {
      await saveProfile({
        data: {
          personId: profile.personId,
          values: {
            fullName: text('fullName'),
            city: text('city'),
            studyBackground: text('studyBackground'),
            esCompany: esCompany.name,
            esCompanyId: esCompany.companyId,
            bio: text('bio'),
            expertise,
            industries,
            experience: toExperience(roles),
            linkedinUrl: text('linkedinUrl'),
            contactEmail: text('contactEmail'),
            contactEmailVisible: form.get('contactEmailVisible') === 'on',
            phone: text('phone'),
            phoneVisible: form.get('phoneVisible') === 'on',
          },
        },
      })
      await router.invalidate()
      await router.navigate({ to: '/medlemmer/$personId', params: { personId: profile.personId } })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        to="/medlemmer/$personId"
        params={{ personId: profile.personId }}
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900"
      >
        <ArrowLeft className="size-4" aria-hidden /> Tilbake til profilen
      </Link>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-stone-950">
          {profile.isOwn ? 'Rediger profilen din' : `Rediger ${profile.fullName}`}
        </h1>
        <p className="text-sm text-stone-500">Synlig for godkjente ESAF-medlemmer.</p>
      </div>

      {!profile.isOwn && (
        <div className="mb-4 flex gap-3 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            Du redigerer som admin, og endringen logges. Kontaktinfo kan bare personen selv se og
            endre.
          </p>
        </div>
      )}

      {/* Utenfor skjemaet: bildet lagres med en gang, ikke med «Lagre endringer». */}
      <div className="mb-4">
        <Section title="Profilbilde" description="Endringer i bildet lagres med en gang.">
          <PhotoUpload
            personId={profile.personId}
            fullName={profile.fullName}
            photo={profile.photo}
            isOwn={profile.isOwn}
          />
        </Section>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <Section title="Om deg" description="Det andre ser først i katalogen og på profilen din.">
          <Field label="Fullt navn">
            <Input
              name="fullName"
              defaultValue={profile.fullName}
              required
              minLength={2}
              maxLength={120}
            />
          </Field>
          <Field label="By">
            <Input
              name="city"
              defaultValue={profile.city ?? ''}
              maxLength={80}
              placeholder="Oslo"
            />
          </Field>
          <Field label="Kort om deg">
            <Textarea
              name="bio"
              defaultValue={profile.bio ?? ''}
              rows={4}
              maxLength={1000}
              placeholder="Hva jobber du med nå, og hva brenner du for?"
            />
          </Field>
        </Section>

        <Section
          title="Erfaring"
          description="Selskaper du har startet eller jobbet i, nå og tidligere. Den nyeste du jobber i nå, vises under navnet ditt."
        >
          {roles.length === 0 && (
            <p className="rounded-xl border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-500">
              Ingen erfaring lagt inn ennå.
            </p>
          )}
          {roles.map((role) => (
            <RoleEditor
              key={role.key}
              role={role}
              onChange={(patch) => patchRole(role.key, patch)}
              onRemove={() => setRoles((list) => list.filter((r) => r.key !== role.key))}
            />
          ))}
          <Button
            variant="secondary"
            onClick={() => setRoles((list) => [blankRole(), ...list])}
            disabled={roles.length >= 30}
            className={cx(roles.length === 0 && 'w-full')}
          >
            <Plus className="size-4" aria-hidden /> Legg til erfaring
          </Button>
        </Section>

        <Section
          title="Kan hjelpe med"
          description="Emner andre kan spørre deg om. Gjør deg søkbar for dem som trenger råd."
        >
          <TagInput
            label="Emner"
            value={expertise}
            onChange={setExpertise}
            suggestions={expertiseSuggestions}
            placeholder="Skriv et emne og trykk Enter"
          />
        </Section>

        <Section title="Bransjer" description="Bransjer du har jobbet i, nå eller tidligere.">
          <TagInput
            label="Bransjer"
            value={industries}
            onChange={setIndustries}
            suggestions={industrySuggestions}
            placeholder="Skriv en bransje og trykk Enter"
          />
        </Section>

        <Section title="Bakgrunn">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Studieretning før ES">
              <Input
                name="studyBackground"
                defaultValue={profile.studyBackground ?? ''}
                maxLength={120}
              />
            </Field>
            <CompanyInput
              label="Selskap på Entreprenørskolen"
              value={esCompany}
              onChange={setEsCompany}
            />
          </div>
          <Field label="LinkedIn">
            <Input
              name="linkedinUrl"
              defaultValue={profile.linkedinUrl ?? ''}
              placeholder="https://www.linkedin.com/in/…"
            />
          </Field>
        </Section>

        {profile.isOwn ? (
          <Section
            title="Kontakt"
            description="Vises bare for godkjente medlemmer, og bare det du slår på. Kom du fra telefonlista, er nummeret og e-posten derfra fylt inn, men skjult."
          >
            <Field label="E-post for kontakt">
              <Input name="contactEmail" type="email" defaultValue={profile.contactEmail ?? ''} />
            </Field>
            <Toggle
              name="contactEmailVisible"
              defaultChecked={profile.contactEmailVisible}
              label="Vis e-posten for andre medlemmer"
            />
            <Field label="Telefon">
              <Input name="phone" type="tel" defaultValue={profile.phone ?? ''} />
            </Field>
            <Toggle
              name="phoneVisible"
              defaultChecked={profile.phoneVisible}
              label="Vis telefonnummeret for andre medlemmer"
            />
          </Section>
        ) : (
          <Card className="flex items-center gap-3 p-5 text-sm text-stone-500">
            <Lock className="size-4" aria-hidden /> Kontaktinfo kan bare personen selv se og endre.
            <input type="hidden" name="contactEmail" value="" />
            <input type="hidden" name="phone" value="" />
          </Card>
        )}

        {error && <ErrorText>{error}</ErrorText>}
        <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-stone-200 bg-stone-50/90 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:border sm:px-4">
          <Link
            to="/medlemmer/$personId"
            params={{ personId: profile.personId }}
            className="inline-flex h-10 items-center px-3 text-sm text-stone-600 hover:text-stone-900"
          >
            Avbryt
          </Link>
          <Button type="submit" variant="brand" disabled={saving}>
            {saving ? 'Lagrer …' : 'Lagre endringer'}
          </Button>
        </div>
      </form>
    </div>
  )
}
