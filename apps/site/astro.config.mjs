// @ts-check
import { defineConfig } from 'astro/config'

// Ren statisk side. Ingen adapter, ingen server og ingen avhengighet til apps/app.
export default defineConfig({
  site: 'https://esaf.no',
  output: 'static',
  trailingSlash: 'ignore',
  server: { port: 4321 },
})
