// Deploy the BFF to Cloudflare Pages: stage server/worker.mjs as a Pages "advanced mode"
// _worker.js, then hand off to wrangler. Auth (CLOUDFLARE_API_TOKEN) + the target account
// (CLOUDFLARE_ACCOUNT_ID) come from the gitignored .env (loaded via lib.mjs) or a prior login.
//
//   npm run deploy:bff

import { copyFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { ROOT } from './lib.mjs' // importing lib.mjs also loads .env (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)

const STAGE = join(ROOT, 'server', '.pages')
const PROJECT = 'poe2-planner-bff'

// wrangler reads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID from the env (loaded from .env by lib.mjs).
if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID in .env (or the environment) before `npm run deploy:bff`.')
  process.exit(1)
}

mkdirSync(STAGE, { recursive: true })
copyFileSync(join(ROOT, 'server', 'worker.mjs'), join(STAGE, '_worker.js'))

// RELATIVE staged path + cwd: shell:true (needed for npx on Windows) concatenates args unescaped,
// and the absolute repo path contains spaces — wrangler would see it split into garbage positionals
// and print its help (exit 0 = a SILENT deploy failure). Same trap/fix as build-mod-tiers.mjs.
const r = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'wrangler@latest',
    'pages',
    'deploy',
    'server/.pages',
    '--project-name',
    PROJECT,
    '--branch',
    'main',
    '--commit-dirty=true',
  ],
  { stdio: 'inherit', shell: process.platform === 'win32', cwd: ROOT },
)
process.exit(r.status ?? 1)
