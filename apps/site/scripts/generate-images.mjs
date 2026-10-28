// Lager Open Graph-bilde, apple-touch-icon og favicon.ico fra SVG. Kjør på nytt når identiteten endres:
//   pnpm --filter @esaf/site exec node scripts/generate-images.mjs
import { readFile, writeFile } from 'node:fs/promises'
import sharp from 'sharp'

const ink = '#16191d'
const paper = '#f7f4ec'
const accent = '#b23a1f'
const font = 'Helvetica Neue, Helvetica, Arial, sans-serif'
const serif = 'Georgia, serif'

const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="${paper}"/>
  <text x="90" y="110" font-family="${serif}" font-weight="700" font-size="40" fill="${ink}">ESAF</text>
  <rect x="90" y="150" width="1020" height="1.5" fill="${ink}"/>
  <text x="90" y="330" font-family="${serif}" font-size="78" fill="${ink}">Nettverket som varer etter</text>
  <text x="90" y="430" font-family="${serif}" font-style="italic" font-size="78" fill="${accent}">Entreprenørskolen.</text>
  <text x="90" y="565" font-family="${font}" font-size="28" fill="#3b4048">Entreprenørskolens Alumniforening</text>
</svg>`

const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180">
  <rect width="180" height="180" fill="${ink}"/>
  <text x="90" y="122" text-anchor="middle" font-family="${font}" font-weight="800" font-size="88" fill="${paper}">E</text>
</svg>`

await sharp(Buffer.from(og))
  .png()
  .toFile(new URL('../public/og.png', import.meta.url).pathname)
await sharp(Buffer.from(icon))
  .png()
  .toFile(new URL('../public/apple-touch-icon.png', import.meta.url).pathname)

// favicon.ico for nettlesere som ikke bruker SVG-ikonet, blant annet Safari: PNG-bilder i 16, 32 og 48 px i en ICO-fil.
const faviconSvg = await readFile(new URL('../public/favicon.svg', import.meta.url))
const sizes = [16, 32, 48]
const pngs = await Promise.all(
  sizes.map((size) => sharp(faviconSvg, { density: 384 }).resize(size, size).png().toBuffer()),
)
const header = Buffer.alloc(6 + 16 * sizes.length)
header.writeUInt16LE(1, 2) // filtype: ikon
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
sizes.forEach((size, i) => {
  const entry = 6 + 16 * i
  header.writeUInt8(size, entry)
  header.writeUInt8(size, entry + 1)
  header.writeUInt16LE(1, entry + 4) // fargeplan
  header.writeUInt16LE(32, entry + 6) // biter per piksel
  header.writeUInt32LE(pngs[i].length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += pngs[i].length
})
await writeFile(new URL('../public/favicon.ico', import.meta.url), Buffer.concat([header, ...pngs]))
console.log('Skrev public/og.png, public/apple-touch-icon.png og public/favicon.ico')
