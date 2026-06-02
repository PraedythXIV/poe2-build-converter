import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Build a single self-contained index.html (all JS/CSS/data inlined) so the app runs
// completely offline from the local filesystem — no server, no runtime network.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: {
    target: 'es2020',
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4000,
    // Everything is inlined into one file, so there is nothing to preload — drop the
    // preload helper (which contains a dead `fetch`) to keep the bundle provably network-free.
    modulePreload: false,
    cssCodeSplit: false,
  },
})
