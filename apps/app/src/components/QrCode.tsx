import { encode } from 'uqr'

/** QR-kode som ren SVG, til oppsett av tofaktor i en autentiseringsapp. */
export function QrCode({ value, size = 176 }: { value: string; size?: number }) {
  const { data } = encode(value, { ecc: 'M', border: 2 })
  const n = data.length
  let path = ''
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`
    }),
  )
  return (
    <svg
      viewBox={`0 0 ${n} ${n}`}
      width={size}
      height={size}
      role="img"
      aria-label="QR-kode for autentiseringsappen"
      shapeRendering="crispEdges"
      className="rounded-lg ring-1 ring-stone-200"
    >
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#1c1917" />
    </svg>
  )
}
