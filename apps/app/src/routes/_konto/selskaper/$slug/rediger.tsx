import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router'
import { ArrowLeft, Check, GitMerge, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { CompanyForm, companyFormValues, Section } from '#/components/CompanyForm.tsx'
import { CompanyInput, type CompanyValue } from '#/components/CompanyInput.tsx'
import { LogoUpload } from '#/components/LogoUpload.tsx'
import { TagInput } from '#/components/TagInput.tsx'
import { Button, CompanyLogo, ErrorText } from '#/components/ui.tsx'
import {
  fetchEditableCompany,
  mergeCompany,
  saveCompany,
  saveFormerNames,
} from '#/lib/companies.functions.ts'

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

function EditCompany() {
  const company = Route.useLoaderData()
  const router = useRouter()

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

      {/* Utenfor skjemaet: logoen og tidligere navn lagres for seg, ikke med «Lagre endringer». */}
      <div className="mb-4">
        <Section title="Logo" description="Endringer i logoen lagres med en gang.">
          <LogoUpload companyId={company.id} name={company.name} logo={company.logo} />
        </Section>
      </div>
      <div className="mb-4">
        <FormerNames
          key={company.formerNames.join('\n')}
          companyId={company.id}
          name={company.name}
          initial={company.formerNames}
        />
      </div>

      <CompanyForm
        initial={companyFormValues(company)}
        submitLabel="Lagre endringer"
        onSubmit={async (values) => {
          const { slug } = await saveCompany({ data: { companyId: company.id, values } })
          await router.invalidate()
          await router.navigate({ to: '/selskaper/$slug', params: { slug } })
        }}
        cancel={
          <Link
            to="/selskaper/$slug"
            params={{ slug: company.slug }}
            className="inline-flex h-10 items-center px-3 text-sm text-stone-600 hover:text-stone-900"
          >
            Avbryt
          </Link>
        }
      />

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
  const [formerName, setFormerName] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [merging, setMerging] = useState(false)

  async function merge() {
    if (!duplicate.companyId) return
    const question = `Slå sammen «${duplicate.name}» med «${targetName}»? Alle som er knyttet til «${duplicate.name}», flyttes hit, og «${duplicate.name}» forsvinner${formerName ? `, men vises som et tidligere navn på ${targetName}` : ''}. Det kan ikke angres.`
    if (!confirm(question)) return
    setMerging(true)
    setError(null)
    try {
      const { slug } = await mergeCompany({
        data: { sourceId: duplicate.companyId, targetId, formerName },
      })
      await router.invalidate()
      await router.navigate({ to: '/selskaper/$slug', params: { slug } })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke slå sammen.')
      setMerging(false)
    }
  }

  return (
    <div id="sla-sammen" className="mt-8 scroll-mt-20">
      <Section
        title="Slå sammen duplikater"
        description="Finnes selskapet to ganger, med ulik skrivemåte eller fordi det har byttet navn? Velg den andre, så flyttes alle som er knyttet til den, hit. Info som mangler her, hentes derfra."
      >
        <CompanyInput
          label="Duplikat"
          value={duplicate}
          onChange={setDuplicate}
          allowNew={false}
          excludeId={targetId}
          placeholder="Søk etter den andre skrivemåten"
        />
        <label className="flex cursor-pointer items-start gap-2 text-sm text-stone-700">
          <input
            type="checkbox"
            checked={formerName}
            onChange={(e) => setFormerName(e.target.checked)}
            className="mt-0.5 size-4 rounded border-stone-300 accent-brand-600"
          />
          <span>
            {duplicate.companyId ? `«${duplicate.name}»` : 'Den andre'} er et tidligere navn på{' '}
            {targetName}, ikke bare en annen skrivemåte. Det vises som «Tidligere{' '}
            {duplicate.companyId ? duplicate.name : '…'}» på selskapssiden.
          </span>
        </label>
        {error && <ErrorText>{error}</ErrorText>}
        <Button variant="secondary" onClick={merge} disabled={!duplicate.companyId || merging}>
          <GitMerge className="size-4" aria-hidden />
          {merging ? 'Slår sammen …' : `Slå sammen med ${targetName}`}
        </Button>
      </Section>
    </div>
  )
}

/**
 * Navnene selskapet hadde før, som «Bølgepost» for Fjordtek. Lagres for seg, med en
 * gang. Et navn et annet selskap har, avvises: da bør de slås sammen.
 */
function FormerNames({
  companyId,
  name,
  initial,
}: {
  companyId: string
  name: string
  initial: string[]
}) {
  const router = useRouter()
  const [names, setNames] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = names.join('\n') !== initial.join('\n')

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const result = await saveFormerNames({ data: { companyId, names } })
      setNames(result.formerNames)
      setSaved(true)
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="Tidligere navn"
      description={`Har ${name} byttet navn? Vises som «Tidligere …» på selskapssiden, og søket finner selskapet på de gamle navnene. Nyeste først. Fylles ut av seg selv når navnet endres.`}
    >
      <TagInput
        label="Tidligere navn"
        value={names}
        onChange={(next) => {
          setNames(next)
          setSaved(false)
        }}
        placeholder="F.eks. det gamle navnet, og trykk Enter"
      />
      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex items-center gap-3">
        <Button variant="secondary" onClick={save} disabled={!changed || busy}>
          {busy ? 'Lagrer …' : 'Lagre tidligere navn'}
        </Button>
        {saved && !changed && (
          <span className="inline-flex items-center gap-1 text-sm text-emerald-700">
            <Check className="size-4" aria-hidden /> Lagret
          </span>
        )}
      </div>
    </Section>
  )
}
