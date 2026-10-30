const KEY = 'esaf:preload-reload'
const COOLDOWN = 60_000

/** Recover an open tab whose lazy chunks disappeared during a deployment. */
export function recoverPreloadError(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  reload: () => void,
  now = Date.now(),
): boolean {
  try {
    const previous = storage.getItem(KEY)
    if (previous !== null && now - Number(previous) < COOLDOWN) return false
    storage.setItem(KEY, String(now))
  } catch {
    // Without a persistent guard, a reload could loop when storage is blocked.
    return false
  }
  reload()
  return true
}

export function installPreloadRecovery() {
  window.addEventListener('vite:preloadError', (event) => {
    if (!navigator.onLine) return
    try {
      recoverPreloadError(window.sessionStorage, () => {
        event.preventDefault()
        window.location.reload()
      })
    } catch {
      // Leave the ordinary error boundary available if browser storage is blocked.
    }
  })
}
