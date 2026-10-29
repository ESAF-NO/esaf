import type { CompanyLogoUrls, ProfilePhoto } from '@esaf/core'

/**
 * Profilbilder og logoer fra nettleseren, mot `/api/medlemmer/$personId/bilde`
 * og `/api/selskaper/$companyId/logo`. Grensene er de samme som i @esaf/core
 * (images.ts), så brukeren får svar med en gang, men det er serveren som avgjør.
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

const photoEndpoint = (personId: string) => `/api/medlemmer/${encodeURIComponent(personId)}/bilde`
const logoEndpoint = (companyId: string) => `/api/selskaper/${encodeURIComponent(companyId)}/logo`

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
function upload(url: string, file: File, onProgress: (share: number) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream')
    xhr.responseType = 'json'
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () =>
      xhr.status === 200 ? resolve(xhr.response) : reject(failure(xhr.status, xhr.response))
    xhr.onerror = () =>
      reject(new Error('Fikk ikke kontakt med serveren. Sjekk nettet og prøv igjen.'))
    xhr.send(file)
  })
}

async function remove(url: string): Promise<void> {
  const response = await fetch(url, { method: 'DELETE' })
  if (!response.ok) throw failure(response.status, await response.json().catch(() => null))
}

export async function uploadPhoto(
  personId: string,
  file: File,
  onProgress: (share: number) => void,
): Promise<ProfilePhoto> {
  const body = await upload(photoEndpoint(personId), file, onProgress)
  return (body as { photo: ProfilePhoto }).photo
}

export const deletePhoto = (personId: string) => remove(photoEndpoint(personId))

export async function uploadLogo(
  companyId: string,
  file: File,
  onProgress: (share: number) => void,
): Promise<CompanyLogoUrls> {
  const body = await upload(logoEndpoint(companyId), file, onProgress)
  return (body as { logo: CompanyLogoUrls }).logo
}

export const deleteLogo = (companyId: string) => remove(logoEndpoint(companyId))
