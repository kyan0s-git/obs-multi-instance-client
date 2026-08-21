import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import chokidar, { type FSWatcher } from 'chokidar'
import type { HtmlAsset, ObsInstance } from '@shared/types'
import { ensureDir, isFile } from '../util/fsx.js'
import { log, errorMessage } from '../util/logger.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
}

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
    color: params.get('color')
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

/**
 * Loopback-only static file server for the shared HTML/media library.
 *
 * Bound to 127.0.0.1 deliberately: overlays routinely carry lower thirds with
 * names, scores and unpublished content, and there is no reason for them to
 * be reachable from the rest of the network.
 */
export class AssetServer extends EventEmitter {
  private server: http.Server | null = null
  private watcher: FSWatcher | null = null
  private clients = new Set<http.ServerResponse>()
  private root = ''
  private port = 0
  private instancesProvider: () => ObsInstance[] = () => []

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  get isRunning(): boolean {
    return this.server !== null
  }

  setInstancesProvider(provider: () => ObsInstance[]): void {
    this.instancesProvider = provider
  }

  async start(root: string, port: number): Promise<void> {
    await this.stop()
    await ensureDir(root)

    this.root = path.resolve(root)
    this.port = port

    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res))
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        this.server = server
        resolve()
      })
    })

    this.watch()
    log.info('assets', `Serving ${this.root} at ${this.baseUrl}`)
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }
    for (const client of this.clients) client.end()
    this.clients.clear()

    if (this.server) {
      const server = this.server
      this.server = null
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  /** Pushes a reload to every page currently served. */
  broadcastReload(reason = 'manual'): void {
    for (const client of this.clients) {
      client.write(`event: reload\ndata: ${JSON.stringify({ reason, at: Date.now() })}\n\n`)
    }
  }

  /** Public URL for a path relative to the asset root. */
  urlFor(relPath: string): string {
    const normalized = relPath.split(path.sep).join('/')
    return `${this.baseUrl}/${normalized.split('/').map(encodeURIComponent).join('/')}`
  }

  /** Walks the asset root and describes every file the fleet can use. */
  async list(): Promise<HtmlAsset[]> {
    if (this.root === '') return []
    const assets: HtmlAsset[] = []

    const walk = async (dir: string, rel: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const abs = path.join(dir, entry.name)
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`

        if (entry.isDirectory()) {
          await walk(abs, childRel)
          continue
        }
        if (!entry.isFile()) continue

        const stat = await fs.stat(abs)
        assets.push({
          id: childRel,
          name: entry.name,
          relPath: childRel,
          absPath: abs,
          sizeBytes: stat.size,
          modifiedAt: stat.mtimeMs,
          url: this.urlFor(childRel),
          tokens: await readTokens(abs)
        })
      }
    }

    await walk(this.root, '')
    return assets.sort((a, b) => a.relPath.localeCompare(b.relPath))
  }

  private watch(): void {
    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      ignored: /(^|[\\/])\../,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 }
    })

    const onChange = (changed: string): void => {
      log.debug('assets', `Changed: ${path.relative(this.root, changed)}`)
      this.broadcastReload('file-change')
      this.emit('changed')
    }

    this.watcher.on('add', onChange)
    this.watcher.on('change', onChange)
    this.watcher.on('unlink', onChange)
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', this.baseUrl)

      if (url.pathname === '/__fleet/events') return this.handleEvents(res)
      if (url.pathname === '/__fleet/instances.json') return this.handleInstances(res)
      if (url.pathname === '/__fleet/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, root: this.root }))
        return
      }

      const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const target = path.resolve(this.root, relPath === '' ? 'index.html' : relPath)

      // Path traversal guard: anything resolving outside the asset root is
      // refused, so a crafted overlay URL cannot read the operator's disk.
      if (target !== this.root && !target.startsWith(this.root + path.sep)) {
        res.writeHead(403).end('Forbidden')
        return
      }

      if (!(await isFile(target))) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
        return
      }

      const ext = path.extname(target).toLowerCase()
      const type = MIME[ext] ?? 'application/octet-stream'

      const headers: http.OutgoingHttpHeaders = {
        'Content-Type': type,
        // Overlays are edited live; a cached copy is never what anyone wants.
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      }

      if (ext === '.html' || ext === '.htm') {
        const html = await fs.readFile(target, 'utf8')
        const body = injectSnippet(html)
        headers['Content-Length'] = Buffer.byteLength(body)
        res.writeHead(200, headers).end(body)
        return
      }

      const stat = await fs.stat(target)
      headers['Content-Length'] = stat.size
      res.writeHead(200, headers)
      createReadStream(target).pipe(res)
    } catch (err) {
      log.warn('assets', `Request failed: ${errorMessage(err)}`)
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('Internal error')
    }
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
}

/** Places the reload snippet just before `</body>`, or appends it. */
function injectSnippet(html: string): string {
  const closing = html.toLowerCase().lastIndexOf('</body>')
  if (closing === -1) return html + LIVE_RELOAD_SNIPPET
  return html.slice(0, closing) + LIVE_RELOAD_SNIPPET + html.slice(closing)
}

/**
 * Extracts `{{token}}` placeholders so the UI can prompt for their values
 * when pushing an overlay to instances.
 */
async function readTokens(file: string): Promise<string[]> {
  const ext = path.extname(file).toLowerCase()
  if (ext !== '.html' && ext !== '.htm') return []

  try {
    const stat = await fs.stat(file)
    // Guard against scanning a large media file that happens to end in .html.
    if (stat.size > 2 * 1024 * 1024) return []

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
