import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  server: { port: 3000 },
  plugins: [
    nitro({
      plugins: [
        './src/server/plugins/validate-env.ts',
        './src/server/plugins/cleanup-assets.ts',
        './src/server/plugins/search-index.ts',
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
