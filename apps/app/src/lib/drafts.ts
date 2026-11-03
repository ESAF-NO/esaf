import { useEffect, useRef, useState } from 'react'

/**
 * Et utkast som tåler at du går fra siden: lagres i nettleseren mens du skriver,
 * og hentes fram igjen neste gang. `clear` sletter det, når det er sendt.
 * Lastes etter første tegning, så serveren og nettleseren tegner det samme.
 */
export function useDraft<T>(key: string | null, initial: T) {
  const storageKey = `esaf:utkast:${key}`
  const [value, setValue] = useState(initial)
  const loaded = useRef(false)

  useEffect(() => {
    // Uten nøkkel (som når noe redigeres) lagres ingenting.
    if (!key) return
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved) {
        const parsed = JSON.parse(saved) as T
        // Et skjema får nye felt etter hvert; de som mangler i utkastet, er blanke.
        const next =
          typeof initial === 'object' && initial !== null
            ? { ...initial, ...(parsed as object) }
            : typeof parsed === typeof initial
              ? parsed
              : initial
        // Utkastet finnes bare i nettleseren, så det kan først leses etter første tegning.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setValue(next as T)
      }
    } catch {
      // Ødelagt eller utilgjengelig lagring: start blankt.
    }
    loaded.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `initial` er bare startverdien
  }, [key, storageKey])

  const blank = useRef(JSON.stringify(initial))

  useEffect(() => {
    if (!key || !loaded.current) return
    const timer = setTimeout(() => {
      try {
        const json = JSON.stringify(value)
        // Et tomt utkast er ikke et utkast.
        if (json === blank.current) localStorage.removeItem(storageKey)
        else localStorage.setItem(storageKey, json)
      } catch {
        // Full eller sperret lagring: utkastet lagres bare ikke.
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [key, storageKey, value])

  function clear(next: T = initial) {
    loaded.current = false
    try {
      localStorage.removeItem(storageKey)
    } catch {
      // Ingenting å rydde.
    }
    setValue(next)
    // Neste endring lagres igjen.
    setTimeout(() => (loaded.current = true))
  }

  return [value, setValue, clear] as const
}
