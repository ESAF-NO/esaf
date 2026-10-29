import js from '@eslint/js'
import astro from 'eslint-plugin-astro'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.output/**',
      '**/.astro/**',
      '**/.nitro/**',
      '**/.tanstack/**',
      '**/routeTree.gen.ts',
      // Lokale data og verktøy (gitignorert), som `.data/uploads`.
      '.data/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['apps/app/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Klientkode skal aldri importere server-only kode direkte. Serverfunksjoner
    // i *.functions.ts er unntatt, fordi kompilatoren fjerner handler-innholdet
    // fra klientbundelen. Import protection i vite.config.ts håndhever det samme ved bygg.
    files: ['apps/app/src/routes/**/*.tsx', 'apps/app/src/lib/auth-client.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@esaf/db', '@esaf/core'],
              allowTypeImports: true,
              message: 'Bruk en serverfunksjon i src/lib/*.functions.ts.',
            },
            {
              group: ['**/server/**', '**/*.server*'],
              message: 'Server-only kode kan ikke importeres fra klient.',
            },
          ],
        },
      ],
    },
  },
)
