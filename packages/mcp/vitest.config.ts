import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Integrasjonstestene deler én testdatabase og må kjøre sekvensielt.
    fileParallelism: false,
  },
})
