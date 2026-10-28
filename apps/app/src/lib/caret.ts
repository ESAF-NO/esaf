// Stilene som avgjør hvor teksten brytes, kopieres til et usynlig speil av feltet.
const mirrored = [
  'boxSizing',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderStyle',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontFamily',
  'fontFeatureSettings',
  'fontVariationSettings',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'textIndent',
  'textTransform',
  'tabSize',
] as const

/**
 * Hvor et tegn i et tekstfelt står, i piksler fra feltets øvre venstre hjørne,
 * uten rulling. Nettleseren har ikke noe API for dette, så teksten legges i et
 * usynlig element med samme mål og skrift, og posisjonen måles der.
 */
export function caretCoordinates(el: HTMLTextAreaElement, position: number) {
  const style = getComputedStyle(el)
  const borderTop = parseFloat(style.borderTopWidth) || 0
  const borderLeft = parseFloat(style.borderLeftWidth) || 0
  const borderRight = parseFloat(style.borderRightWidth) || 0
  const mirror = document.createElement('div')
  for (const prop of mirrored) mirror.style[prop] = style[prop]
  Object.assign(mirror.style, {
    // clientWidth er uten rullefelt, så linjene brytes likt som i feltet.
    width: `${el.clientWidth + borderLeft + borderRight}px`,
    position: 'absolute',
    top: '0',
    left: '-9999px',
    visibility: 'hidden',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    overflow: 'hidden',
    height: 'auto',
  })
  mirror.textContent = el.value.slice(0, position)
  const marker = document.createElement('span')
  // Uten tekst etter markøren har spennet ingen høyde.
  marker.textContent = el.value.slice(position) || '.'
  mirror.append(marker)
  document.body.append(mirror)
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5
  const coords = {
    top: marker.offsetTop + borderTop,
    left: marker.offsetLeft + borderLeft,
    lineHeight,
  }
  mirror.remove()
  return coords
}
