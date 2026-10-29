/** Stegene i en import: les og match, vis hva som blir lagret, og lagre. */
export type ImportStep = 'forhandsvis' | 'prov' | 'lagre'

/** Største fil som tas imot; serveren sjekker det samme. */
export const IMPORT_MAX_MB = 5

/**
 * Sender regnearket og valgene til import-API-et. Fila sendes på hvert steg og
 * lagres aldri på serveren. Feil fra serveren kastes med meldingen derfra.
 */
export async function postImport<T>(
  url: '/api/import/deltakelse' | '/api/import/kullrepresentanter',
  file: File,
  steg: ImportStep,
  valg?: unknown,
  beslutninger?: unknown,
): Promise<T> {
  const form = new FormData()
  form.set('fil', file, file.name)
  form.set('steg', steg)
  if (valg !== undefined) form.set('valg', JSON.stringify(valg))
  if (beslutninger !== undefined) form.set('beslutninger', JSON.stringify(beslutninger))
  let response: Response
  try {
    response = await fetch(url, { method: 'POST', body: form, credentials: 'same-origin' })
  } catch {
    throw new Error('Fikk ikke kontakt med serveren. Sjekk nettet og prøv igjen.')
  }
  if (response.status === 401) {
    window.location.assign('/logg-inn')
    throw new Error('Du må logge inn på nytt.')
  }
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  if (!response.ok) {
    throw new Error(
      body?.error ??
        (response.status === 403
          ? 'Du må være sterkt innlogget (passkey eller tofaktor) for å importere.'
          : 'Noe gikk galt. Prøv igjen om litt.'),
    )
  }
  return body as T
}
