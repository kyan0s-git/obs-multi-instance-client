import { describe, expect, it } from 'vitest'
import { APP_VERSION, BUILD_COMMIT, BUILD_DATE, BUILD_ID } from '../src/shared/version'

/**
 * Vitest does not go through `electron.vite.config.ts`, so importing this
 * module here is exactly the case the `typeof` guards exist for: it must fall
 * back rather than throw a ReferenceError on an unreplaced identifier.
 */
describe('build identity', () => {
  it('falls back to placeholders outside a configured build', () => {
    expect(APP_VERSION).toBe('0.0.0')
    expect(BUILD_COMMIT).toBe('dev')
    expect(BUILD_DATE).toBe('0000')
  })

  it('is a valid SemVer string with build metadata', () => {
    expect(BUILD_ID).toBe('0.0.0+0000.dev')
    // SemVer 2.0: core, then a `+` build-metadata segment of dot-separated
    // alphanumerics. Anything else and `dist` produces an unparseable version.
    expect(BUILD_ID).toMatch(/^\d+\.\d+\.\d+\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$/)
  })
})
