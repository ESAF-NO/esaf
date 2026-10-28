import type { ProfilePhoto } from '@esaf/core'

/**
 * Profilbilder fra nettleseren, mot `/api/medlemmer/$personId/bilde`. Grensene
 * er de samme som i @esaf/core (photos.ts), så brukeren får svar med en gang,
 * men det er serveren som avgjør.
 */
const MAX_BYTES = 10 * 1024 * 1024
export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp'

/** En melding for filer som åpenbart ikke kan brukes, ellers `null`. */
export function checkPhotoFile(file: File): string | null {
  if (file.size > MAX_BYTES) return 'Bildet er for stort. Maks 10 MB.'
  // Tom type betyr at nettleseren ikke vet. Da avgjør serveren ut fra innholdet.
  if (file.type && !PHOTO_ACCEPT.split(',').includes(file.type)) {
    return 'Bildet må være JPEG, PNG eller WebP.'
  }
  return null
}

const endpoint = (personId: string) => `/api/medlemmer/${encodeURIComponent(personId)}/bilde`

function failure(status: number, body: unknown) {
  if (status === 401) return new Error('Du er logget ut. Logg inn igjen og prøv på nytt.')
  const message =
    body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : status === 413
        ? 'Bildet er for stort. Maks 10 MB.'
        : 'Noe gikk galt. Prøv igjen om litt.'
  return new Error(message)
}

/** Med XMLHttpRequest, fordi fetch ikke kan si hvor langt en opplasting har kommet. */
export function uploadPhoto(
  personId: string,
  file: File,
  onProgress: (share: number) => void,
): Promise<ProfilePhoto> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', endpoint(personId))
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream')
    xhr.responseType = 'json'
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () =>
      xhr.status === 200
        ? resolve((xhr.response as { photo: ProfilePhoto }).photo)
        : reject(failure(xhr.status, xhr.response))
    xhr.onerror = () =>
      reject(new Error('Fikk ikke kontakt med serveren. Sjekk nettet og prøv igjen.'))
    xhr.send(file)
  })
}

export async function deletePhoto(personId: string): Promise<void> {
  const response = await fetch(endpoint(personId), { method: 'DELETE' })
  if (!response.ok) throw failure(response.status, await response.json().catch(() => null))
}
