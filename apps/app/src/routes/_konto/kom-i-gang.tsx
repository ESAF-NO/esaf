import { createFileRoute, useRouter } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { z } from 'zod'
import { AuthCard } from '#/components/AuthLayout.tsx'
import { TagInput } from '#/components/TagInput.tsx'
import { Button, cx, ErrorText, Field, Input, Switch } from '#/components/ui.tsx'
import { completeOnboarding } from '#/lib/access.functions.ts'
import { fetchEditableProfile, saveProfile } from '#/lib/profiles.functions.ts'

export const Route = createFileRoute('/_konto/kom-i-gang')({
  validateSearch: z.object({ til: z.string().optional().catch(undefined) }),
  loader: ({ context }) =>
    fetchEditableProfile({ data: { personId: context.viewer.personId ?? '' } }),
  head: () => ({ meta: [{ title: 'Kom i gang – ESAF' }] }),
  component: GetStarted,
})

const expertiseSuggestions = [
  'Fundraising',
  'B2B-salg',
  'Go-to-market',
  'Produktledelse',
  'Rekruttering',
  'Styrearbeid',
  'Strategi',
  'Markedsføring',
  'Programvareutvikling',
  'Hardware',
]
const industrySuggestions = [
  'Energi',
  'Olje og gass',
  'Helse og medtech',
  'Finans',
  'IT og programvare',
  'Konsulent',
  'Venture capital',
  'Offentlig sektor',
]

const STEPS = 3

/**
 * Tre korte steg første gang et nytt medlem kommer inn: hva de jobber med, hva
 * de kan hjelpe med, og om kontaktinfo fra telefonlista skal vises. Alt kan
 * hoppes over og endres senere på profilen.
 */
function GetStarted() {
  const profile = Route.useLoaderData()
  const { til } = Route.useSearch()
  const router = useRouter()
  const current = profile.experience.find((e) => e.endYear === null)

  const [step, setStep] = useState(0)
  const [company, setCompany] = useState(current?.company ?? '')
  const [title, setTitle] = useState(current?.title ?? '')
  const [founder, setFounder] = useState(current?.founder ?? false)
  const [city, setCity] = useState(profile.city ?? '')
  const [expertise, setExpertise] = useState(profile.expertise)
  const [industries, setIndustries] = useState(profile.industries)
  const [contactEmail, setContactEmail] = useState(profile.contactEmail ?? '')
  const [emailVisible, setEmailVisible] = useState(profile.contactEmailVisible)
  const [phone, setPhone] = useState(profile.phone ?? '')
  const [phoneVisible, setPhoneVisible] = useState(profile.phoneVisible)
  const [linkedin, setLinkedin] = useState(profile.linkedinUrl ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function done() {
    await completeOnboarding()
    await router.invalidate()
    // Bare stier i appen, aldri en annen side.
    router.history.push(til?.startsWith('/') && !til.startsWith('//') ? til : '/feed')
  }

  async function finish() {
    setSaving(true)
    setError(null)
    try {
      const experience = profile.experience.map((e) => ({
        company: e.company,
        title: e.title ?? '',
        startYear: e.startYear,
        endYear: e.endYear,
        founder: e.founder,
      }))
      if (company.trim()) {
        const index = experience.findIndex((e) => e.endYear === null)
        const role = {
          company,
          title,
          startYear: index >= 0 ? experience[index]!.startYear : null,
          endYear: null,
          founder,
        }
        if (index >= 0) experience[index] = role
        else experience.unshift(role)
      }
      await saveProfile({
        data: {
          personId: profile.personId,
          values: {
            fullName: profile.fullName,
            city,
            studyBackground: profile.studyBackground ?? '',
            esCompany: profile.esCompany ?? '',
            bio: profile.bio ?? '',
            expertise,
            industries,
            experience,
            linkedinUrl: linkedin,
            contactEmail,
            contactEmailVisible: emailVisible,
            phone,
            phoneVisible,
          },
        },
      })
      await done()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke lagre.')
      setSaving(false)
    }
  }

  async function skip() {
    setSaving(true)
    await done()
  }

  const firstName = profile.fullName.split(' ')[0]
  const pages: { title: string; subtitle: string; body: ReactNode }[] = [
    {
      title: `Velkommen inn, ${firstName}!`,
      subtitle: 'Fortell kort hva du driver med nå, så finner de riktige folkene deg.',
      body: (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Selskap">
              <Input
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                maxLength={120}
                placeholder="Hvor jobber du?"
                autoFocus
              />
            </Field>
            <Field label="Stilling">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={120}
                placeholder="Daglig leder"
              />
            </Field>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-stone-700">
            <input
              type="checkbox"
              checked={founder}
              onChange={(e) => setFounder(e.target.checked)}
              className="size-4 accent-brand-600"
            />
            Jeg grunnla selskapet
          </label>
          <Field label="By">
            <Input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              maxLength={80}
              placeholder="Oslo"
            />
          </Field>
          <p className="text-xs text-stone-500">
            Tidligere jobber kan du legge til på profilen etterpå.
          </p>
        </div>
      ),
    },
    {
      title: 'Hva kan du hjelpe andre med?',
      subtitle:
        'ES-ere spør nettverket om råd og introduksjoner. Velg noen emner og bransjer du kan noe om.',
      body: (
        <div className="space-y-6">
          <TagInput
            label="Kan hjelpe med"
            value={expertise}
            onChange={setExpertise}
            suggestions={expertiseSuggestions}
            placeholder="Skriv et emne og trykk Enter"
          />
          <TagInput
            label="Bransjer du har jobbet i"
            value={industries}
            onChange={setIndustries}
            suggestions={industrySuggestions}
            placeholder="Skriv en bransje og trykk Enter"
          />
        </div>
      ),
    },
    {
      title: 'Hvordan kan andre ES-ere nå deg?',
      subtitle:
        'Står du i telefonlista, har vi fylt inn det du skrev der. Ingen ser det før du slår det på.',
      body: (
        <div className="space-y-4">
          <Field label="E-post">
            <Input
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
            />
          </Field>
          <Switch
            checked={emailVisible}
            onChange={setEmailVisible}
            label="Vis e-posten for andre medlemmer"
          />
          <Field label="Telefon">
            <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Switch
            checked={phoneVisible}
            onChange={setPhoneVisible}
            label="Vis telefonnummeret for andre medlemmer"
          />
          <Field label="LinkedIn">
            <Input
              value={linkedin}
              onChange={(e) => setLinkedin(e.target.value)}
              placeholder="https://www.linkedin.com/in/…"
            />
          </Field>
        </div>
      ),
    },
  ]
  const page = pages[step]!
  const last = step === STEPS - 1

  return (
    <>
      <div className="mb-6 grid grid-cols-3 gap-2" aria-hidden>
        {pages.map((p, i) => (
          <div
            key={p.title}
            className={cx('h-1 rounded-full', i <= step ? 'bg-brand-500' : 'bg-stone-200')}
          />
        ))}
      </div>
      <AuthCard
        eyebrow={`Steg ${step + 1} av ${STEPS}`}
        title={page.title}
        subtitle={page.subtitle}
      >
        {page.body}
        {error && (
          <div className="mt-4">
            <ErrorText>{error}</ErrorText>
          </div>
        )}
        <div className="mt-8 flex items-center gap-2">
          {step > 0 && (
            <Button variant="ghost" onClick={() => setStep(step - 1)} disabled={saving}>
              <ArrowLeft className="size-4" aria-hidden /> Tilbake
            </Button>
          )}
          <button
            type="button"
            onClick={skip}
            disabled={saving}
            className="ml-auto px-2 text-sm text-stone-500 hover:text-stone-900"
          >
            Hopp over
          </button>
          <Button
            variant="brand"
            onClick={last ? finish : () => setStep(step + 1)}
            disabled={saving}
          >
            {saving ? 'Lagrer …' : last ? 'Ferdig' : 'Neste'}
            {!saving && !last && <ArrowRight className="size-4" aria-hidden />}
          </Button>
        </div>
      </AuthCard>
    </>
  )
}
