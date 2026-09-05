import type {
  ObsAssetKind,
  ObsRelease,
  ObsReleaseAsset,
  Platform
} from '@shared/types'

/**
 * The OBS Studio release catalogue.
 *
 * Everything here is pure: parsing the releases API, reading the checksum
 * block out of the release notes, picking the right asset for a platform and
 * comparing versions. The download and extraction live in `obs-downloader.ts`,
 * so the decisions can be tested without a network.
 *
 * Verified against obsproject/obs-studio's own release workflow rather than
 * from memory: `.github/workflows/push.yaml` names the assets and generates
 * the `### Checksums` block this parses.
 */

export const OBS_RELEASES_URL =
  'https://api.github.com/repos/obsproject/obs-studio/releases?per_page=30'

/* ------------------------------------------------------------------ */
/* Parsing                                                            */
/* ------------------------------------------------------------------ */

interface GithubAsset {
  name?: unknown
  browser_download_url?: unknown
  size?: unknown
}

interface GithubRelease {
  tag_name?: unknown
  name?: unknown
  body?: unknown
  draft?: unknown
  prerelease?: unknown
  published_at?: unknown
  html_url?: unknown
  assets?: unknown
}

/**
 * Reads the checksum block upstream puts in the release notes.
 *
 * The format is a `### Checksums` heading followed by indented
 * `filename: hash` lines. Parsed leniently — a release without the block, or
 * with it reformatted, must degrade to "no checksum available" rather than
 * failing the whole catalogue.
 */
export function parseChecksums(body: string): Map<string, string> {
  const checksums = new Map<string, string>()
  if (!body) return checksums

  for (const line of body.split(/\r?\n/)) {
    // `    OBS-Studio-31.0.2-Windows-x64.zip: a1b2...` — the name can carry
    // spaces, so the split is on the last colon before the hash.
    const match = /^\s*(\S.*?):\s*([0-9a-fA-F]{64})\s*$/.exec(line)
    if (match) checksums.set(match[1].trim(), match[2].toLowerCase())
  }

  return checksums
}

/** Classifies an asset by its filename. */
export function classifyAsset(name: string): {
  kind: ObsAssetKind
  os: Platform | null
  arch: ObsReleaseAsset['arch']
} {
  const lower = name.toLowerCase()

  // Debug symbols and sources are large and useless here; they must never be
  // mistaken for something installable.
  if (lower.includes('-pdbs') || lower.includes('dsyms') || lower.includes('sources')) {
    return { kind: 'other', os: null, arch: null }
  }

  const arch: ObsReleaseAsset['arch'] = lower.includes('arm64')
    ? 'arm64'
    : lower.includes('x64') || lower.includes('x86_64') || lower.includes('intel')
      ? 'x64'
      : null

  if (lower.endsWith('.zip') && lower.includes('windows')) {
    return { kind: 'portable-archive', os: 'win32', arch }
  }
  if (lower.endsWith('.exe')) return { kind: 'installer', os: 'win32', arch }
  if (lower.endsWith('.dmg')) {
    return { kind: 'disk-image', os: 'darwin', arch: lower.includes('apple') ? 'arm64' : arch }
  }
  if (lower.endsWith('.deb') || lower.endsWith('.ddeb') || lower.endsWith('.rpm')) {
    return { kind: 'package', os: 'linux', arch }
  }

  return { kind: 'other', os: null, arch: null }
}

/** Turns the releases API payload into the catalogue the app works with. */
export function parseReleases(json: string): ObsRelease[] {
  const raw: unknown = JSON.parse(json)
  if (!Array.isArray(raw)) throw new Error('Unexpected releases payload: expected an array')

  const releases: ObsRelease[] = []

  for (const item of raw as GithubRelease[]) {
    if (item.draft === true) continue

    const tagName = typeof item.tag_name === 'string' ? item.tag_name : null
    if (!tagName) continue

    const checksums = parseChecksums(typeof item.body === 'string' ? item.body : '')
    const assets: ObsReleaseAsset[] = []

    for (const asset of Array.isArray(item.assets) ? (item.assets as GithubAsset[]) : []) {
      const name = typeof asset.name === 'string' ? asset.name : null
      const downloadUrl =
        typeof asset.browser_download_url === 'string' ? asset.browser_download_url : null
      if (!name || !downloadUrl) continue

      const { kind, os, arch } = classifyAsset(name)
      assets.push({
        name,
        downloadUrl,
        sizeBytes: typeof asset.size === 'number' ? asset.size : 0,
        sha256: checksums.get(name) ?? null,
        kind,
        os,
        arch
      })
    }

    releases.push({
      version: tagName.replace(/^v/i, ''),
      tagName,
      publishedAt: typeof item.published_at === 'string' ? Date.parse(item.published_at) : 0,
      prerelease: item.prerelease === true,
      htmlUrl: typeof item.html_url === 'string' ? item.html_url : '',
      assets
    })
  }

  return releases.sort((a, b) => compareVersions(b.version, a.version))
}

/* ------------------------------------------------------------------ */
/* Selection                                                          */
/* ------------------------------------------------------------------ */

/**
 * Why a platform cannot install OBS from a download, or `null` if it can.
 *
 * Only Windows publishes a portable archive, which is the only shape that can
 * be unpacked next to another copy without touching the system. macOS ships a
 * disk image, which can be mounted and copied. Linux publishes a `.deb` for
 * one Ubuntu release, which is a system package rather than a side-by-side
 * install, so this application does not pretend to manage it.
 */
export function downloadSupport(target: Platform): string | null {
  if (target === 'win32' || target === 'darwin') return null
  return (
    'OBS does not publish a portable Linux build — upstream ships a .deb for one Ubuntu release, ' +
    'which installs system-wide rather than alongside other copies. Install OBS with your package ' +
    'manager or Flatpak, then add it under Settings.'
  )
}

/**
 * Picks the asset to download for a platform and architecture.
 *
 * Falls back across architectures rather than returning nothing: an arm64
 * Windows machine runs the x64 build, and an Apple Silicon Mac runs the Intel
 * image under Rosetta. A slower OBS is better than no OBS.
 */
export function selectAsset(
  release: ObsRelease,
  target: Platform,
  arch: string
): ObsReleaseAsset | null {
  // A platform with no installable shape must select nothing at all. Matching
  // on kind alone would hand a Linux host the Windows portable archive.
  if (downloadSupport(target) !== null) return null

  const wanted: ObsAssetKind = target === 'darwin' ? 'disk-image' : 'portable-archive'
  const candidates = release.assets.filter((asset) => asset.kind === wanted && asset.os === target)
  if (candidates.length === 0) return null

  const preferred = arch === 'arm64' ? 'arm64' : 'x64'
  return (
    candidates.find((asset) => asset.arch === preferred) ??
    candidates.find((asset) => asset.arch === 'universal') ??
    candidates.find((asset) => asset.arch === null) ??
    candidates[0]
  )
}

/* ------------------------------------------------------------------ */
/* Versions                                                           */
/* ------------------------------------------------------------------ */

/**
 * Compares two OBS versions.
 *
 * OBS uses plain dotted numbers (`31.0.2`), occasionally with a suffix such as
 * `-rc1`. Numeric parts compare numerically; a version with a suffix sorts
 * below the same version without one, so `31.0.0-rc1` never looks newer than
 * `31.0.0`.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): { parts: number[]; suffix: string } => {
    const [core, ...rest] = value.trim().replace(/^v/i, '').split('-')
    return {
      parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
      suffix: rest.join('-')
    }
  }

  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.parts.length, right.parts.length)

  for (let index = 0; index < length; index += 1) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }

  if (left.suffix === right.suffix) return 0
  if (left.suffix === '') return 1
  if (right.suffix === '') return -1
  return left.suffix > right.suffix ? 1 : -1
}

/** True when `candidate` is a version worth offering over `current`. */
export function isNewer(candidate: string, current: string | null): boolean {
  if (!current) return true
  return compareVersions(candidate, current) > 0
}

/**
 * The newest release worth installing.
 *
 * Pre-releases are skipped unless asked for: a production rig should not be
 * offered a release candidate as though it were a stable upgrade.
 */
export function latestRelease(releases: ObsRelease[], includePrerelease = false): ObsRelease | null {
  const usable = releases.filter((release) => includePrerelease || !release.prerelease)
  return usable[0] ?? null
}
