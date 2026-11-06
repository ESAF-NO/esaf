import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router'
import { ArrowLeft, Info } from 'lucide-react'
import { CompanyForm, companyFormValues, Section } from '#/components/CompanyForm.tsx'
import { CompanyLogo, Field, Textarea } from '#/components/ui.tsx'
import { fetchCompany } from '#/lib/companies.functions.ts'
import { proposeCompanyInfo } from '#/lib/contributions.functions.ts'

/**
 * «Foreslå endring»: for medlemmer som ikke kan redigere selskapet. Bare feltene
 * som endres, sendes, og de som er knyttet til selskapet eller en admin godtar.
 */
export const Route = createFileRoute('/_konto/selskaper/$slug/foresla')({
  loader: async ({ params }) => {
    const company = await fetchCompany({ data: { slug: params.slug } })
    if ('movedTo' in company) {
      throw redirect({ to: '/selskaper/$slug/foresla', params: { slug: company.movedTo } })
    }
    // De som kan redigere, gjør det direkte.
    if (company.canEdit) {
      throw redirect({ to: '/selskaper/$slug/rediger', params: { slug: company.slug } })
    }
    return company
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `Foreslå endring i ${loaderData?.name ?? 'selskap'} – ESAF` }],
  }),
  component: SuggestChange,
})

function SuggestChange() {
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
            Foreslå endring i {company.name}
          </h1>
          <p className="text-sm text-stone-500">
            Gründerne, ES-teamet, de som jobber eller har jobbet der, eller en admin ser over
            forslaget.
          </p>
        </div>
      </div>

      <div className="mb-4 flex gap-3 rounded-2xl bg-stone-100 p-4 text-sm text-stone-700 ring-1 ring-stone-200 ring-inset">
        <Info className="mt-0.5 size-4 shrink-0 text-stone-500" aria-hidden />
        <p>
          Endre feltene som er feil eller mangler. Bare det du endrer, sendes, og du får varsel når
          forslaget er behandlet. Var du selv med i selskapet, kan du heller bruke «Jeg var med her»
          på selskapssiden og redigere direkte.
        </p>
      </div>

      <CompanyForm
        initial={companyFormValues(company)}
        submitLabel="Send forslag"
        savingLabel="Sender …"
        onSubmit={async (values, form) => {
          await proposeCompanyInfo({
            data: { companyId: company.id, values, note: String(form.get('note') ?? '') },
          })
          await router.invalidate()
          await router.navigate({
            to: '/selskaper/$slug',
            params: { slug: company.slug },
            hash: 'forslag',
          })
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
        extra={
          <Section title="Kommentar" description="Valgfritt. Hjelper dem som skal godta forslaget.">
            <Field label="Hvor har du det fra?">
              <Textarea
                name="note"
                rows={3}
                maxLength={500}
                placeholder="F.eks. en lenke til en nyhetssak, eller at du snakket med gründeren."
              />
            </Field>
          </Section>
        }
      />
    </div>
  )
}
