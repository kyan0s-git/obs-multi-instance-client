import { EventEmitter } from 'node:events'
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import chokidar, { type FSWatcher } from 'chokidar'
import type { AssetKind, AssetMount, AssetMountStatus, HtmlAsset, ObsInstance } from '@shared/types'
import { debounce } from '../util/async.js'
import { ensureDir } from '../util/fsx.js'
import { log, errorMessage } from '../util/logger.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
}

const KIND_BY_EXT: Record<string, AssetKind> = {
  '.html': 'html',
  '.htm': 'html',
  '.js': 'script',
  '.mjs': 'script',
  '.css': 'script',
  '.json': 'script',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.avif': 'image',
  '.svg': 'image',
  '.bmp': 'image',
  '.mp4': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.mkv': 'video',
  '.mp3': 'audio',
  '.ogg': 'audio',
  '.oga': 'audio',
  '.wav': 'audio',
  '.flac': 'audio',
  '.m4a': 'audio',
  '.aac': 'audio',
  '.woff': 'font',
  '.woff2': 'font',
  '.ttf': 'font',
  '.otf': 'font'
}

/** Id of the mount backed by the workspace's own `assets/` folder. */
export const WORKSPACE_MOUNT_ID = 'workspace'

/**
 * Cap on files listed per mount.
 *
 * A pointed-at media library can hold tens of thousands of files. The list is
 * for picking things in the UI, not for indexing a NAS, and an unbounded walk
 * would stall the main process on every change.
 */
const MAX_FILES_PER_MOUNT = 4000

/** Largest HTML file that gets scanned for `{{token}}` placeholders. */
const MAX_TOKEN_SCAN_BYTES = 2 * 1024 * 1024

/**
 * Snippet injected into every served HTML page.
 *
 * Serving overlays over http instead of `file://` is what makes browser
 * sources across instances practical: query strings work, so one file can
 * render per-instance content, and CEF's local-file restrictions do not
 * apply. Live reload on top of that means an operator edits an overlay and
 * every instance showing it updates without touching OBS.
 */
const LIVE_RELOAD_SNIPPET = `
<script>
(function () {
  if (window.__obsFleetLiveReload) return;
  window.__obsFleetLiveReload = true;

  var params = new URLSearchParams(location.search);
  window.OBSFleet = {
    instance: params.get('instance'),
    instanceId: params.get('instanceId'),
    role: params.get('role'),
    color: params.get('color'),
    asset: function (mountAndPath) {
      // Resolves "mountId:some/file.png" to a served URL.
      var parts = String(mountAndPath).split(':');
      if (parts.length < 2) return mountAndPath;
      var mount = parts.shift();
      var rest = parts.join(':');
      return (mount === 'workspace' ? '/' : '/m/' + mount + '/') +
        rest.split('/').map(encodeURIComponent).join('/');
    }
  };

  var retry = 1000;
  function connect() {
    var source = new EventSource('/__fleet/events');
    source.addEventListener('open', function () { retry = 1000; });
    source.addEventListener('reload', function () { location.reload(); });
    source.addEventListener('error', function () {
      source.close();
      // The client may be restarting; keep trying with a soft backoff so an
      // overlay left on air recovers by itself.
      retry = Math.min(retry * 2, 15000);
      setTimeout(connect, retry);
    });
  }
  connect();
})();
</script>
`

interface MountState {
  mount: AssetMount
  /** Resolved, normalised root used for the traversal guard. */
  root: string
  watcher: FSWatcher | null
  /** Cached listing; null means "not built yet or invalidated". */
  cache: HtmlAsset[] | null
  error: string | null
  truncated: boolean
}

/**
 * Loopback-only static file server publishing one or more folders to every
 * instance.
 *
 * Bound to 127.0.0.1 deliberately: overlays routinely carry lower thirds with
 * names, scores and unpublished content, and there is no reason for them to
 * be reachable from the rest of the network.
 */
export class AssetServer extends EventEmitter {
  private server: http.Server | null = null
  private clients = new Set<http.ServerResponse>()
  private mounts = new Map<string, MountState>()
  private port = 0
  private instancesProvider: () => ObsInstance[] = () => []

  /** Coalesces bursts of filesystem events into a single reload + notify. */
  private notifyChanged = debounce(() => {
    this.broadcastReload('file-change')
    this.emit('changed')
  }, 250)

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  get isRunning(): boolean {
    return this.server !== null
  }

  setInstancesProvider(provider: () => ObsInstance[]): void {
    this.instancesProvider = provider
  }

  /**
   * Starts the server. `workspaceAssets` is always mounted at the root;
   * `extraMounts` are published under `/m/<id>/`.
   */
  async start(workspaceAssets: string, port: number, extraMounts: AssetMount[]): Promise<void> {
    await this.stop()
    await ensureDir(workspaceAssets)
    this.port = port

    await this.setMounts(workspaceAssets, extraMounts)

    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res))
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        this.server = server
        resolve()
      })
    })

    log.info(
      'assets',
      `Serving ${this.mounts.size} mount(s) at ${this.baseUrl} (root: ${workspaceAssets})`
    )
  }

  async stop(): Promise<void> {
    this.notifyChanged.cancel()

    for (const state of this.mounts.values()) {
      if (state.watcher) await state.watcher.close().catch(() => undefined)
    }
    this.mounts.clear()

    for (const client of this.clients) client.end()
    this.clients.clear()

    if (this.server) {
      const server = this.server
      this.server = null
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  /**
   * Reconciles the mount table without restarting the server, so adding a
   * folder does not interrupt overlays that are currently on air.
   */
  async setMounts(workspaceAssets: string, extraMounts: AssetMount[]): Promise<void> {
    const wanted: AssetMount[] = [
      {
        id: WORKSPACE_MOUNT_ID,
        name: 'Workspace assets',
        path: workspaceAssets,
        enabled: true,
        // The workspace folder is where overlays are actively edited, so it
        // is always watched for live reload.
        watch: true,
        builtIn: true
      },
      ...extraMounts.filter((mount) => mount.id !== WORKSPACE_MOUNT_ID)
    ]

    const wantedIds = new Set(wanted.map((mount) => mount.id))
    for (const [id, state] of this.mounts) {
      if (wantedIds.has(id)) continue
      if (state.watcher) await state.watcher.close().catch(() => undefined)
      this.mounts.delete(id)
    }

    for (const mount of wanted) {
      const existing = this.mounts.get(mount.id)
      const root = path.resolve(mount.path)

      // Nothing structural changed — keep the warm cache and live watcher.
      if (
        existing &&
        existing.root === root &&
        existing.mount.enabled === mount.enabled &&
        existing.mount.watch === mount.watch
      ) {
        existing.mount = mount
        continue
      }

      if (existing?.watcher) await existing.watcher.close().catch(() => undefined)

      const state: MountState = {
        mount,
        root,
        watcher: null,
        cache: null,
        error: null,
        truncated: false
      }

      if (mount.enabled) {
        try {
          const stat = await fs.stat(root)
          if (!stat.isDirectory()) state.error = 'Not a directory'
        } catch (err) {
          state.error = errorMessage(err)
        }
        if (!state.error && mount.watch) state.watcher = this.watch(state)
      }

      this.mounts.set(mount.id, state)
    }

    this.emit('changed')
  }

  /** Pushes a reload to every page currently served. */
  broadcastReload(reason = 'manual'): void {
    const frame = `event: reload\ndata: ${JSON.stringify({ reason, at: Date.now() })}\n\n`
    for (const client of this.clients) client.write(frame)
  }

  /** Public URL for a path relative to a mount. */
  urlFor(mountId: string, relPath: string): string {
    const encoded = relPath
      .split(path.sep)
      .join('/')
      .split('/')
      .map(encodeURIComponent)
      .join('/')
    const prefix = mountId === WORKSPACE_MOUNT_ID ? '' : `/m/${encodeURIComponent(mountId)}`
    return `${this.baseUrl}${prefix}/${encoded}`
  }

  mountStatuses(): AssetMountStatus[] {
    return [...this.mounts.values()].map((state) => {
      const files = state.cache ?? []
      return {
        id: state.mount.id,
        name: state.mount.name,
        path: state.mount.path,
        enabled: state.mount.enabled,
        watch: state.mount.watch,
        builtIn: state.mount.builtIn,
        error: state.error,
        fileCount: files.length,
        totalBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
        truncated: state.truncated,
        urlPrefix:
          state.mount.id === WORKSPACE_MOUNT_ID ? '/' : `/m/${encodeURIComponent(state.mount.id)}/`
      }
    })
  }

  /**
   * Lists every published file across all mounts.
   *
   * Results are cached per mount and only rebuilt when that mount's watcher
   * fires, so opening the assets page repeatedly costs nothing.
   */
  async list(): Promise<HtmlAsset[]> {
    const all: HtmlAsset[] = []
    for (const state of this.mounts.values()) {
      if (!state.mount.enabled || state.error) continue
      all.push(...(await this.listMount(state)))
    }
    return all
  }

  private async listMount(state: MountState): Promise<HtmlAsset[]> {
    if (state.cache) return state.cache

    const assets: HtmlAsset[] = []
    let truncated = false

    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (assets.length >= MAX_FILES_PER_MOUNT || depth > 12) {
        truncated = truncated || assets.length >= MAX_FILES_PER_MOUNT
        return
      }

      let entries: Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        if (assets.length >= MAX_FILES_PER_MOUNT) {
          truncated = true
          return
        }
        // Skip dotfiles and the usual heavy noise directories outright.
        if (entry.name.startsWith('.')) continue
        if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue

        const abs = path.join(dir, entry.name)
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`

        if (entry.isDirectory()) {
          await walk(abs, childRel, depth + 1)
          continue
        }
        if (!entry.isFile()) continue

        let stat
        try {
          stat = await fs.stat(abs)
        } catch {
          continue
        }

        const kind = kindFor(entry.name)
        assets.push({
          id: `${state.mount.id}:${childRel}`,
          name: entry.name,
          mountId: state.mount.id,
          relPath: childRel,
          absPath: abs,
          sizeBytes: stat.size,
          modifiedAt: stat.mtimeMs,
          url: this.urlFor(state.mount.id, childRel),
          kind,
          // Only HTML has placeholders, and only small HTML is worth reading.
          tokens:
            kind === 'html' && stat.size <= MAX_TOKEN_SCAN_BYTES ? await readTokens(abs) : []
        })
      }
    }

    await walk(state.root, '', 0)
    assets.sort((a, b) => a.relPath.localeCompare(b.relPath))

    state.cache = assets
    state.truncated = truncated
    return assets
  }

  private watch(state: MountState): FSWatcher {
    const watcher = chokidar.watch(state.root, {
      ignoreInitial: true,
      ignored: /(^|[\\/])\../,
      // Depth-limited so pointing at a deep tree cannot exhaust file handles.
      depth: 12,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 }
    })

    const onChange = (): void => {
      // Drop the cache and let the next list() rebuild it; rebuilding eagerly
      // on every event would thrash during a bulk copy into the folder.
      state.cache = null
      this.notifyChanged()
    }

    watcher.on('add', onChange)
    watcher.on('change', onChange)
    watcher.on('unlink', onChange)
    watcher.on('addDir', onChange)
    watcher.on('unlinkDir', onChange)
    watcher.on('error', (err) =>
      log.warn('assets', `Watcher error on ${state.mount.name}: ${errorMessage(err)}`)
    )

    return watcher
  }

  /** Invalidates every cached listing, e.g. after an import. */
  invalidate(): void {
    for (const state of this.mounts.values()) state.cache = null
    this.emit('changed')
  }

  /* ---------------- request handling ---------------- */

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', this.baseUrl)

      if (url.pathname === '/__fleet/events') return this.handleEvents(res)
      if (url.pathname === '/__fleet/instances.json') return this.handleInstances(res)
      if (url.pathname === '/__fleet/mounts.json') return this.handleMounts(res)
      if (url.pathname === '/__fleet/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, mounts: this.mounts.size }))
        return
      }

      const resolved = this.resolveRequest(url.pathname)
      if (!resolved) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
        return
      }

      let stat
      try {
        stat = await fs.stat(resolved.file)
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
        return
      }
      if (!stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
        return
      }

      const ext = path.extname(resolved.file).toLowerCase()
      const type = MIME[ext] ?? 'application/octet-stream'

      // HTML is rewritten to carry the fleet bridge, so it is never ranged.
      if (ext === '.html' || ext === '.htm') {
        const body = injectSnippet(await fs.readFile(resolved.file, 'utf8'))
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Access-Control-Allow-Origin': '*'
        })
        res.end(body)
        return
      }

      return this.sendFile(req, res, resolved.file, type, stat.size, stat.mtimeMs)
    } catch (err) {
      log.warn('assets', `Request failed: ${errorMessage(err)}`)
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('Internal error')
    }
  }

  /**
   * Serves a static file, honouring HTTP Range.
   *
   * Range matters: OBS's media source seeks by requesting byte ranges, and
   * without it a scrub restarts the whole transfer from zero. Media also gets
   * a real cache policy, unlike overlays, because a 2 GB sting does not
   * change between scene activations.
   */
  private sendFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    file: string,
    type: string,
    size: number,
    mtimeMs: number
  ): void {
    const etag = `W/"${size.toString(16)}-${Math.round(mtimeMs).toString(16)}"`
    const cacheable = type.startsWith('video/') || type.startsWith('audio/') || type.startsWith('image/') || type.startsWith('font/')

    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': cacheable ? 'public, max-age=60' : 'no-store'
    }

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers).end()
      return
    }

    const range = parseRange(req.headers.range, size)

    if (range === 'invalid') {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end()
      return
    }

    if (range) {
      const length = range.end - range.start + 1
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': length
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(file, { start: range.start, end: range.end }).pipe(res)
      return
    }

    res.writeHead(200, { ...headers, 'Content-Length': size })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(file).pipe(res)
  }

  /**
   * Maps a request path to a file inside a mount, refusing anything that
   * escapes the mount root.
   */
  private resolveRequest(pathname: string): { mountId: string; file: string } | null {
    let mountId = WORKSPACE_MOUNT_ID
    let rest = pathname

    if (pathname.startsWith('/m/')) {
      const withoutPrefix = pathname.slice(3)
      const slash = withoutPrefix.indexOf('/')
      if (slash === -1) return null
      mountId = decodeURIComponent(withoutPrefix.slice(0, slash))
      rest = withoutPrefix.slice(slash)
    }

    const state = this.mounts.get(mountId)
    if (!state || !state.mount.enabled || state.error) return null

    let relPath: string
    try {
      relPath = decodeURIComponent(rest).replace(/^\/+/, '')
    } catch {
      return null
    }
    // A NUL byte can truncate a path inside a syscall.
    if (relPath.includes('\0')) return null

    const file = path.resolve(state.root, relPath === '' ? 'index.html' : relPath)

    // Traversal guard: anything resolving outside the mount root is refused,
    // so a crafted overlay URL cannot read the operator's disk.
    if (file !== state.root && !file.startsWith(state.root + path.sep)) return null

    return { mountId, file }
  }

  private handleEvents(res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    })
    res.write('retry: 2000\n\n')
    this.clients.add(res)

    // CEF drops an idle SSE connection; a comment frame every 20s keeps it up.
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000)
    res.on('close', () => {
      clearInterval(keepAlive)
      this.clients.delete(res)
    })
  }

  /**
   * Lets an overlay discover the fleet it belongs to, so a single page can
   * render (say) a tally wall for every instance without being told about
   * them at build time.
   */
  private handleInstances(res: http.ServerResponse): void {
    const instances = this.instancesProvider().map((instance) => ({
      id: instance.id,
      name: instance.name,
      role: instance.role,
      color: instance.color
    }))
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    })
    res.end(JSON.stringify({ instances }))
  }

  /** Lets an overlay resolve media paths without hardcoding mount prefixes. */
  private handleMounts(res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    })
    res.end(
      JSON.stringify({
        mounts: this.mountStatuses().map((status) => ({
          id: status.id,
          name: status.name,
          urlPrefix: status.urlPrefix
        }))
      })
    )
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Directories never worth walking in a media library. */
const IGNORED_DIRS = new Set(['node_modules', '.git', '__MACOSX', 'System Volume Information'])

export function kindFor(fileName: string): AssetKind {
  return KIND_BY_EXT[path.extname(fileName).toLowerCase()] ?? 'other'
}

/** Places the reload snippet just before `</body>`, or appends it. */
function injectSnippet(html: string): string {
  const closing = html.toLowerCase().lastIndexOf('</body>')
  if (closing === -1) return html + LIVE_RELOAD_SNIPPET
  return html.slice(0, closing) + LIVE_RELOAD_SNIPPET + html.slice(closing)
}

/**
 * Parses a single-range `Range` header.
 *
 * Multi-range requests are deliberately unsupported — no media player issues
 * them, and answering with `200 OK` for the whole file is a legal response.
 */
export function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | null | 'invalid' {
  if (!header) return null

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return 'invalid'

  let start: number
  let end: number

  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid'
    end = Math.min(end, size - 1)
  }

  if (start > end || start >= size || start < 0) return 'invalid'
  return { start, end }
}

/**
 * Extracts `{{token}}` placeholders so the UI can prompt for their values
 * when pushing an overlay to instances.
 */
async function readTokens(file: string): Promise<string[]> {
  try {
    const text = await fs.readFile(file, 'utf8')
    const tokens = new Set<string>()
    for (const match of text.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) {
      tokens.add(match[1])
    }
    return [...tokens].sort()
  } catch {
    return []
  }
}
