import { useRef, useSyncExternalStore } from 'react'
import { createSnapshotCache, type SnapshotCache } from './snapshot-cache'
import type {
  DownloadJob,
  HtmlAsset,
  InstanceHealth,
  InstanceRuntime,
  InstanceSnapshot,
  InstanceStats,
  LogEntry,
  PreviewFrame,
  SystemStats,
  WorkspaceState
} from '@shared/types'

export type ToastKind = 'info' | 'success' | 'warn' | 'error'

export interface Toast {
  id: number
  kind: ToastKind
  title: string
  body?: string
}

export interface FleetState {
  ready: boolean
  workspace: WorkspaceState | null
  runtimes: Record<string, InstanceRuntime>
  health: Record<string, InstanceHealth>
  stats: Record<string, InstanceStats[]>
  system: SystemStats[]
  snapshots: Record<string, InstanceSnapshot>
  previews: Record<string, PreviewFrame>
  htmlAssets: HtmlAsset[]
  downloads: DownloadJob[]
  logs: LogEntry[]
  toasts: Toast[]
}

const STATS_WINDOW = 300
const SYSTEM_WINDOW = 300
const LOG_WINDOW = 1200

let state: FleetState = {
  ready: false,
  workspace: null,
  runtimes: {},
  health: {},
  stats: {},
  system: [],
  snapshots: {},
  previews: {},
  htmlAssets: [],
  downloads: [],
  logs: [],
  toasts: []
}

const listeners = new Set<() => void>()
let notifyScheduled = false

/**
 * Applies a patch and schedules a single notification.
 *
 * Telemetry, previews, runtime and log events all land in the same tick, and
 * notifying synchronously on each made React re-render the whole tree several
 * times per frame. Coalescing into one microtask means a burst of events costs
 * one render, and `useSyncExternalStore` still sees a consistent snapshot
 * because `state` is replaced before the notification runs.
 */
function set(patch: Partial<FleetState>): void {
  state = { ...state, ...patch }
  if (notifyScheduled) return

  notifyScheduled = true
  queueMicrotask(() => {
    notifyScheduled = false
    for (const listener of listeners) listener()
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Single global store.
 *
 * A hand-rolled `useSyncExternalStore` store rather than a library: the data
 * arrives as a firehose of IPC events at up to 4 Hz across a dozen instances,
 * and this keeps the merge logic (bounded ring buffers per instance) explicit
 * and in one place.
 */
export function useFleet<T>(selector: (state: FleetState) => T): T {
  // The cache is per component instance, keyed on the identity of the state
  // object the value was derived from. See `createSnapshotCache` for why it
  // cannot be left out.
  const cache = useRef<SnapshotCache<FleetState, T> | null>(null)
  cache.current ??= createSnapshotCache<FleetState, T>()

  const read = (): T => cache.current!.read(state, selector)

  return useSyncExternalStore(subscribe, read, read)
}

export function getState(): FleetState {
  return state
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

let toastId = 1

export function toast(kind: ToastKind, title: string, body?: string): void {
  const entry: Toast = { id: toastId++, kind, title, body }
  set({ toasts: [...state.toasts, entry] })

  // Errors stay long enough to read and copy; the rest clear quickly so the
  // corner of the screen does not become a wall during a bulk operation.
  const ttl = kind === 'error' ? 12_000 : 4500
  setTimeout(() => dismissToast(entry.id), ttl)
}

export function dismissToast(id: number): void {
  set({ toasts: state.toasts.filter((entry) => entry.id !== id) })
}

/** Wraps an async action so a rejected IPC call surfaces as a toast. */
export async function guard<T>(
  label: string,
  action: () => Promise<T>
): Promise<T | undefined> {
  try {
    return await action()
  } catch (err) {
    toast('error', label, err instanceof Error ? err.message : String(err))
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

/** Loads the initial snapshot and subscribes to every live channel. */
export async function initialiseStore(): Promise<() => void> {
  const unsubscribers: Array<() => void> = []

  unsubscribers.push(
    window.fleet.on('workspace:changed', (workspace) => {
      set({ workspace })
      applyTheme(workspace.settings.theme)
    })
  )

  unsubscribers.push(
    window.fleet.on('runtime:changed', (runtimes) => {
      set({ runtimes: keyBy(runtimes, (entry) => entry.id) })
    })
  )

  unsubscribers.push(
    window.fleet.on('health:changed', (health) => {
      set({ health: keyBy(health, (entry) => entry.instanceId) })
    })
  )

  unsubscribers.push(
    window.fleet.on('stats:instance', (samples) => {
      const next = { ...state.stats }
      for (const sample of samples) {
        const bucket = next[sample.instanceId] ?? []
        const merged = [...bucket, sample]
        next[sample.instanceId] = merged.length > STATS_WINDOW ? merged.slice(-STATS_WINDOW) : merged
      }
      set({ stats: next })
    })
  )

  unsubscribers.push(
    window.fleet.on('stats:system', (sample) => {
      const merged = [...state.system, sample]
      set({ system: merged.length > SYSTEM_WINDOW ? merged.slice(-SYSTEM_WINDOW) : merged })
    })
  )

  unsubscribers.push(
    window.fleet.on('snapshot:changed', (snapshotPayload) => {
      set({
        snapshots: { ...state.snapshots, [snapshotPayload.instanceId]: snapshotPayload }
      })
    })
  )

  unsubscribers.push(
    window.fleet.on('preview:frames', (frames) => {
      if (frames.length === 0) return
      // One object rebuild per batch rather than per instance.
      const previews = { ...state.previews }
      for (const frame of frames) previews[frame.instanceId] = frame
      set({ previews })
    })
  )

  unsubscribers.push(
    window.fleet.on('downloads:changed', (downloads) => {
      set({ downloads })
    })
  )

  unsubscribers.push(
    window.fleet.on('assets:changed', (htmlAssets) => {
      set({ htmlAssets })
    })
  )

  // Log lines arrive one per IPC message. Buffering them into a single state
  // update per animation frame keeps a burst from re-rendering the log pane
  // hundreds of times.
  let logBuffer: LogEntry[] = []
  let logFlushScheduled = false

  const flushLogs = (): void => {
    logFlushScheduled = false
    if (logBuffer.length === 0) return
    const merged = [...state.logs, ...logBuffer]
    logBuffer = []
    set({ logs: merged.length > LOG_WINDOW ? merged.slice(-LOG_WINDOW) : merged })
  }

  unsubscribers.push(
    window.fleet.on('log:entry', (entry) => {
      logBuffer.push(entry)
      if (logFlushScheduled) return
      logFlushScheduled = true
      setTimeout(flushLogs, 100)
    })
  )

  const [workspace, runtimes, health, stats, system, logs, htmlAssets, downloads] = await Promise.all([
    window.fleet.getState(),
    window.fleet.getRuntimes(),
    window.fleet.getHealth(),
    window.fleet.getAllStatsHistory(),
    window.fleet.getSystemHistory(),
    window.fleet.getLogs(400),
    window.fleet.listHtmlAssets().catch(() => []),
    // Downloads survive a renderer reload, so the list is fetched rather than
    // assumed empty.
    window.fleet.downloadJobs().catch(() => [])
  ])

  applyTheme(workspace.settings.theme)

  set({
    ready: true,
    workspace,
    runtimes: keyBy(runtimes, (entry) => entry.id),
    health: keyBy(health, (entry) => entry.instanceId),
    stats,
    system,
    logs,
    htmlAssets,
    downloads
  })

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe()
  }
}

/** Pulls a fresh snapshot for one instance into the store. */
export async function refreshSnapshot(instanceId: string): Promise<void> {
  const result = await window.fleet.refreshSnapshot(instanceId)
  if (result) set({ snapshots: { ...state.snapshots, [instanceId]: result } })
}

export function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme
}

function keyBy<T>(items: T[], key: (item: T) => string): Record<string, T> {
  const result: Record<string, T> = {}
  for (const item of items) result[key(item)] = item
  return result
}
