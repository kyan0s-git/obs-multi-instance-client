import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

/**
 * Short commit of the tree being built.
 *
 * Falls back to `dev` rather than failing the build: source tarballs and
 * packaging containers frequently have no `.git`, and a missing commit should
 * not be the reason a release cannot be produced.
 */
function commit(): string {
  const fromCi = process.env.GITHUB_SHA ?? process.env.SOURCE_COMMIT
  if (fromCi) return fromCi.slice(0, 7)
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim()
  } catch {
    return 'dev'
  }
}

/** Build date as MMDD, per the release convention for this project. */
function buildDate(): string {
  const now = new Date()
  return `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
}

const define = {
  __APP_VERSION__: JSON.stringify(pkg.version),
  __BUILD_COMMIT__: JSON.stringify(commit()),
  __BUILD_DATE__: JSON.stringify(buildDate())
}

export default defineConfig({
  main: {
    define,
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    define,
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    define,
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
})
