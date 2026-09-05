import type { FleetUpdate, Platform } from '@shared/types'
import { APP_VERSION } from '@shared/version.js'
import { fetchText } from '../util/download.js'
import { compareVersions } from './obs-catalog.js'

/**
 * Checks whether a newer OBS Fleet has been released.
 *
 * Deliberately a check and a link, not a silent self-replacing updater. This
 * application supervises OBS instances that are frequently on air; a process
 * that swaps its own binary underneath a running show is not a feature anyone
 * asked for. The user is told, and chooses when.
 */

export const FLEET_RELEASES_URL =
  'https://api.github.com/repos/kyan0s-git/obs-multi-instance-client/releases/latest'

interface GithubRelease {
  tag_name?: unknown
  body?: unknown
  html_url?: unknown
  published_at?: unknown
  prerelease?: unknown
  assets?: unknown
}

interface GithubAsset {
  name?: unknown
  browser_download_url?: unknown
  size?: unknown
}

/**
 * Picks the installer for the platform running now.
 *
 * Matched by extension rather than by exact filename so a rename in the
 * release workflow does not silently stop offering updates.
 */
export function selectFleetAsset(
  assets: Array<{ name: string; url: string; size: number }>,
  target: Platform
): { name: string; url: string; size: number } | null {
  const wanted =
    target === 'win32'
      ? ['.exe']
      : target === 'darwin'
        ? ['.dmg']
        : ['.appimage', '.deb']

  for (const extension of wanted) {
    const match = assets.find((asset) => asset.name.toLowerCase().endsWith(extension))
    if (match) return match
  }

  return null
}

/** Turns the release payload into the answer the UI needs. */
export function parseFleetRelease(
  json: string,
  currentVersion: string,
  target: Platform
): FleetUpdate {
  const raw = JSON.parse(json) as GithubRelease

  const tag = typeof raw.tag_name === 'string' ? raw.tag_name : null
  const latestVersion = tag ? tag.replace(/^v/i, '') : null

  const assets = (Array.isArray(raw.assets) ? (raw.assets as GithubAsset[]) : [])
    .map((asset) => ({
      name: typeof asset.name === 'string' ? asset.name : '',
      url: typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '',
      size: typeof asset.size === 'number' ? asset.size : 0
    }))
    .filter((asset) => asset.name !== '' && asset.url !== '')

  const download = selectFleetAsset(assets, target)

  return {
    currentVersion,
    latestVersion,
    // A build running ahead of the last release — a local build, or a release
    // still being published — must not be told to "update" backwards.
    updateAvailable: latestVersion !== null && compareVersions(latestVersion, currentVersion) > 0,
    releaseUrl: typeof raw.html_url === 'string' ? raw.html_url : null,
    publishedAt: typeof raw.published_at === 'string' ? Date.parse(raw.published_at) : null,
    notes: typeof raw.body === 'string' ? raw.body.slice(0, MAX_NOTES_CHARS) : null,
    downloadUrl: download?.url ?? null,
    downloadName: download?.name ?? null,
    downloadBytes: download?.size ?? null,
    checkedAt: Date.now(),
    error: null
  }
}

/**
 * Asks GitHub for the latest release.
 *
 * A failure here is reported in the result rather than thrown: not knowing
 * whether an update exists is a normal state for a machine on a locked-down
 * production network, and it must not look like a broken application.
 */
export async function checkForFleetUpdate(target: Platform): Promise<FleetUpdate> {
  const current = APP_VERSION

  try {
    return parseFleetRelease(await fetchText(FLEET_RELEASES_URL), current, target)
  } catch (err) {
    return {
      currentVersion: current,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      publishedAt: null,
      notes: null,
      downloadUrl: null,
      downloadName: null,
      downloadBytes: null,
      checkedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/** Release notes are shown in a panel, not read as a document. */
const MAX_NOTES_CHARS = 4000
