// @ts-check
import { defineConfig } from 'astro/config'

// Ren statisk side. Ingen adapter, ingen server og ingen avhengighet til apps/app.
export default defineConfig({
  site: 'https://esaf.no',
  output: 'static',
  // Sider bygges som sponsorer.html, så Cloudflare serverer /sponsorer direkte uten omdirigering.
  // Interne lenker og kanoniske URL-er skrives derfor uten skråstrek på slutten.
  trailingSlash: 'never',
  build: { format: 'file' },
  server: { port: 4321 },
})
