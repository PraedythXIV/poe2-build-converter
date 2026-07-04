import { defineConfig, type Plugin } from 'vite'

// Inline the single render-blocking entry stylesheet into a <style> in the HTML <head> and drop its <link>.
// The shell CSS (~20 KB gz) is otherwise a render-blocking round-trip on the critical path (HTML → CSS →
// first paint); folding it into the HTML collapses that to HTML → first paint, cutting FCP/LCP under slow
// links with NO flash-of-unstyled-content. Only the entry CSS the HTML directly <link>s is inlined — the
// lazily code-split panel CSS chunks (statsPanel / auditPanel / tree / emotions / …) stay separate hashed
// files, injected by JS when their route mounts, so they don't bloat the first response.
function inlineEntryCss(): Plugin {
  return {
    name: 'inline-entry-css',
    enforce: 'post',
    apply: 'build',
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find((c) => c.type === 'asset' && c.fileName.endsWith('.html'))
      if (!html || html.type !== 'asset' || typeof html.source !== 'string') return
      let src = html.source
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'asset' || !chunk.fileName.endsWith('.css')) continue
        const esc = chunk.fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const linkRe = new RegExp(`\\s*<link[^>]+href="[^"]*${esc}"[^>]*>`)
        if (!linkRe.test(src)) continue // a lazy chunk, not the entry CSS — leave it as its own file
        const css = typeof chunk.source === 'string' ? chunk.source : Buffer.from(chunk.source).toString('utf8')
        // replacer FUNCTION, not a string: CSS content may contain `$&`/`$'`-style patterns that
        // String.replace would otherwise expand into fragments of the matched HTML (silent corruption)
        src = src.replace(linkRe, () => `\n    <style>${css}</style>`)
        delete bundle[chunk.fileName] // now inlined — don't also ship it as a separate render-blocking asset
      }
      html.source = src
    },
  }
}

// Multi-file, content-hashed, code-split static build, served over http from any static host/CDN
// (GitHub Pages, CF Pages, `npm run preview`). Vendored webp atlases + large JSON are emitted as
// hashed files under dist/assets and fetched on demand — not inlined — so the initial payload is a
// small shell.
export default defineConfig({
  plugins: [inlineEntryCss()],
  // Relative URLs so dist/ runs under any path/host. Must be served over http, not file:// —
  // module scripts + asset fetches need an http origin.
  base: './',
  // Keep _workbench/ (relocated multi-GB pipeline sources + scratch, not in the module graph) out of
  // the dev watcher — chokidar tries to watch every file under the root and dies with EBUSY on it.
  server: { watch: { ignored: ['**/_workbench/**'] } },
  // es2022 output — matches tsconfig's target (modern-browser baseline), so esbuild emits class fields /
  // private methods / top-level await natively instead of down-levelling. assetsInlineLimit / modulePreload
  // / cssCodeSplit stay at their defaults, so real assets remain hashed files fetched lazily, not inlined.
  // sourcemap: 'hidden' emits .map files for prod debugging (and the Lighthouse "missing source maps"
  // best-practice) WITHOUT a //# sourceMappingURL comment — so they're never fetched at runtime, no load cost.
  build: { target: 'es2022', sourcemap: 'hidden' },
})
