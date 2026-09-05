import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { ensureDir, removeQuiet } from './fsx.js'

/**
 * HTTPS downloads with progress, integrity checking and cancellation.
 *
 * Written against `node:https` rather than a client library because the whole
 * requirement is "fetch one large file to disk, tell me how it is going, and
 * let me stop it". A dependency for that would be larger than the code.
 *
 * The file is streamed to a `.part` and renamed only after the hash checks
 * out, so an interrupted download can never be mistaken for a finished one —
 * which for an OBS install would mean a half-extracted binary that fails at
 * launch with something unhelpful.
 */

export interface DownloadProgress {
  receivedBytes: number
  /** `null` when the server sends no Content-Length. */
  totalBytes: number | null
}

export interface DownloadOptions {
  url: string
  /** Final path. The download lands here only once verified. */
  destination: string
  /** Lowercase hex SHA-256. When given, a mismatch fails the download. */
  sha256?: string | null
  onProgress?: (progress: DownloadProgress) => void
  signal?: AbortSignal
  /** Guards against a redirect loop. */
  maxRedirects?: number
}

export interface DownloadResult {
  path: string
  bytes: number
  sha256: string
}

/** GitHub rejects API requests without one, and it identifies us in their logs. */
export const USER_AGENT = 'OBS-Fleet (+https://github.com/kyan0s-git/obs-multi-instance-client)'

const DEFAULT_MAX_REDIRECTS = 5
/** Progress events are for a human watching a bar, not for a profiler. */
const PROGRESS_INTERVAL_MS = 120

export async function downloadFile(options: DownloadOptions): Promise<DownloadResult> {
  const { destination } = options
  await ensureDir(path.dirname(destination))

  const partial = `${destination}.part`
  await removeQuiet(partial)

  const hash = createHash('sha256')
  let received = 0
  let lastReport = 0

  const response = await openStream(options.url, options.maxRedirects ?? DEFAULT_MAX_REDIRECTS, options.signal)
  const totalBytes = Number(response.headers['content-length']) || null

  response.on('data', (chunk: Buffer) => {
    hash.update(chunk)
    received += chunk.length

    const now = Date.now()
    if (options.onProgress && now - lastReport >= PROGRESS_INTERVAL_MS) {
      lastReport = now
      options.onProgress({ receivedBytes: received, totalBytes })
    }
  })

  try {
    await pipeline(response, fs.createWriteStream(partial), { signal: options.signal })
  } catch (err) {
    await removeQuiet(partial)
    throw err
  }

  const digest = hash.digest('hex')

  if (options.sha256 && digest !== options.sha256.toLowerCase()) {
    await removeQuiet(partial)
    throw new Error(
      `Downloaded file does not match its published checksum. Expected ${options.sha256}, got ${digest}. ` +
        'The download was discarded.'
    )
  }

  await fsp.rename(partial, destination)
  options.onProgress?.({ receivedBytes: received, totalBytes })

  return { path: destination, bytes: received, sha256: digest }
}

/** Fetches a small resource into memory. For API responses, not for installers. */
export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await openStream(url, DEFAULT_MAX_REDIRECTS, signal)
  const chunks: Buffer[] = []
  let bytes = 0

  for await (const chunk of response) {
    bytes += (chunk as Buffer).length
    // A catalogue response should be tens of kilobytes. Anything wildly larger
    // is a sign the URL is wrong, and reading it all would be the mistake.
    if (bytes > MAX_TEXT_BYTES) {
      response.destroy()
      throw new Error(`Response from ${url} exceeded ${MAX_TEXT_BYTES} bytes`)
    }
    chunks.push(chunk as Buffer)
  }

  return Buffer.concat(chunks).toString('utf8')
}

const MAX_TEXT_BYTES = 8 * 1024 * 1024

/**
 * Follows redirects and hands back the response stream.
 *
 * Redirects are followed by hand because release downloads are always a
 * redirect to object storage, and each hop has to be checked: only HTTPS, and
 * a bounded number of them.
 */
function openStream(
  url: string,
  redirectsLeft: number,
  signal?: AbortSignal
): Promise<import('node:http').IncomingMessage> {
  return new Promise((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error(`Not a valid URL: ${url}`))
      return
    }

    // Refusing plain HTTP matters here: this code path writes an executable to
    // disk and then runs it.
    if (parsed.protocol !== 'https:') {
      reject(new Error(`Refusing to download over ${parsed.protocol} — HTTPS only`))
      return
    }

    const request = https.get(
      parsed,
      { headers: { 'user-agent': USER_AGENT, accept: '*/*' }, signal },
      (response) => {
        const status = response.statusCode ?? 0

        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume()
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects fetching ${url}`))
            return
          }
          const next = new URL(response.headers.location, parsed).toString()
          openStream(next, redirectsLeft - 1, signal).then(resolve, reject)
          return
        }

        if (status !== 200) {
          response.resume()
          reject(new Error(`${url} returned HTTP ${status}`))
          return
        }

        resolve(response)
      }
    )

    request.on('error', reject)
  })
}
