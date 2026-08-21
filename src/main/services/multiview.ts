import { EventEmitter } from 'node:events'
import type { MultiviewSettings, PreviewFrame } from '@shared/types'
import { mapLimit } from '../util/async.js'
import { errorMessage } from '../util/logger.js'
import { captureScene } from './obs-control.js'
import type { ObsPool } from './obs-pool.js'

/**
 * Polls a thumbnail of each instance's program output.
 *
 * This is the "watch every instance at once" surface that works regardless of
 * where the OBS windows are — on another monitor, minimised, or behind the
 * client. It is a poll rather than a stream because obs-websocket has no
 * video transport; the cost of that choice is why the frame rate defaults to
 * a deliberately low 2 fps and the long edge to 480px.
 */
export class Multiview extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private settings: MultiviewSettings = { enabled: false, fps: 2, quality: 480, source: 'program' }
  private capturing = false
  /** Instances the UI is currently showing; empty means "all connected". */
  private visible: string[] | null = null
  private sceneNames = new Map<string, { program: string | null; preview: string | null }>()

  constructor(private readonly pool: ObsPool) {
    super()
  }

  configure(settings: MultiviewSettings): void {
    this.settings = { ...settings }
    if (settings.enabled) this.start()
    else this.stop()
  }

  /**
   * Restricts capture to the instances actually on screen. Polling a hidden
   * tile costs an encode in OBS for a frame nobody looks at.
   */
  setVisible(instanceIds: string[] | null): void {
    this.visible = instanceIds
  }

  /** Keeps the scene names used as screenshot handles in sync with OBS events. */
  setScenes(instanceId: string, program: string | null, preview: string | null): void {
    this.sceneNames.set(instanceId, { program, preview })
  }

  forget(instanceId: string): void {
    this.sceneNames.delete(instanceId)
  }

  start(): void {
    this.stop()
    if (!this.settings.enabled) return
    const intervalMs = Math.max(100, Math.round(1000 / Math.max(0.2, this.settings.fps)))
    this.timer = setInterval(() => void this.tick(), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Captures one instance immediately, for a manual refresh. */
  async captureOnce(instanceId: string): Promise<PreviewFrame> {
    return this.capture(instanceId)
  }

  private async tick(): Promise<void> {
    // Screenshot requests are synchronous inside OBS's render loop; letting
    // ticks overlap would multiply that cost during a slow frame.
    if (this.capturing) return
    this.capturing = true

    try {
      const candidates = this.pool.connectedIds()
      const targets =
        this.visible === null ? candidates : candidates.filter((id) => this.visible!.includes(id))
      if (targets.length === 0) return

      // Four at a time keeps a large fleet from stalling on one slow instance.
      const frames = await mapLimit(targets, 4, (id) => this.capture(id))
      for (const frame of frames) this.emit('frame', frame)
    } finally {
      this.capturing = false
    }
  }

  private async capture(instanceId: string): Promise<PreviewFrame> {
    const at = Date.now()
    const connection = this.pool.get(instanceId)

    if (!connection?.isConnected) {
      return { instanceId, at, dataUri: null, error: 'Not connected' }
    }

    const scenes = this.sceneNames.get(instanceId)
    const sceneName =
      this.settings.source === 'preview' ? scenes?.preview ?? scenes?.program : scenes?.program

    if (!sceneName) {
      return { instanceId, at, dataUri: null, error: 'No active scene' }
    }

    try {
      const dataUri = await captureScene(connection, sceneName, this.settings.quality)
      return { instanceId, at, dataUri, error: null }
    } catch (err) {
      return { instanceId, at, dataUri: null, error: errorMessage(err) }
    }
  }
}
