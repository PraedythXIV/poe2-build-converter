import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // parsePob uses the browser-native DOMParser('text/xml'); jsdom supports XML parsing
    // (happy-dom does not — it falls back to HTML mode).
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
})
