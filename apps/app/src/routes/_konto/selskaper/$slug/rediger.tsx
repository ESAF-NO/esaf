import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router'
import { ArrowLeft, GitMerge, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { CompanyForm, companyFormValues, Section } from '#/components/CompanyForm.tsx'
import { CompanyInput, type CompanyValue } from '#/components/CompanyInput.tsx'
import { LogoUpload } from '#/components/LogoUpload.tsx'
import { Button, CompanyLogo, ErrorText } from '#/components/ui.tsx'
import { fetchEditableCompany, mergeCompany, saveCompany } from '#/lib/companies.functions.ts'

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

      {/* Utenfor skjemaet: logoen lagres med en gang, ikke med «Lagre endringer». */}
      <div className="mb-4">
        <Section title="Logo" description="Endringer i logoen lagres med en gang.">
          <LogoUpload companyId={company.id} name={company.name} logo={company.logo} />
        </Section>
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
    <div id="sla-sammen" className="mt-8 scroll-mt-20">
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
