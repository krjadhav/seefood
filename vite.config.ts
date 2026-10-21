import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function publicFiles(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? publicFiles(join(directory, entry.name), `${prefix}/${entry.name}`)
      : [`${prefix}/${entry.name}`],
  )
}

export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: process.env.SEEFOOD_API ?? 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  plugins: [
    react(),
    {
      name: 'seefood-offline',
      apply: 'build',
      generateBundle(_, bundle) {
        const files = publicFiles('public')
        const hash = createHash('sha256')
        hash.update(JSON.stringify(Object.keys(bundle)))
        hash.update(readFileSync('index.html'))
        for (const file of files) hash.update(readFileSync(`public${file}`))
        const template = readFileSync('src/service-worker.js', 'utf8')
        hash.update(template)
        const assets = [
          ...new Set([
            '/index.html',
            ...Object.keys(bundle).map((file) => `/${file}`),
            ...files,
          ]),
        ]
        this.emitFile({
          type: 'asset',
          fileName: 'sw.js',
          source: template
            .replace(
              '__CACHE_VERSION__',
              `seefood-${hash.digest('hex').slice(0, 12)}`,
            )
            .replace('__PRECACHE_ASSETS__', JSON.stringify(assets)),
        })
      },
    },
  ],
})
