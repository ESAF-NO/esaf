import { inflateRawSync } from 'node:zlib'
import { DomainError } from './errors.ts'
import { sniffImageFormat, type ImageFormat } from './images.ts'

/**
 * Hvilke filer som kan lastes opp som vedlegg, avgjort ut fra innholdet. Filnavnet
 * og typen nettleseren oppgir, brukes aldri til å bestemme hva fila er; filnavnet
 * får i stedet filendelsen som passer innholdet. Reglene:
 *
 * - Bilder: JPEG, PNG, WebP og GIF (behandles videre i `assets.ts`). HEIC fra iPhone
 *   kan ikke leses av bildebiblioteket på serveren og avvises med en forklaring.
 * - Dokumenter: PDF; Word, Excel og PowerPoint i de nye formatene (.docx, .xlsx,
 *   .pptx), der zip-strukturen sjekkes og makroer avvises; og ren tekst (.txt,
 *   .csv) i UTF-8, UTF-16 med BOM eller Windows-1252.
 * - Alt annet avvises: SVG, HTML og XML, programfiler, arkiver (zip som ikke er
 *   et Office-dokument, rar, 7z, gz), gamle Office-filer og ukjente formater.
 */

export type DocumentType = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'txt' | 'csv'

export type SniffedFile =
  | { kind: 'image'; format: ImageFormat }
  | { kind: 'document'; type: DocumentType; contentType: string; extension: string }

/** Typene dokumentene serveres med. Tekst får tegnsettet i tillegg. */
export const DOCUMENT_CONTENT_TYPES: Record<DocumentType, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
}

/** Hva slags dokument en type er, ut fra typen det serveres med (til ikoner og etiketter). */
export function documentTypeOf(contentType: string): DocumentType | null {
  const base = contentType.split(';')[0]!.trim()
  const found = Object.entries(DOCUMENT_CONTENT_TYPES).find(([, type]) => type === base)
  return found ? (found[0] as DocumentType) : null
}

export const unsupportedFile = () =>
  new DomainError(
    'Filtypen støttes ikke. Last opp bilder (JPEG, PNG, WebP eller GIF) eller dokumenter (PDF, Word, Excel, PowerPoint, tekst eller CSV).',
  )

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, Math.min(to, bytes.byteLength)))

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  signature.every((b, i) => bytes[offset + i] === b)

/**
 * Filendelsen i et filnavn, med små bokstaver, uten punktum. Bare tall (som i
 * «Referat 12.10.2024») regnes ikke som filendelse.
 */
export function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]{0,9}[A-Za-z][A-Za-z0-9]{0,9})$/.exec(name.trim())
  return match && match[1]!.length <= 10 ? match[1]!.toLowerCase() : ''
}

// ---------------------------------------------------------------------------
// Zip og Office (OOXML)
// ---------------------------------------------------------------------------

type ZipEntry = {
  name: string
  flags: number
  method: number
  compressedSize: number
  localOffset: number
}

/** Høyst så mange filer i et Office-dokument. Ekte dokumenter har noen titalls til noen hundre. */
const MAX_ZIP_ENTRIES = 10_000

/**
 * Innholdsfortegnelsen i en zip-fil (den sentrale katalogen), uten å pakke ut
 * noe. `null` hvis fila ikke er en gyldig zip som vi kan lese.
 */
function readZipDirectory(bytes: Uint8Array): ZipEntry[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // «End of central directory» ligger sist, etter en valgfri kommentar på høyst 64 KB.
  const min = Math.max(0, bytes.byteLength - 22 - 0xffff)
  let end = -1
  for (let i = bytes.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) return null
  const count = view.getUint16(end + 10, true)
  const size = view.getUint32(end + 12, true)
  const offset = view.getUint32(end + 16, true)
  // Zip64 (verdiene er fylt med 0xFF) trengs ikke for filer på noen MB.
  if (count === 0xffff || offset === 0xffffffff || count > MAX_ZIP_ENTRIES) return null
  if (offset + size > end) return null

  const entries: ZipEntry[] = []
  let p = offset
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || view.getUint32(p, true) !== 0x02014b50) return null
    const nameLength = view.getUint16(p + 28, true)
    const extraLength = view.getUint16(p + 30, true)
    const commentLength = view.getUint16(p + 32, true)
    if (p + 46 + nameLength > end) return null
    entries.push({
      flags: view.getUint16(p + 8, true),
      method: view.getUint16(p + 10, true),
      compressedSize: view.getUint32(p + 20, true),
      localOffset: view.getUint32(p + 42, true),
      name: new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength)),
    })
    p += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Innholdet i én fil i zip-arkivet, høyst `maxBytes` utpakket. */
function readZipEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes: number): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const p = entry.localOffset
  if (p + 30 > bytes.byteLength || view.getUint32(p, true) !== 0x04034b50) return null
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true)
  const data = bytes.subarray(start, start + entry.compressedSize)
  if (data.byteLength !== entry.compressedSize) return null
  try {
    if (entry.method === 0) return data.byteLength <= maxBytes ? data : null
    // `maxOutputLength` stopper zip-bomber: utpakkingen avbrytes ved grensen.
    if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes })
  } catch {
    return null
  }
  return null
}

/** Hoveddelen i hvert Office-format og typen den må ha i `[Content_Types].xml`. */
const OFFICE_PARTS = {
  docx: {
    part: 'word/document.xml',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  },
  xlsx: {
    part: 'xl/workbook.xml',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  },
  pptx: {
    part: 'ppt/presentation.xml',
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  },
} as const

const macros = () =>
  new DomainError(
    'Dokumenter med makroer kan ikke lastes opp. Lagre som vanlig .docx, .xlsx eller .pptx, eller som PDF.',
  )
const archive = () =>
  new DomainError(
    'Zip-filer og andre arkiver kan ikke lastes opp. Word, Excel og PowerPoint må være .docx, .xlsx eller .pptx.',
  )

/**
 * Et Office-dokument (Word, Excel eller PowerPoint) er en zip-fil med en bestemt
 * struktur. Sjekker den minimalt: innholdsfortegnelsen kan leses, ingen filer er
 * kryptert, `[Content_Types].xml` og `_rels/.rels` finnes, nøyaktig én av
 * hoveddelene finnes, og typen på den er den vanlige (ikke med makroer). Andre
 * zip-filer avvises som arkiver.
 */
function sniffOffice(bytes: Uint8Array): 'docx' | 'xlsx' | 'pptx' {
  const entries = readZipDirectory(bytes)
  if (!entries) throw archive()
  const names = new Map(entries.map((e) => [e.name, e]))
  const types = names.get('[Content_Types].xml')
  const found = (Object.keys(OFFICE_PARTS) as (keyof typeof OFFICE_PARTS)[]).filter((t) =>
    names.has(OFFICE_PARTS[t].part),
  )
  if (!types || !names.has('_rels/.rels') || found.length !== 1) throw archive()
  if (entries.some((e) => e.flags & 0x1)) {
    throw new DomainError('Passordbeskyttede filer kan ikke lastes opp. Fjern passordet først.')
  }
  if (entries.some((e) => /(^|\/)vbaProject\.bin$/i.test(e.name))) throw macros()
  const xml = readZipEntry(bytes, types, 1024 * 1024)
  if (!xml) throw archive()
  const text = new TextDecoder().decode(xml)
  const type = found[0]!
  if (/macroEnabled/i.test(text)) throw macros()
  if (!text.includes(OFFICE_PARTS[type].type)) throw archive()
  return type
}

// ---------------------------------------------------------------------------
// Tekst
// ---------------------------------------------------------------------------

/**
 * Kontrolltegn som ikke hører hjemme i en tekstfil: alt under mellomrom utenom
 * tab, linjeskift, vognretur og sideskift, og DEL.
 */
function hasControl(text: string) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0c && c !== 0x0d) || c === 0x7f) {
      return true
    }
  }
  return false
}

/**
 * Starten på HTML, SVG eller XML. Slike filer kan ikke lastes opp som tekst, selv
 * om de serveres som `text/plain` og nedlasting: ingen skal kunne legge ut en side.
 */
const MARKUP = /^\s*<(?:!doctype|html|head|body|svg|script|iframe|\?xml|!--)/i
const MARKUP_ANYWHERE = /<(?:html|svg|script|iframe)\b/i

/** Bytene Windows-1252 ikke har tegn for. */
const WINDOWS_1252_UNDEFINED = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d])

/** Teksten og tegnsettet, eller `null` hvis fila ikke er ren tekst. */
function decodeText(bytes: Uint8Array): { text: string; charset: string } | null {
  const decode = (label: string, from: number) => {
    try {
      return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(from))
    } catch {
      return null
    }
  }
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    const text = decode('utf-8', 3)
    return text === null ? null : { text, charset: 'utf-8' }
  }
  // Excel lagrer «Unicode-tekst» som UTF-16 med BOM.
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) {
    const label = bytes[0] === 0xff ? 'utf-16le' : 'utf-16be'
    const text = decode(label, 2)
    return text === null ? null : { text, charset: label }
  }
  if (bytes.includes(0)) return null
  const utf8 = decode('utf-8', 0)
  if (utf8 !== null) return { text: utf8, charset: 'utf-8' }
  // Eldre Excel lagrer CSV i Windows-1252. Bytes som ikke er tegn der, avvises.
  if (bytes.some((b) => WINDOWS_1252_UNDEFINED.has(b))) return null
  return { text: new TextDecoder('windows-1252').decode(bytes), charset: 'windows-1252' }
}

// ---------------------------------------------------------------------------
// Alt sammen
// ---------------------------------------------------------------------------

const HEIF_BRANDS = /^(heic|heix|heim|heis|hevc|hevx|hevm|hevs|mif1|msf1)$/

/**
 * Hva fila er, ut fra innholdet. `fileName` brukes bare for å skille .txt fra .csv
 * (innholdet kan være likt) og for å avvise andre tekstfiler (.html, .js, .svg).
 * Kaster `DomainError` med en melding brukeren kan lese for alt som ikke er lov.
 */
export function sniffFile(bytes: Uint8Array, fileName: string): SniffedFile {
  if (bytes.byteLength === 0) throw new DomainError('Fila er tom.')

  const image = sniffImageFormat(bytes)
  if (image) return { kind: 'image', format: image }

  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12)
    if (HEIF_BRANDS.test(brand)) {
      throw new DomainError(
        'HEIC-bilder (fra iPhone) kan ikke lastes opp. Velg «Mest kompatibel» under Kamera → Formater, eller eksporter bildet som JPEG.',
      )
    }
    if (brand === 'avif' || brand === 'avis') {
      throw new DomainError('Bildet må være JPEG, PNG, WebP eller GIF.')
    }
    // Video og lyd (mp4, mov, m4a) er heller ikke tillatt.
    throw unsupportedFile()
  }
  if (
    ascii(bytes, 0, 2) === 'BM' ||
    startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    throw new DomainError('Bildet må være JPEG, PNG, WebP eller GIF.')
  }

  if (ascii(bytes, 0, 5) === '%PDF-') return document('pdf')

  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return document(sniffOffice(bytes))
  if (startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) || startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])) {
    throw archive()
  }
  // Gamle Office-filer (.doc, .xls, .ppt), og nye som er passordbeskyttet, er OLE-filer.
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    throw new DomainError(
      'Eldre eller passordbeskyttede Office-filer kan ikke lastes opp. Lagre som .docx, .xlsx eller .pptx uten passord, eller som PDF.',
    )
  }
  if (
    ascii(bytes, 0, 2) === 'MZ' ||
    ascii(bytes, 0, 4) === '\x7fELF' ||
    startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe]) ||
    startsWith(bytes, [0xce, 0xfa, 0xed, 0xfe]) ||
    startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe]) ||
    ascii(bytes, 0, 2) === '#!'
  ) {
    throw new DomainError('Programfiler og skript kan ikke lastes opp.')
  }

  const decoded = decodeText(bytes)
  if (!decoded) throw unsupportedFile()
  const head = decoded.text.slice(0, 4096)
  if (MARKUP.test(head) || MARKUP_ANYWHERE.test(head)) {
    throw new DomainError('HTML-, SVG- og XML-filer kan ikke lastes opp.')
  }
  if (hasControl(decoded.text)) throw unsupportedFile()
  const extension = extensionOf(fileName)
  if (extension !== '' && extension !== 'txt' && extension !== 'csv') {
    if (['html', 'htm', 'xhtml', 'svg', 'xml'].includes(extension)) {
      throw new DomainError('HTML-, SVG- og XML-filer kan ikke lastes opp.')
    }
    throw unsupportedFile()
  }
  const type = extension === 'csv' ? 'csv' : 'txt'
  return {
    kind: 'document',
    type,
    contentType: `${DOCUMENT_CONTENT_TYPES[type]}; charset=${decoded.charset}`,
    extension: type,
  }
}

function document(type: Exclude<DocumentType, 'txt' | 'csv'>): SniffedFile {
  return { kind: 'document', type, contentType: DOCUMENT_CONTENT_TYPES[type], extension: type }
}

// ---------------------------------------------------------------------------
// Filnavn
// ---------------------------------------------------------------------------

/** Navn Windows ikke tillater som filnavn, uansett filendelse. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
const MAX_STEM = 100

/**
 * Filnavnet slik det lagres, vises og lastes ned: uten mappe, kontrolltegn,
 * usynlige tegn (også de som snur skriveretningen og kan skjule en filendelse),
 * tegn som ikke er lov i filnavn, og med filendelsen som passer innholdet. Høyst
 * 100 tegn før filendelsen.
 */
export function safeFileName(raw: string, extension: string, fallback = 'fil'): string {
  let name = raw.normalize('NFC')
  name = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  name = name
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
  const known = extensionOf(name)
  if (known) name = name.slice(0, -(known.length + 1))
  name = name.replace(/^[\s.]+|[\s.]+$/g, '')
  name = [...name].slice(0, MAX_STEM).join('').trim()
  if (!name) name = fallback
  if (RESERVED.test(name)) name = `_${name}`
  return `${name}.${extension}`
}

/**
 * `Content-Disposition` for nedlasting: et ASCII-navn for gamle klienter og
 * hele navnet i UTF-8 (RFC 6266 og 5987). Navnet er allerede renset med
 * `safeFileName`, så det har ingen anførselstegn eller linjeskift.
 */
export function contentDisposition(type: 'attachment' | 'inline', fileName: string): string {
  let fallback = fileName
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\%;]/g, '_')
    .trim()
  // Et navn med bare tegn utenfor ASCII blir «fil» med filendelsen.
  if (fallback === '' || fallback.startsWith('.')) fallback = `fil${fallback}`
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}
