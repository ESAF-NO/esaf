import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router'
import { ArrowLeft, GitMerge, ShieldAlert } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { CompanyInput, type CompanyValue } from '#/components/CompanyInput.tsx'
import { LogoUpload } from '#/components/LogoUpload.tsx'
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
import { statusLabels, statusOrder, type CompanyStatus } from '#/lib/companies.ts'
import { fetchEditableCompany, mergeCompany, saveCompany } from '#/lib/companies.functions.ts'
import { industrySuggestions } from '#/lib/industries.ts'

export const Route = createFileRoute('/_konto/selskaper/$slug/rediger')({
  loader: async ({ params }) => {
    const company = await fetchEditableCompany({ data: { slug: params.slug } })
    if ('movedTo' in company) {
      throw redirect({ to: '/selskaper/$slug/rediger', params: { slug: company.movedTo } })
    }
    return company
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `Rediger ${loaderData?.name ?? 'selskap'} – ESAF` }],
  }),
  component: EditCompany,
})

const thisYear = new Date().getFullYear()

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

function EditCompany() {
  const company = Route.useLoaderData()
  const router = useRouter()
  const [industries, setIndustries] = useState(company.industries)
  const [status, setStatus] = useState<CompanyStatus>(company.status)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const text = (name: string) => String(form.get(name) ?? '')
    const founded = text('foundedYear').trim()
    setSaving(true)
    setError(null)
    try {
      if (founded && (Number(founded) < 1800 || Number(founded) > thisYear + 1)) {
        throw new Error(`«${founded}» er ikke et gyldig årstall.`)
      }
      const { slug } = await saveCompany({
        data: {
          companyId: company.id,
          values: {
            name: text('name'),
            tagline: text('tagline'),
            description: text('description'),
            website: text('website'),
            foundedYear: founded ? Number(founded) : null,
            location: text('location'),
            industries,
            status,
          },
        },
      })
      await router.invalidate()
      await router.navigate({ to: '/selskaper/$slug', params: { slug } })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        to="/selskaper/$slug"
        params={{ slug: company.slug }}
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900"
      >
        <ArrowLeft className="size-4" aria-hidden /> Tilbake til selskapet
      </Link>
      <div className="mb-6 flex items-center gap-4">
        <CompanyLogo name={company.name} logo={company.logo} size="lg" />
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-stone-950">
            Rediger {company.name}
          </h1>
          <p className="text-sm text-stone-500">Synlig for godkjente ESAF-medlemmer.</p>
        </div>
      </div>

      {company.adminEdit && (
        <div className="mb-4 flex gap-3 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>Du redigerer som admin, og endringen logges.</p>
        </div>
      )}

      {/* Utenfor skjemaet: logoen lagres med en gang, ikke med «Lagre endringer». */}
      <div className="mb-4">
        <Section title="Logo" description="Endringer i logoen lagres med en gang.">
          <LogoUpload companyId={company.id} name={company.name} logo={company.logo} />
        </Section>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <Section title="Om selskapet" description="Det andre ser først på selskapssiden.">
          <Field
            label="Navn"
            hint="Et nytt navn gir ny adresse til siden. Gamle lenker sendes videre."
          >
            <Input name="name" defaultValue={company.name} required maxLength={120} />
          </Field>
          <Field label="Kort beskrivelse" hint="Én linje om hva selskapet gjør.">
            <Input
              name="tagline"
              defaultValue={company.tagline ?? ''}
              maxLength={140}
              placeholder="Sanntids vannkvalitet for oppdrettere"
            />
          </Field>
          <Field label="Om selskapet">
            <Textarea
              name="description"
              defaultValue={company.description ?? ''}
              rows={6}
              maxLength={3000}
              placeholder="Hva lager dere, for hvem, og hvor langt har dere kommet?"
            />
          </Field>
        </Section>

        <Section title="Fakta">
          <Field label="Nettside">
            <Input
              name="website"
              defaultValue={company.website ?? ''}
              inputMode="url"
              maxLength={300}
              placeholder="syrlig.no"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <Field label="Grunnlagt">
              <Input
                name="foundedYear"
                defaultValue={company.foundedYear ?? ''}
                inputMode="numeric"
                pattern="[0-9]{4}"
                maxLength={4}
                placeholder={String(thisYear)}
              />
            </Field>
            <Field label="Sted">
              <Input
                name="location"
                defaultValue={company.location ?? ''}
                maxLength={80}
                placeholder="Trondheim"
              />
            </Field>
          </div>
          <fieldset>
            <legend className="text-sm font-medium text-stone-800">Status</legend>
            <div className="mt-1.5 inline-flex flex-wrap rounded-xl bg-stone-200/60 p-1">
              {statusOrder.map((s) => (
                <label
                  key={s}
                  className={cx(
                    'inline-flex h-8 cursor-pointer items-center rounded-lg px-3 text-sm font-medium transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500',
                    status === s
                      ? 'bg-white text-stone-950 shadow-card'
                      : 'text-stone-600 hover:text-stone-900',
                  )}
                >
                  <input
                    type="radio"
                    name="status"
                    value={s}
                    checked={status === s}
                    onChange={() => setStatus(s)}
                    className="sr-only"
                  />
                  {statusLabels[s]}
                </label>
              ))}
            </div>
          </fieldset>
        </Section>

        <Section title="Bransjer" description="Gjør selskapet lett å finne i oversikten.">
          <TagInput
            label="Bransjer"
            value={industries}
            onChange={setIndustries}
            suggestions={industrySuggestions}
            placeholder="Skriv en bransje og trykk Enter"
          />
        </Section>

        {error && <ErrorText>{error}</ErrorText>}
        <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-stone-200 bg-stone-50/90 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:border sm:px-4">
          <Link
            to="/selskaper/$slug"
            params={{ slug: company.slug }}
            className="inline-flex h-10 items-center px-3 text-sm text-stone-600 hover:text-stone-900"
          >
            Avbryt
          </Link>
          <Button type="submit" variant="brand" disabled={saving}>
            {saving ? 'Lagrer …' : 'Lagre endringer'}
          </Button>
        </div>
      </form>

      {company.canMerge && <Merge targetId={company.id} targetName={company.name} />}
    </div>
  )
}

/**
 * Samme selskap skrevet på to måter blir to selskaper. Admin kan slå dem sammen:
 * alle som er knyttet til duplikatet, flyttes hit, og den gamle adressen sendes videre.
 */
function Merge({ targetId, targetName }: { targetId: string; targetName: string }) {
  const router = useRouter()
  const [duplicate, setDuplicate] = useState<CompanyValue>({ name: '', companyId: null })
  const [error, setError] = useState<string | null>(null)
  const [merging, setMerging] = useState(false)

  async function merge() {
    if (!duplicate.companyId) return
    const question = `Slå sammen «${duplicate.name}» med «${targetName}»? Alle som er knyttet til «${duplicate.name}», flyttes hit, og «${duplicate.name}» forsvinner. Det kan ikke angres.`
    if (!confirm(question)) return
    setMerging(true)
    setError(null)
    try {
      const { slug } = await mergeCompany({
        data: { sourceId: duplicate.companyId, targetId },
      })
      await router.invalidate()
      await router.navigate({ to: '/selskaper/$slug', params: { slug } })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke slå sammen.')
      setMerging(false)
    }
  }

  return (
    <div className="mt-8">
      <Section
        title="Slå sammen duplikater"
        description="Finnes selskapet to ganger med ulik skrivemåte? Velg den andre, så flyttes alle som er knyttet til den, hit. Info som mangler her, hentes derfra."
      >
        <CompanyInput
          label="Duplikat"
          value={duplicate}
          onChange={setDuplicate}
          allowNew={false}
          excludeId={targetId}
          placeholder="Søk etter den andre skrivemåten"
        />
        {error && <ErrorText>{error}</ErrorText>}
        <Button variant="secondary" onClick={merge} disabled={!duplicate.companyId || merging}>
          <GitMerge className="size-4" aria-hidden />
          {merging ? 'Slår sammen …' : `Slå sammen med ${targetName}`}
        </Button>
      </Section>
    </div>
  )
}
