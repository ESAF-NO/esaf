import type { AssetView } from '@esaf/core'

/**
 * Vedlegg fra nettleseren, mot `/api/vedlegg`. Grensene er de samme som i
 * @esaf/core (assets.ts og file-types.ts), så brukeren får svar med en gang,
 * men det er serveren som avgjør, ut fra innholdet i fila.
 */
export const ASSET_MAX_BYTES = 25 * 1024 * 1024
/** Høyst så mange vedlegg i ett innlegg eller én kommentar. */
export const MAX_ATTACHMENTS = 10

export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp'
export const DOCUMENT_ACCEPT =
  'application/pdf,.pdf,.docx,.xlsx,.pptx,.txt,.csv,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation'
export const ATTACHMENT_ACCEPT = `${IMAGE_ACCEPT},${DOCUMENT_ACCEPT}`

/** Hvor fila skal. Innlegg og kommentarer får den når de lagres. */
export type UploadTarget =
  { til: 'innlegg' | 'kommentar' } | { til: 'album' | 'arrangement' | 'selskap'; id: string }

const extension = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''

/** En melding for filer som åpenbart ikke kan brukes, ellers `null`. */
export function checkAssetFile(file: File, { imagesOnly = false } = {}): string | null {
  if (file.size === 0) return `${file.name} er tom.`
  if (file.size > ASSET_MAX_BYTES) return `${file.name} er for stor. Maks 25 MB.`
  const ext = extension(file.name)
  if (
    file.type === 'image/heic' ||
    file.type === 'image/heif' ||
    ext === 'heic' ||
    ext === 'heif'
  ) {
    return 'HEIC-bilder (fra iPhone) kan ikke lastes opp. Velg «Mest kompatibel» under Kamera → Formater, eller eksporter bildet som JPEG.'
  }
  const image = IMAGE_ACCEPT.split(',').includes(file.type)
  if (imagesOnly && file.type && !image)
    return `${file.name} er ikke et bilde i JPEG, PNG eller WebP.`
  if (['svg', 'html', 'htm', 'xml', 'zip', 'exe', 'js'].includes(ext)) {
    return `${file.name} kan ikke lastes opp. Bilder (JPEG, PNG, WebP) og dokumenter (PDF, Word, Excel, PowerPoint, tekst, CSV) går fint.`
  }
  return null
}

function failure(status: number, body: unknown) {
  if (status === 401) return new Error('Du er logget ut. Logg inn igjen og prøv på nytt.')
  const message =
    body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : status === 413
        ? 'Fila er for stor. Maks 25 MB.'
        : 'Noe gikk galt. Prøv igjen om litt.'
  return new Error(message)
}

/**
 * Laster opp én fil og gir den slik appen viser den. Med XMLHttpRequest, fordi
 * fetch ikke kan si hvor langt en opplasting har kommet. Typen er alltid
 * `application/octet-stream`: serveren bryr seg ikke om hva nettleseren tror.
 */
export function uploadAsset(
  target: UploadTarget,
  file: File,
  onProgress: (share: number) => void,
): Promise<AssetView> {
  const params = new URLSearchParams({ til: target.til, navn: file.name })
  if ('id' in target) params.set('id', target.id)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/vedlegg?${params}`)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.responseType = 'json'
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () =>
      xhr.status === 201
        ? resolve((xhr.response as { asset: AssetView }).asset)
        : reject(failure(xhr.status, xhr.response))
    xhr.onerror = () =>
      reject(new Error('Fikk ikke kontakt med serveren. Sjekk nettet og prøv igjen.'))
    xhr.send(file)
  })
}

/** «1,2 MB», «340 kB». */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / 1024 / 1024).toLocaleString('nb-NO', { maximumFractionDigits: 1 })} MB`
}

/** Typen som kort etikett, til filbrikkene. */
export const documentLabels = {
  pdf: 'PDF',
  docx: 'Word',
  xlsx: 'Excel',
  pptx: 'PowerPoint',
  txt: 'Tekst',
  csv: 'CSV',
} as const
