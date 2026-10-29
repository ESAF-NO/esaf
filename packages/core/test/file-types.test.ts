import { crc32, deflateRawSync } from 'node:zlib'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  assetHeaders,
  contentDisposition,
  DomainError,
  safeFileName,
  sniffFile,
} from '../src/index.ts'

/** En liten zip-fil bygd i minnet, med eller uten komprimering og kryptering-flagget. */
function zip(
  entries: { name: string; data: string | Buffer; store?: boolean; encrypted?: boolean }[],
) {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const data = Buffer.from(e.data)
    const method = e.store ? 0 : 8
    const body = method === 8 ? deflateRawSync(data) : data
    const name = Buffer.from(e.name)
    const flags = e.encrypted ? 1 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const OFFICE = {
  docx: [
    'word/document.xml',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  ],
  xlsx: [
    'xl/workbook.xml',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  ],
  pptx: [
    'ppt/presentation.xml',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  ],
} as const

/** Et minimalt, gyldig Office-dokument av typen. */
function office(
  type: keyof typeof OFFICE,
  { mainType = OFFICE[type][1] as string, extra = [] as { name: string; data: string }[] } = {},
) {
  const [part] = OFFICE[type]
  return zip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${part}" ContentType="${mainType}"/></Types>`,
    },
    { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships/>' },
    { name: part, data: '<?xml version="1.0"?><document/>' },
    ...extra,
  ])
}

const pdf = () => Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n')
const png = () =>
  sharp({ create: { width: 32, height: 32, channels: 3, background: '#c33' } })
    .png()
    .toBuffer()

function rejected(bytes: Uint8Array, name: string) {
  try {
    sniffFile(bytes, name)
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError)
    return (error as DomainError).message
  }
  throw new Error(`${name} ble godtatt`)
}

describe('filtyper for vedlegg', () => {
  it('godtar bilder ut fra innholdet, uansett filnavn', async () => {
    const image = await png()
    expect(sniffFile(image, 'bilde.png')).toEqual({ kind: 'image', format: 'png' })
    // Feil filendelse eller ingen: innholdet avgjør.
    expect(sniffFile(image, 'rapport.pdf')).toEqual({ kind: 'image', format: 'png' })
    expect(sniffFile(image, 'uten-endelse')).toEqual({ kind: 'image', format: 'png' })
    const jpeg = await sharp(image).jpeg().toBuffer()
    expect(sniffFile(jpeg, 'x.png')).toEqual({ kind: 'image', format: 'jpeg' })
    const webp = await sharp(image).webp().toBuffer()
    expect(sniffFile(webp, 'x.jpg')).toEqual({ kind: 'image', format: 'webp' })
  })

  it('godtar PDF og Office-dokumenter, uansett filnavn', () => {
    expect(sniffFile(pdf(), 'program.pdf')).toMatchObject({
      kind: 'document',
      type: 'pdf',
      contentType: 'application/pdf',
      extension: 'pdf',
    })
    expect(sniffFile(pdf(), 'program.docx')).toMatchObject({ type: 'pdf' })
    for (const type of ['docx', 'xlsx', 'pptx'] as const) {
      expect(sniffFile(office(type), `fil.${type}`)).toMatchObject({ kind: 'document', type })
      // Filnavnet sier noe annet: innholdet vinner.
      expect(sniffFile(office(type), 'fil.pdf')).toMatchObject({ type, extension: type })
    }
    // Lagret uten komprimering går også.
    const stored = zip([
      {
        name: '[Content_Types].xml',
        data: `<Types><Override PartName="/word/document.xml" ContentType="${OFFICE.docx[1]}"/></Types>`,
        store: true,
      },
      { name: '_rels/.rels', data: '<Relationships/>', store: true },
      { name: 'word/document.xml', data: '<document/>', store: true },
    ])
    expect(sniffFile(stored, 'a.docx')).toMatchObject({ type: 'docx' })
  })

  it('avviser zip-filer som ikke er Office-dokumenter', () => {
    const message = /Zip-filer og andre arkiver/
    expect(rejected(zip([{ name: 'hei.txt', data: 'hei' }]), 'arkiv.zip')).toMatch(message)
    // Utgir seg for å være et Word-dokument, men mangler strukturen.
    expect(rejected(zip([{ name: 'word/document.xml', data: '<x/>' }]), 'cv.docx')).toMatch(message)
    // Har delene, men feil type i [Content_Types].xml.
    expect(rejected(office('docx', { mainType: 'application/xml' }), 'cv.docx')).toMatch(message)
    // To hoveddeler.
    const both = office('docx', { extra: [{ name: 'xl/workbook.xml', data: '<x/>' }] })
    expect(rejected(both, 'a.docx')).toMatch(message)
    // Tom zip og avkuttet zip.
    expect(rejected(Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'latin1'), 'tom.zip')).toMatch(
      message,
    )
    expect(rejected(office('docx').subarray(0, 60), 'kuttet.docx')).toMatch(message)
  })

  it('avviser makroer og passordbeskyttede filer', () => {
    expect(
      rejected(
        office('docx', {
          mainType: 'application/vnd.ms-word.document.macroEnabled.main+xml',
        }),
        'makro.docm',
      ),
    ).toMatch(/makroer/)
    expect(
      rejected(office('xlsx', { extra: [{ name: 'xl/vbaProject.bin', data: 'x' }] }), 'a.xlsx'),
    ).toMatch(/makroer/)
    const encrypted = zip([
      {
        name: '[Content_Types].xml',
        data: `<Types><Override PartName="/word/document.xml" ContentType="${OFFICE.docx[1]}"/></Types>`,
      },
      { name: '_rels/.rels', data: '<Relationships/>' },
      { name: 'word/document.xml', data: '<x/>', encrypted: true },
    ])
    expect(rejected(encrypted, 'hemmelig.docx')).toMatch(/Passordbeskyttede/)
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])
    expect(rejected(ole, 'gammel.doc')).toMatch(/Eldre eller passordbeskyttede Office-filer/)
  })

  it('avviser SVG, HTML og XML, også med en annen filendelse', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'
    for (const [content, name] of [
      [svg, 'logo.svg'],
      [svg, 'logo.png'],
      [svg, 'notat.txt'],
      ['<?xml version="1.0"?><svg/>', 'bilde.jpg'],
      ['<!DOCTYPE html><html><script>alert(1)</script>', 'side.html'],
      ['<!doctype html><p>hei', 'readme.txt'],
      ['\ufeff  <html><body>hei</body></html>', 'data.csv'],
      ['Navn;Alder\nOla;<script>alert(1)</script>', 'liste.csv'],
    ] as const) {
      expect(rejected(Buffer.from(content), name)).toMatch(/HTML-, SVG- og XML-filer/)
    }
    // Ren tekst med filendelsen .html avvises også.
    expect(rejected(Buffer.from('bare tekst'), 'side.html')).toMatch(/HTML-, SVG- og XML-filer/)
  })

  it('avviser programfiler, skript, arkiver, HEIC og andre bildeformater', () => {
    const cases: [Buffer, string, RegExp][] = [
      [Buffer.from('MZ\x90\x00\x03', 'latin1'), 'oppdatering.pdf', /Programfiler/],
      [Buffer.from('\x7fELF\x02\x01', 'latin1'), 'program', /Programfiler/],
      [Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]), 'app', /Programfiler/],
      [Buffer.from('#!/bin/sh\nrm -rf /\n'), 'notat.txt', /skript/],
      [Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0]), 'arkiv.tar.gz', /Filtypen støttes ikke/],
      [Buffer.from('Rar!\x1a\x07\x00', 'latin1'), 'arkiv.rar', /Filtypen støttes ikke/],
      [Buffer.from("7z\xbc\xaf'\x1c", 'latin1'), 'arkiv.7z', /Filtypen støttes ikke/],
      [Buffer.from('\0\0\0\x18ftypheic\0\0\0\0', 'latin1'), 'IMG_0001.HEIC', /HEIC/],
      [Buffer.from('\0\0\0\x18ftypmif1\0\0\0\0', 'latin1'), 'IMG_0001.jpg', /HEIC/],
      [Buffer.from('\0\0\0\x1cftypavif\0\0\0\0', 'latin1'), 'a.avif', /JPEG, PNG eller WebP/],
      [Buffer.from('\0\0\0\x18ftypisom\0\0\0\0', 'latin1'), 'film.mp4', /Filtypen støttes ikke/],
      [Buffer.from('GIF89a\x01\x00', 'latin1'), 'anim.gif', /JPEG, PNG eller WebP/],
      [Buffer.from('BM\x00\x00', 'latin1'), 'a.bmp', /JPEG, PNG eller WebP/],
      [Buffer.from('II*\x00', 'latin1'), 'a.tiff', /JPEG, PNG eller WebP/],
      [Buffer.from('print("hei")'), 'skript.py', /Filtypen støttes ikke/],
      [Buffer.from('alert(1)'), 'app.js', /Filtypen støttes ikke/],
      [
        Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00]),
        'data.bin',
        /Filtypen støttes ikke/,
      ],
      [Buffer.alloc(0), 'tom.txt', /tom/],
    ]
    for (const [bytes, name, message] of cases) expect(rejected(bytes, name)).toMatch(message)
  })

  it('godtar ren tekst og CSV i UTF-8, UTF-16 og Windows-1252', () => {
    expect(sniffFile(Buffer.from('Hei på deg\n'), 'notat.txt')).toMatchObject({
      type: 'txt',
      contentType: 'text/plain; charset=utf-8',
    })
    expect(sniffFile(Buffer.from('a;b\n1;2\n'), 'Liste.CSV')).toMatchObject({
      type: 'csv',
      contentType: 'text/csv; charset=utf-8',
      extension: 'csv',
    })
    expect(sniffFile(Buffer.from('uten endelse'), 'README')).toMatchObject({ type: 'txt' })
    // Excel: «CSV» i Windows-1252 og «Unicode-tekst» i UTF-16 med BOM.
    expect(sniffFile(Buffer.from('Navn;Sted\nKåre;Trøndelag\n', 'latin1'), 'a.csv')).toMatchObject({
      contentType: 'text/csv; charset=windows-1252',
    })
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Æ\tØ\r\n', 'utf16le')])
    expect(sniffFile(utf16, 'a.txt')).toMatchObject({ contentType: 'text/plain; charset=utf-16le' })
    // Kontrolltegn er ikke tekst.
    expect(rejected(Buffer.from('hei\x1bverden'), 'a.txt')).toMatch(/Filtypen støttes ikke/)
  })
})

describe('filnavn', () => {
  it('fjerner mapper, usynlige tegn og ulovlige tegn, og bruker filendelsen fra innholdet', () => {
    expect(safeFileName('Pitch deck 2026.pdf', 'pdf')).toBe('Pitch deck 2026.pdf')
    expect(safeFileName('../../etc/passwd', 'txt')).toBe('passwd.txt')
    expect(safeFileName('C:\\Users\\kari\\Referat.docx', 'docx')).toBe('Referat.docx')
    // Snur skriveretningen for å skjule «.exe»: tegnet fjernes, og filendelsen settes riktig.
    expect(safeFileName('faktura\u202Efdp.exe', 'pdf')).toBe('fakturafdp.pdf')
    expect(safeFileName('rapport.pdf', 'docx')).toBe('rapport.docx')
    expect(safeFileName('Referat 12.10.2024', 'pdf')).toBe('Referat 12.10.2024.pdf')
    expect(safeFileName('a"b<c>d|e?f*g:h.txt', 'txt')).toBe('a_b_c_d_e_f_g_h.txt')
    expect(safeFileName('linje\nskift\t.txt', 'txt')).toBe('linjeskift.txt')
    expect(safeFileName('   ...   ', 'pdf')).toBe('fil.pdf')
    expect(safeFileName('IMG_0001.jpg', 'webp', 'bilde')).toBe('IMG_0001.webp')
    expect(safeFileName('CON.txt', 'txt')).toBe('_CON.txt')
    expect(safeFileName(`${'å'.repeat(300)}.pdf`, 'pdf')).toBe(`${'å'.repeat(100)}.pdf`)
  })

  it('Content-Disposition har et ASCII-navn og hele navnet i UTF-8', () => {
    expect(contentDisposition('attachment', 'Årsrapport 2025.pdf')).toBe(
      `attachment; filename="Arsrapport 2025.pdf"; filename*=UTF-8''%C3%85rsrapport%202025.pdf`,
    )
    expect(contentDisposition('inline', '日本.webp')).toBe(
      `inline; filename="fil.webp"; filename*=UTF-8''%E6%97%A5%E6%9C%AC.webp`,
    )
    expect(contentDisposition('attachment', "it's (1).txt")).toContain(
      "UTF-8''it%27s%20%281%29.txt",
    )
  })
})

describe('svarhoder for vedlegg', () => {
  it('dokumenter lastes alltid ned, med nosniff og sandbox, og mellomlagres ikke', () => {
    const headers = assetHeaders(
      { kind: 'document', contentType: 'application/pdf', fileName: 'Program.pdf' },
      1234,
    )
    expect(headers).toMatchObject({
      'content-type': 'application/pdf',
      'content-length': '1234',
      'content-disposition': `attachment; filename="Program.pdf"; filename*=UTF-8''Program.pdf`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    })
    expect(headers['content-security-policy']).toContain("default-src 'none'")
    expect(headers['content-security-policy']).toContain('sandbox')
    // Tekst serveres som tekst, aldri som HTML.
    const text = assetHeaders(
      { kind: 'document', contentType: 'text/plain; charset=utf-8', fileName: 'a.txt' },
      3,
    )
    expect(text['content-type']).toBe('text/plain; charset=utf-8')
    expect(text['content-disposition']).toMatch(/^attachment;/)
  })

  it('bilder vises i siden og kan mellomlagres lenge, privat', () => {
    const headers = assetHeaders(
      { kind: 'image', contentType: 'image/webp', fileName: 'bilde.webp' },
      10,
    )
    expect(headers).toMatchObject({
      'content-type': 'image/webp',
      'content-disposition': `inline; filename="bilde.webp"; filename*=UTF-8''bilde.webp`,
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    })
    expect(headers['content-security-policy']).toContain('sandbox')
  })
})
