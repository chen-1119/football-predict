import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('.', import.meta.url))
const publicDir = resolve(rootDir, 'public')
const distDir = resolve(rootDir, 'dist')

const largeStaticPayloads = [
  'matches.json',
  'odds-history.json',
  'data/matches-current.json',
  'data/matches-history.json',
  'data/odds-history.json',
  'data/post-match-reviews.json',
  'data/external-signals.json',
  'data/five-hundred-details.json',
  'data/pre-match-signals.json',
  'data/prediction-snapshots.json',
  'data/model-calibration.json',
  'data/model-strategy.json',
  'data/api-football-cache.json',
  'data/api-football-meta.json',
  'data/gpt-predictions.json',
  'data/web-consensus-signals.json',
  'data/weather-locations.json',
  'data/worldcup-kimi-dataset.json',
]

const stripLargeStaticPayloads = () => ({
  name: 'strip-large-static-payloads',
  apply: 'build' as const,
  closeBundle() {
    for (const fileName of largeStaticPayloads) {
      rmSync(resolve(distDir, fileName), { force: true })
    }
  },
})

const copyFilteredPublicAssets = () => {
  const blocked = new Set(largeStaticPayloads.map((fileName) => fileName.replace(/\\/g, '/')))

  const copyEntry = (sourcePath: string) => {
    const relativePath = relative(publicDir, sourcePath).replace(/\\/g, '/')
    if (!relativePath || blocked.has(relativePath) || /^data\/external-signals\.json\.tmp-/i.test(relativePath)) return
    const stat = statSync(sourcePath)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(sourcePath)) {
        copyEntry(resolve(sourcePath, entry))
      }
      return
    }
    if (!stat.isFile()) return
    const targetPath = resolve(distDir, relativePath)
    mkdirSync(dirname(targetPath), { recursive: true })
    copyFileSync(sourcePath, targetPath)
  }

  return {
    name: 'copy-filtered-public-assets',
    apply: 'build' as const,
    closeBundle() {
      if (!existsSync(publicDir)) return
      for (const entry of readdirSync(publicDir)) {
        copyEntry(resolve(publicDir, entry))
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  publicDir: false,
  plugins: [react(), tailwindcss(), copyFilteredPublicAssets(), stripLargeStaticPayloads()],
  base: process.env.VITE_BASE_PATH || '/',
  server: {
    proxy: {
      '/api': 'http://localhost:8788',
    },
  },
})
