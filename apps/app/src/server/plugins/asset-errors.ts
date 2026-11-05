import { definePlugin } from 'nitro'

/**
 * Nitro setter `immutable` på alt under /assets, også på svaret når en fil mangler.
 * Under en deploy deler proxyen forespørslene mellom gammel og ny container, så en
 * fil fra den nye versjonen kan gi 404 fra den gamle. Med `immutable` husket nettlesere
 * og Cloudflare den feilen i et år, og siden var ødelagt selv etter at deployen var
 * ferdig. Hooken kjører etter at headerne er slått sammen; en header satt av en rute
 * ville blitt overskrevet av Nitros regel.
 */
export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook('response', (response, event) => {
    if (response.status < 400 || !new URL(event.req.url).pathname.startsWith('/assets/')) return
    response.headers.set('cache-control', 'no-store')
  })
})
