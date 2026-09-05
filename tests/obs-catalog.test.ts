import { describe, expect, it } from 'vitest'
import {
  classifyAsset,
  compareVersions,
  downloadSupport,
  isNewer,
  latestRelease,
  parseChecksums,
  parseReleases,
  selectAsset
} from '../src/main/services/obs-catalog'
import type { ObsRelease } from '../src/shared/types'

/**
 * The asset names and the checksum block below are the real shapes from
 * obsproject/obs-studio's release workflow (`.github/workflows/push.yaml`),
 * not invented ones. Getting this wrong means downloading debug symbols
 * instead of OBS, so it is pinned.
 */

const CHECKSUM_BODY = `## What's Changed

Some notes about the release.

### Checksums
    OBS-Studio-31.0.2-Windows-x64.zip: ${'a'.repeat(64)}
    OBS-Studio-31.0.2-Windows-x64-Installer.exe: ${'b'.repeat(64)}
    OBS-Studio-31.0.2-macOS-Apple.dmg: ${'c'.repeat(64)}
`

function releasePayload(): string {
  return JSON.stringify([
    {
      tag_name: '31.0.2',
      published_at: '2025-01-15T10:00:00Z',
      prerelease: false,
      draft: false,
      html_url: 'https://github.com/obsproject/obs-studio/releases/tag/31.0.2',
      body: CHECKSUM_BODY,
      assets: [
        {
          name: 'OBS-Studio-31.0.2-Windows-x64.zip',
          browser_download_url: 'https://example.invalid/win-x64.zip',
          size: 157286400
        },
        {
          name: 'OBS-Studio-31.0.2-Windows-x64-PDBs.zip',
          browser_download_url: 'https://example.invalid/pdbs.zip',
          size: 400000000
        },
        {
          name: 'OBS-Studio-31.0.2-Windows-arm64.zip',
          browser_download_url: 'https://example.invalid/win-arm64.zip',
          size: 150000000
        },
        {
          name: 'OBS-Studio-31.0.2-macOS-Apple.dmg',
          browser_download_url: 'https://example.invalid/mac-apple.dmg',
          size: 180000000
        },
        {
          name: 'OBS-Studio-31.0.2-macOS-Intel.dmg',
          browser_download_url: 'https://example.invalid/mac-intel.dmg',
          size: 185000000
        },
        {
          name: 'OBS-Studio-31.0.2-Ubuntu-26.04-x86_64.deb',
          browser_download_url: 'https://example.invalid/obs.deb',
          size: 90000000
        }
      ]
    },
    {
      tag_name: '31.1.0-rc1',
      published_at: '2025-02-01T10:00:00Z',
      prerelease: true,
      draft: false,
      html_url: 'https://example.invalid/rc',
      body: '',
      assets: []
    },
    {
      tag_name: '30.2.3',
      published_at: '2024-09-01T10:00:00Z',
      prerelease: false,
      draft: false,
      html_url: 'https://example.invalid/old',
      body: '',
      assets: []
    },
    { tag_name: '99.0.0', draft: true, assets: [] }
  ])
}

describe('checksum parsing', () => {
  it('reads the indented filename/hash lines out of the release notes', () => {
    const checksums = parseChecksums(CHECKSUM_BODY)

    expect(checksums.get('OBS-Studio-31.0.2-Windows-x64.zip')).toBe('a'.repeat(64))
    expect(checksums.get('OBS-Studio-31.0.2-macOS-Apple.dmg')).toBe('c'.repeat(64))
    expect(checksums.size).toBe(3)
  })

  it('degrades to nothing rather than throwing when the block is absent', () => {
    expect(parseChecksums('no checksums here').size).toBe(0)
    expect(parseChecksums('').size).toBe(0)
  })

  it('ignores a line whose hash is not a full sha256', () => {
    expect(parseChecksums('    thing.zip: abc123').size).toBe(0)
  })
})

describe('asset classification', () => {
  it('recognises the Windows portable archive', () => {
    expect(classifyAsset('OBS-Studio-31.0.2-Windows-x64.zip')).toEqual({
      kind: 'portable-archive',
      os: 'win32',
      arch: 'x64'
    })
  })

  it('never treats debug symbols or sources as installable', () => {
    expect(classifyAsset('OBS-Studio-31.0.2-Windows-x64-PDBs.zip').kind).toBe('other')
    expect(classifyAsset('OBS-Studio-31.0.2-macOS-Apple-dSYMs.tar.xz').kind).toBe('other')
    expect(classifyAsset('OBS-Studio-31.0.2-Sources.tar.gz').kind).toBe('other')
  })

  it('separates the installer from the portable archive', () => {
    expect(classifyAsset('OBS-Studio-31.0.2-Windows-x64-Installer.exe').kind).toBe('installer')
  })

  it('treats the Apple disk image as arm64 and the Intel one as x64', () => {
    expect(classifyAsset('OBS-Studio-31.0.2-macOS-Apple.dmg')).toEqual({
      kind: 'disk-image',
      os: 'darwin',
      arch: 'arm64'
    })
    expect(classifyAsset('OBS-Studio-31.0.2-macOS-Intel.dmg')).toEqual({
      kind: 'disk-image',
      os: 'darwin',
      arch: 'x64'
    })
  })

  it('classifies the Ubuntu package as a system package', () => {
    expect(classifyAsset('OBS-Studio-31.0.2-Ubuntu-26.04-x86_64.deb').kind).toBe('package')
  })
})

describe('release parsing', () => {
  const releases = parseReleases(releasePayload())

  it('drops drafts and sorts newest first', () => {
    expect(releases.map((release) => release.version)).toEqual(['31.1.0-rc1', '31.0.2', '30.2.3'])
  })

  it('attaches the published checksum to each asset', () => {
    const zip = releases[1].assets.find((asset) => asset.name.endsWith('Windows-x64.zip'))
    expect(zip?.sha256).toBe('a'.repeat(64))
  })

  it('leaves the checksum null when upstream published none', () => {
    const deb = releases[1].assets.find((asset) => asset.name.endsWith('.deb'))
    expect(deb?.sha256).toBeNull()
  })

  it('rejects a payload that is not a list of releases', () => {
    expect(() => parseReleases('{"message":"Not Found"}')).toThrow(/expected an array/i)
  })
})

describe('asset selection', () => {
  const release = parseReleases(releasePayload())[1]

  it('picks the portable archive matching the architecture on Windows', () => {
    expect(selectAsset(release, 'win32', 'x64')?.name).toBe('OBS-Studio-31.0.2-Windows-x64.zip')
    expect(selectAsset(release, 'win32', 'arm64')?.name).toBe('OBS-Studio-31.0.2-Windows-arm64.zip')
  })

  it('never picks the debug-symbol archive, which is the larger .zip', () => {
    expect(selectAsset(release, 'win32', 'x64')?.name).not.toMatch(/PDBs/)
  })

  it('picks the disk image on macOS', () => {
    expect(selectAsset(release, 'darwin', 'arm64')?.name).toBe('OBS-Studio-31.0.2-macOS-Apple.dmg')
    expect(selectAsset(release, 'darwin', 'x64')?.name).toBe('OBS-Studio-31.0.2-macOS-Intel.dmg')
  })

  it('finds nothing installable on Linux, rather than a Windows build', () => {
    expect(selectAsset(release, 'linux', 'x64')).toBeNull()
  })

  it('returns null for a release with no assets at all', () => {
    const empty: ObsRelease = { ...release, assets: [] }
    expect(selectAsset(empty, 'win32', 'x64')).toBeNull()
  })
})

describe('platform support', () => {
  it('offers downloads on Windows and macOS', () => {
    expect(downloadSupport('win32')).toBeNull()
    expect(downloadSupport('darwin')).toBeNull()
  })

  it('explains, rather than silently failing, on Linux', () => {
    expect(downloadSupport('linux')).toMatch(/package manager|flatpak/i)
  })
})

describe('version comparison', () => {
  it('compares numerically, not lexically', () => {
    expect(compareVersions('31.0.2', '9.9.9')).toBe(1)
    expect(compareVersions('30.2.3', '31.0.0')).toBe(-1)
    expect(compareVersions('31.0.2', '31.0.2')).toBe(0)
  })

  it('treats a missing trailing component as zero', () => {
    expect(compareVersions('31.0', '31.0.0')).toBe(0)
    expect(compareVersions('31.1', '31.0.9')).toBe(1)
  })

  it('sorts a release candidate below its final release', () => {
    expect(compareVersions('31.0.0-rc1', '31.0.0')).toBe(-1)
    expect(compareVersions('31.0.0', '31.0.0-rc1')).toBe(1)
  })

  it('ignores a leading v', () => {
    expect(compareVersions('v31.0.2', '31.0.2')).toBe(0)
  })

  it('treats an unknown current version as upgradable', () => {
    expect(isNewer('31.0.2', null)).toBe(true)
    expect(isNewer('31.0.2', '31.0.2')).toBe(false)
    expect(isNewer('30.0.0', '31.0.2')).toBe(false)
  })
})

describe('latest release', () => {
  const releases = parseReleases(releasePayload())

  it('skips pre-releases by default, so a rig is not offered a candidate', () => {
    expect(latestRelease(releases)?.version).toBe('31.0.2')
  })

  it('offers the pre-release when asked', () => {
    expect(latestRelease(releases, true)?.version).toBe('31.1.0-rc1')
  })

  it('returns null when there is nothing stable', () => {
    expect(latestRelease(releases.filter((release) => release.prerelease))).toBeNull()
  })
})
