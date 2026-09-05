import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { DownloadJob, ObsInstall, ObsRelease, ObsReleaseAsset } from '@shared/types'
import { downloadFile, fetchText } from '../util/download.js'
import { extractZipFile } from '../util/zip-extract.js'
import { ensureDir, pathExists, removeQuiet } from '../util/fsx.js'
import { log, errorMessage } from '../util/logger.js'
import { OBS_RELEASES_URL, downloadSupport, parseReleases, selectAsset } from './obs-catalog.js'
import { layoutFor } from './obs-install.js'
import { workspacePaths } from './paths.js'

const run = promisify(execFile)
const platform = process.platform as NodeJS.Platform

/**
 * Downloads OBS Studio and turns it into an install this application manages.
 *
 * The point of this is the same as a Minecraft launcher's version list: a
 * production machine should be able to hold several OBS versions at once and
 * pin an instance to one of them, without any of them being "the system
 * install" that an upgrade silently changes underneath a show.
 *
 * Downloads land in the workspace, never in a system directory, so nothing
 * here needs administrator rights.
 */
export class ObsDownloader extends EventEmitter {
  private readonly jobs = new Map<string, DownloadJob>()
  private readonly controllers = new Map<string, AbortController>()
  private cachedReleases: { at: number; releases: ObsRelease[] } | null = null

  constructor(private readonly workspaceRoot: () => string) {
    super()
  }

  /* ---------------- catalogue ---------------- */

  /**
   * The release list, cached briefly.
   *
   * The catalogue changes a few times a year; refetching it on every visit to
   * the page would be rude to a public API for no benefit.
   */
  async releases(force = false): Promise<ObsRelease[]> {
    const fresh = this.cachedReleases && Date.now() - this.cachedReleases.at < CATALOG_TTL_MS
    if (fresh && !force) return this.cachedReleases!.releases

    const body = await fetchText(OBS_RELEASES_URL)
    const releases = parseReleases(body)
    this.cachedReleases = { at: Date.now(), releases }
    return releases
  }

  /* ---------------- jobs ---------------- */

  listJobs(): DownloadJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  cancel(jobId: string): void {
    this.controllers.get(jobId)?.abort()
  }

  /** Forgets finished jobs so the list does not grow for the whole session. */
  clearFinished(): void {
    for (const [id, job] of this.jobs) {
      if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') {
        this.jobs.delete(id)
        this.controllers.delete(id)
      }
    }
    this.publish()
  }

  private update(job: DownloadJob, patch: Partial<DownloadJob>): void {
    Object.assign(job, patch)
    this.publish()
  }

  private publish(): void {
    this.emit('jobs', this.listJobs())
  }

  /* ---------------- install ---------------- */

  /**
   * Downloads a release and returns an install ready to be registered.
   *
   * The work happens in a temporary folder and is moved into place only once
   * the archive has been verified and unpacked, so an interrupted download
   * cannot leave a half-install that looks usable.
   */
  async install(version: string, label?: string): Promise<ObsInstall> {
    const unsupported = downloadSupport(platform as never)
    if (unsupported) throw new Error(unsupported)

    const releases = await this.releases()
    const release = releases.find((entry) => entry.version === version)
    if (!release) throw new Error(`OBS ${version} is not in the release list`)

    const asset = selectAsset(release, platform as never, process.arch)
    if (!asset) {
      throw new Error(`OBS ${version} has no downloadable build for ${platform}/${process.arch}`)
    }

    const paths = workspacePaths(this.workspaceRoot())
    const target = path.join(paths.runtimes, safeVersionFolder(version))

    if (await pathExists(target)) {
      throw new Error(`OBS ${version} is already installed at ${target}`)
    }

    const job: DownloadJob = {
      id: randomUUID(),
      kind: 'obs',
      label: label ?? `OBS Studio ${version}`,
      state: 'queued',
      receivedBytes: 0,
      totalBytes: asset.sizeBytes || null,
      detail: 'Starting',
      error: null,
      startedAt: Date.now(),
      finishedAt: null
    }
    this.jobs.set(job.id, job)

    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    this.publish()

    const staging = path.join(paths.downloads, job.id)
    const archive = path.join(staging, asset.name)

    try {
      await ensureDir(staging)

      this.update(job, {
        state: 'downloading',
        detail: asset.sha256 ? 'Downloading and verifying' : 'Downloading'
      })

      await downloadFile({
        url: asset.downloadUrl,
        destination: archive,
        sha256: asset.sha256,
        signal: controller.signal,
        onProgress: ({ receivedBytes, totalBytes }) =>
          this.update(job, { receivedBytes, totalBytes: totalBytes ?? job.totalBytes })
      })

      if (!asset.sha256) {
        log.warn(
          'obs',
          `${asset.name} had no published checksum, so its contents could not be verified`
        )
      }

      this.update(job, { state: 'extracting', detail: 'Unpacking' })
      const unpacked = path.join(staging, 'unpacked')
      await this.unpack(asset, archive, unpacked, controller.signal)

      await ensureDir(paths.runtimes)
      await fsp.rename(unpacked, target)

      const layout = layoutFor()
      const install: ObsInstall = {
        id: randomUUID(),
        label: label ?? `OBS Studio ${version}`,
        root: target,
        executable: path.join(target, layout.executableRel),
        version,
        detected: false,
        managed: true,
        problems: []
      }

      this.update(job, {
        state: 'done',
        detail: `Installed to ${target}`,
        finishedAt: Date.now()
      })
      log.info('obs', `Installed OBS ${version} to ${target}`)

      return install
    } catch (err) {
      const cancelled = controller.signal.aborted
      this.update(job, {
        state: cancelled ? 'cancelled' : 'failed',
        detail: cancelled ? 'Cancelled' : 'Failed',
        error: cancelled ? null : errorMessage(err),
        finishedAt: Date.now()
      })
      await removeQuiet(target)
      throw err
    } finally {
      await removeQuiet(staging)
      this.controllers.delete(job.id)
    }
  }

  /**
   * Unpacks whichever shape upstream ships for this platform.
   *
   * Windows is a plain archive wrapped in one version-named folder. macOS is a
   * disk image, which has to be mounted and the bundle copied out; `hdiutil`
   * is part of macOS, so this adds no dependency.
   */
  private async unpack(
    asset: ObsReleaseAsset,
    archive: string,
    destination: string,
    signal: AbortSignal
  ): Promise<void> {
    if (asset.kind === 'portable-archive') {
      await extractZipFile(archive, destination, { stripComponents: 0, signal })
      await flattenSingleWrapper(destination)
      return
    }

    if (asset.kind === 'disk-image') {
      const mount = `${archive}.mount`
      await ensureDir(mount)
      // `-nobrowse` keeps it out of Finder; `-readonly` because we only copy.
      await run('hdiutil', ['attach', archive, '-mountpoint', mount, '-nobrowse', '-readonly'])
      try {
        const entries = await fsp.readdir(mount)
        const app = entries.find((entry) => entry.endsWith('.app'))
        if (!app) throw new Error('The disk image contains no .app bundle')
        await ensureDir(path.dirname(destination))
        await run('cp', ['-R', path.join(mount, app), destination])
      } finally {
        await run('hdiutil', ['detach', mount, '-force']).catch(() => undefined)
        await removeQuiet(mount)
      }
      return
    }

    throw new Error(`Cannot unpack ${asset.name}: unsupported asset kind "${asset.kind}"`)
  }
}

/** Release archives are cached this long before the list is refetched. */
const CATALOG_TTL_MS = 10 * 60 * 1000

/**
 * Removes a single wrapping folder if the archive has one.
 *
 * Upstream has changed whether the Windows zip is wrapped between releases, so
 * this is decided by looking rather than by assuming a fixed strip depth.
 */
async function flattenSingleWrapper(root: string): Promise<void> {
  const entries = await fsp.readdir(root, { withFileTypes: true })
  if (entries.length !== 1 || !entries[0].isDirectory()) return

  const inner = path.join(root, entries[0].name)
  // A real OBS root has bin/ beside data/; a wrapper has them one level down.
  const looksLikeRoot = await pathExists(path.join(inner, 'bin'))
  if (!looksLikeRoot) return

  for (const entry of await fsp.readdir(inner)) {
    await fsp.rename(path.join(inner, entry), path.join(root, entry))
  }
  await removeQuiet(inner)
}

/** Folder name for a version, safe on every filesystem. */
export function safeVersionFolder(version: string): string {
  const cleaned = version.trim().replace(/[^A-Za-z0-9.\-_]/g, '-')
  return cleaned.length > 0 ? cleaned : 'unknown'
}
