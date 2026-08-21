import { EventEmitter } from 'node:events'
import OBSWebSocket, { EventSubscription, type OBSRequestTypes, type OBSResponseTypes } from 'obs-websocket-js'
import type { ObsInstance } from '@shared/types'
import { withTimeout } from '../util/async.js'
import { log, errorMessage } from '../util/logger.js'

/** Backoff schedule for reconnect attempts, in ms. Caps out at 10s. */
const BACKOFF_MS = [500, 1000, 2000, 3000, 5000, 8000, 10_000]

export interface ConnectionStatus {
  instanceId: string
  connected: boolean
  error: string | null
  obsVersion: string | null
  negotiatedRpcVersion: number | null
}

/**
 * One supervised obs-websocket connection.
 *
 * Reconnects on its own with backoff, re-emits every OBS event under a single
 * `obsEvent` channel tagged with the instance id, and refuses to queue calls
 * while disconnected so a caller gets a fast, honest failure instead of a
 * request that silently never lands.
 */
export class ObsConnection extends EventEmitter {
  readonly instanceId: string

  private socket = new OBSWebSocket()
  private url: string
  private password: string
  private connected = false
  private closing = false
  private attempt = 0
  private retryTimer: NodeJS.Timeout | null = null
  private lastError: string | null = null
  private obsVersion: string | null = null
  private rpcVersion: number | null = null

  constructor(instance: ObsInstance) {
    super()
    this.instanceId = instance.id
    this.url = buildUrl(instance)
    this.password = instance.websocket.password
    this.wireSocket()
  }

  get isConnected(): boolean {
    return this.connected
  }

  get status(): ConnectionStatus {
    return {
      instanceId: this.instanceId,
      connected: this.connected,
      error: this.lastError,
      obsVersion: this.obsVersion,
      negotiatedRpcVersion: this.rpcVersion
    }
  }

  /** Applies a changed port/password without dropping a healthy connection. */
  reconfigure(instance: ObsInstance): void {
    const url = buildUrl(instance)
    if (url === this.url && instance.websocket.password === this.password) return
    this.url = url
    this.password = instance.websocket.password
    log.info('ws', 'Endpoint changed; reconnecting', this.instanceId)
    void this.reconnectNow()
  }

  /**
   * Begins connecting and keeps retrying until {@link stop} is called.
   * Resolves as soon as the first attempt settles, successful or not.
   */
  async start(): Promise<void> {
    this.closing = false
    await this.tryConnect()
  }

  async stop(): Promise<void> {
    this.closing = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.connected) {
      await this.socket.disconnect().catch(() => undefined)
    }
    this.connected = false
  }

  /** Issues a request, failing fast when the socket is down. */
  async call<T extends keyof OBSRequestTypes>(
    request: T,
    payload?: OBSRequestTypes[T],
    timeoutMs = 10_000
  ): Promise<OBSResponseTypes[T]> {
    if (!this.connected) {
      throw new Error(`Not connected to OBS (${this.instanceId})`)
    }
    return withTimeout(
      this.socket.call(request, payload),
      timeoutMs,
      `OBS request ${String(request)} timed out after ${timeoutMs}ms`
    )
  }

  /** Batched request, used by telemetry to keep one round trip per tick. */
  async callBatch(
    requests: Array<{ requestType: keyof OBSRequestTypes; requestData?: Record<string, unknown> }>,
    timeoutMs = 10_000
  ): Promise<Array<{ requestType: string; requestStatus: { result: boolean; code: number }; responseData?: Record<string, unknown> }>> {
    if (!this.connected) {
      throw new Error(`Not connected to OBS (${this.instanceId})`)
    }
    const response = await withTimeout(
      // The library's batch typing is per-request-type; our callers are
      // dynamic, so the shape is narrowed at the call site instead.
      this.socket.callBatch(requests as never),
      timeoutMs,
      `OBS batch request timed out after ${timeoutMs}ms`
    )
    return response as never
  }

  private wireSocket(): void {
    this.socket.on('ConnectionClosed', (err) => {
      const wasConnected = this.connected
      this.connected = false
      if (this.closing) return
      this.lastError = err ? errorMessage(err) : 'Connection closed'
      if (wasConnected) {
        log.warn('ws', `Disconnected: ${this.lastError}`, this.instanceId)
      }
      this.emit('status', this.status)
      this.scheduleRetry()
    })

    this.socket.on('ConnectionError', (err) => {
      this.lastError = errorMessage(err)
      this.emit('status', this.status)
    })

    // Fan every OBS event out under one channel so the pool can route by id
    // without registering ~60 individual listeners per instance.
    const forward = (eventType: string) => (data: unknown) => {
      this.emit('obsEvent', { instanceId: this.instanceId, eventType, data })
    }
    for (const eventType of FORWARDED_EVENTS) {
      this.socket.on(eventType as never, forward(eventType) as never)
    }
  }

  private async tryConnect(): Promise<void> {
    if (this.closing || this.connected) return

    try {
      const hello = await withTimeout(
        this.socket.connect(this.url, this.password || undefined, {
          // Subscribing to everything except the high-volume input-volume
          // meters, which would flood IPC for no benefit at 1Hz sampling.
          eventSubscriptions:
            EventSubscription.All & ~EventSubscription.InputVolumeMeters
        }),
        8000,
        'Handshake timed out'
      )

      this.connected = true
      this.attempt = 0
      this.lastError = null
      this.obsVersion = hello.obsWebSocketVersion ?? null
      this.rpcVersion = hello.negotiatedRpcVersion ?? null

      log.info(
        'ws',
        `Connected to ${this.url} (obs-websocket ${this.obsVersion ?? '?'})`,
        this.instanceId
      )
      this.emit('status', this.status)
      this.emit('connected', this.status)
    } catch (err) {
      this.connected = false
      this.lastError = errorMessage(err)
      this.emit('status', this.status)
      this.scheduleRetry()
    }
  }

  private scheduleRetry(): void {
    if (this.closing || this.retryTimer) return
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]
    this.attempt += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.tryConnect()
    }, delay)
  }

  /** Drops any current connection and restarts the attempt loop immediately. */
  private async reconnectNow(): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.connected) await this.socket.disconnect().catch(() => undefined)
    this.connected = false
    this.attempt = 0
    await this.tryConnect()
  }
}

function buildUrl(instance: ObsInstance): string {
  return `ws://127.0.0.1:${instance.websocket.port}`
}

/**
 * The OBS events the client acts on. Kept explicit rather than wildcarded so
 * a new obs-websocket release cannot start pushing unexpected traffic through
 * the IPC bridge.
 */
const FORWARDED_EVENTS = [
  'CurrentProgramSceneChanged',
  'CurrentPreviewSceneChanged',
  'SceneListChanged',
  'SceneCreated',
  'SceneRemoved',
  'SceneNameChanged',
  'StudioModeStateChanged',
  'SceneItemCreated',
  'SceneItemRemoved',
  'SceneItemListReindexed',
  'SceneItemEnableStateChanged',
  'SceneItemLockStateChanged',
  'InputCreated',
  'InputRemoved',
  'InputNameChanged',
  'InputMuteStateChanged',
  'InputVolumeChanged',
  'InputActiveStateChanged',
  'StreamStateChanged',
  'RecordStateChanged',
  'ReplayBufferStateChanged',
  'VirtualcamStateChanged',
  'CurrentProfileChanged',
  'ProfileListChanged',
  'CurrentSceneCollectionChanged',
  'SceneCollectionListChanged',
  'CurrentSceneTransitionChanged',
  'ExitStarted',
  'MediaInputPlaybackStarted',
  'MediaInputPlaybackEnded',
  'VendorEvent'
] as const

export type ForwardedEvent = (typeof FORWARDED_EVENTS)[number]
