// Lager Open Graph-bilde og apple-touch-icon fra SVG. Kjør på nytt når identiteten endres:
//   pnpm --filter @esaf/site exec node scripts/generate-images.mjs
import sharp from 'sharp'

const ink = '#14181f'
const paper = '#fbfaf7'
const accent = '#b4341e'
const font = 'Helvetica Neue, Helvetica, Arial, sans-serif'
const serif = 'Georgia, serif'

const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="${paper}"/>
  <rect x="0" y="0" width="1200" height="14" fill="${accent}"/>
  <text x="90" y="150" font-family="${font}" font-weight="800" font-size="44" letter-spacing="8" fill="${ink}">ESAF</text>
  <text x="90" y="330" font-family="${serif}" font-size="78" fill="${ink}">Nettverket som varer etter</text>
  <text x="90" y="420" font-family="${serif}" font-size="78" fill="${ink}">Entreprenørskolen.</text>
  <text x="90" y="540" font-family="${font}" font-size="30" fill="#3d4450">NTNUs Entreprenørskoles Alumniforening</text>
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
console.log('Skrev public/og.png og public/apple-touch-icon.png')
