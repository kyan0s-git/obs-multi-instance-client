/**
 * Build identity.
 *
 * The three values are replaced at bundle time by `define` in
 * `electron.vite.config.ts`, which reads them from `package.json` and the git
 * working copy. They are guarded with `typeof` because vitest and `tsx` run
 * these modules without going through that config, and an unreplaced bare
 * identifier would be a ReferenceError rather than a missing version string.
 */

declare const __APP_VERSION__: string
declare const __BUILD_COMMIT__: string
declare const __BUILD_DATE__: string

/** SemVer core, e.g. `0.2.0`. */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'

/** Short commit the build came from, or `dev` outside a git checkout. */
export const BUILD_COMMIT: string =
  typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'dev'

/** Build date as MMDD — the form used in the build metadata field. */
export const BUILD_DATE: string =
  typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : '0000'

/**
 * Full SemVer 2.0 string with build metadata: `0.2.0+0828.03620f3`.
 *
 * Build metadata is the `+` segment precisely because it does not participate
 * in precedence comparison — two builds of 0.2.0 from different commits are
 * the same release, which is what we want for update checks, while still being
 * distinguishable in a bug report.
 */
export const BUILD_ID = `${APP_VERSION}+${BUILD_DATE}.${BUILD_COMMIT}`
