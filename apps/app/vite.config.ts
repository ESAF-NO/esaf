import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  server: { port: 3000 },
  ssr: {
    // better-auth bakes Vite inn i serverbundelen, men pluginene ville ellers
    // blitt pakket av Nitro etterpå, med sin egen kopi av @better-auth/core. Da
    // finnes `APIError` to ganger, og pluginenes `instanceof APIError` slår feil
    // på våre feil: en passkey uten biometri ga «AUTHENTICATION_FAILED» i stedet
    // for riktig melding. Alt fra better-auth pakkes derfor i samme omgang.
    // `scripts/check-server-bundle.ts` passer på at det forblir slik.
    noExternal: [/^better-auth(\/|$)/, /^@better-auth\//],
  },
  plugins: [
    nitro({
      plugins: [
        './src/server/plugins/validate-env.ts',
        './src/server/plugins/cleanup-assets.ts',
        './src/server/plugins/cleanup-oauth.ts',
        './src/server/plugins/sync-badges.ts',
        './src/server/plugins/notification-emails.ts',
        './src/server/plugins/search-index.ts',
        './src/server/plugins/shutdown.ts',
      ],
      // Bildebehandlingen og embedding-modellen har native binærfiler som må ligge
      // som egne pakker i .output, ikke bakes inn i bundelen. `*` tar med hele pakken.
      traceDeps: ['sharp*', 'onnxruntime-node*', '@huggingface/transformers*'],
    }),
    tanstackStart({
      importProtection: {
        behavior: 'error',
        client: {
          // Database, domenelogikk og auth-server skal aldri havne i klientbundelen.
          specifiers: [
            '@esaf/db',
            '@esaf/core',
            '@esaf/mcp',
            '@modelcontextprotocol/server',
            'pg',
            'drizzle-orm',
            'better-auth/adapters/drizzle',
            'better-auth/tanstack-start',
          ],
          files: ['**/*.server.*', '**/src/server/**'],
        },
      },
    }),
    viteReact(),
    tailwindcss(),
  ],
})
