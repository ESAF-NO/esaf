// Lager Open Graph-bilde og apple-touch-icon fra SVG. Kjør på nytt når identiteten endres:
//   pnpm --filter @esaf/site exec node scripts/generate-images.mjs
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
console.log('Skrev public/og.png og public/apple-touch-icon.png')
