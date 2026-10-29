import { gunzipSync, gzipSync } from 'node:zlib'

/**
 * Et lite tar-format (ustar) med gzip, for datasettbunter (`pnpm data:bundle` og
 * `pnpm data:import`). Bare vanlige filer; mapper lages ikke som egne oppføringer.
 * Buntene kan åpnes med vanlig `tar -tzf`, og `tar -czf` lager filer som kan leses.
 * Lesingen godtar bare trygge, relative stier, så en bunt aldri kan peke utenfor seg selv.
 */

const BLOCK = 512

export type TarEntry = { path: string; data: Uint8Array }

/** Største tillatte bunt etter utpakking. Bildene i et helt datasett er langt under dette. */
export const MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024
/** Flere filer enn dette er ikke en datasettbunt. */
const MAX_ENTRIES = 100_000

/** En sti i bunten: relativ, uten `..`, uten bakoverstrek og med vanlige tegn. */
export function isSafeEntryPath(path: string) {
  return (
    path.length > 0 &&
    path.length <= 255 &&
    !path.startsWith('/') &&
    path.split('/').every((part) => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(part))
  )
}

function writeString(header: Buffer, value: string, offset: number, length: number) {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > length) throw new Error(`For langt felt i tar-hodet: ${value}`)
  bytes.copy(header, offset)
}

function writeOctal(header: Buffer, value: number, offset: number, length: number) {
  writeString(header, `${value.toString(8).padStart(length - 1, '0')}\0`, offset, length)
}

/** Deler en lang sti i `prefix` og `name`, slik ustar gjør for stier over 100 byte. */
function splitPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' }
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
    const prefix = path.slice(0, i)
    const name = path.slice(i + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix }
  }
  throw new Error(`For lang sti for tar: ${path}`)
}

function header(path: string, size: number, mtime: number) {
  const block = Buffer.alloc(BLOCK)
  const { name, prefix } = splitPath(path)
  writeString(block, name, 0, 100)
  writeOctal(block, 0o644, 100, 8)
  writeOctal(block, 0, 108, 8)
  writeOctal(block, 0, 116, 8)
  writeOctal(block, size, 124, 12)
  writeOctal(block, mtime, 136, 12)
  block.fill(' ', 148, 156)
  block.write('0', 156)
  writeString(block, 'ustar\0', 257, 6)
  writeString(block, '00', 263, 2)
  writeString(block, prefix, 345, 155)
  let sum = 0
  for (const byte of block) sum += byte
  writeString(block, `${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return block
}

/** Pakker filene som en gzip-komprimert tar. Rekkefølgen beholdes. */
export function createTarGz(entries: TarEntry[], mtime = new Date()): Buffer {
  const seconds = Math.floor(mtime.getTime() / 1000)
  const parts: Buffer[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!isSafeEntryPath(entry.path)) throw new Error(`Ugyldig sti i bunten: ${entry.path}`)
    if (seen.has(entry.path)) throw new Error(`Samme sti to ganger i bunten: ${entry.path}`)
    seen.add(entry.path)
    parts.push(header(entry.path, entry.data.byteLength, seconds))
    parts.push(Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength))
    const padding = (BLOCK - (entry.data.byteLength % BLOCK)) % BLOCK
    if (padding) parts.push(Buffer.alloc(padding))
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return gzipSync(Buffer.concat(parts), { level: 9 })
}

function readString(block: Buffer, offset: number, length: number) {
  const raw = block.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? length : end).toString('utf8')
}

function readOctal(block: Buffer, offset: number, length: number) {
  const text = readString(block, offset, length).trim()
  if (!/^[0-7]*$/.test(text)) throw new Error('Ødelagt tar-hode.')
  return text ? parseInt(text, 8) : 0
}

/**
 * Pakker ut en gzip-komprimert tar til et kart fra sti til innhold. Avviser
 * ødelagte filer, utrygge stier, lenker og bunter som er for store.
 */
export function readTarGz(archive: Uint8Array): Map<string, Uint8Array> {
  let data: Buffer
  try {
    data = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error('Bunten er for stor.', { cause: error })
    }
    throw new Error('Bunten er ikke en gyldig .tar.gz-fil.', { cause: error })
  }
  const files = new Map<string, Uint8Array>()
  let offset = 0
  while (offset + BLOCK <= data.length) {
    const block = data.subarray(offset, offset + BLOCK)
    if (block.every((b) => b === 0)) break
    const stored = readOctal(block, 148, 8)
    let sum = 0
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!
    if (sum !== stored) throw new Error('Ødelagt tar-hode (feil sjekksum).')

    const size = readOctal(block, 124, 12)
    const type = String.fromCharCode(block[156]!)
    const magic = readString(block, 257, 6)
    const prefix = magic.startsWith('ustar') ? readString(block, 345, 155) : ''
    const name = readString(block, 0, 100)
    const path = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, '')
    const start = offset + BLOCK
    const end = start + size
    if (end > data.length) throw new Error('Bunten er avkortet.')
    offset = start + Math.ceil(size / BLOCK) * BLOCK

    // Utvidede hoder (pax) og mapper har ikke noe innhold vi trenger.
    if (type === 'x' || type === 'g' || type === '5') continue
    if (type !== '0' && type !== '\0') {
      throw new Error(`Bunten inneholder noe annet enn vanlige filer: ${path}`)
    }
    // macOS legger med «._»-filer med filattributter; de er ikke en del av bunten.
    if (path.split('/').some((part) => part.startsWith('._'))) continue
    if (!isSafeEntryPath(path)) throw new Error(`Ugyldig sti i bunten: ${path}`)
    if (files.has(path)) throw new Error(`Samme sti to ganger i bunten: ${path}`)
    if (files.size >= MAX_ENTRIES) throw new Error('Bunten har for mange filer.')
    files.set(path, data.subarray(start, end))
  }
  return files
}
