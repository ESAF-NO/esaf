import { defineConfig } from 'vitest/config'

// Egen konfigurasjon, så testene ikke laster Start- og Nitro-pluginene fra vite.config.ts.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integrasjonstestene deler testdatabasen med @esaf/core og må kjøre sekvensielt.
    fileParallelism: false,
  },
})
