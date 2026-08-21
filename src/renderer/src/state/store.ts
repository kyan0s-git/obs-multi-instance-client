import { useSyncExternalStore } from 'react'
import type {
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
  logs: [],
  toasts: []
}

const listeners = new Set<() => void>()

function set(patch: Partial<FleetState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
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
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state)
  )
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
    window.fleet.on('preview:frame', (frame) => {
      set({ previews: { ...state.previews, [frame.instanceId]: frame } })
    })
  )

  unsubscribers.push(
    window.fleet.on('assets:changed', (htmlAssets) => {
      set({ htmlAssets })
    })
  )

  unsubscribers.push(
    window.fleet.on('log:entry', (entry) => {
      const merged = [...state.logs, entry]
      set({ logs: merged.length > LOG_WINDOW ? merged.slice(-LOG_WINDOW) : merged })
    })
  )

  const [workspace, runtimes, health, stats, system, logs, htmlAssets] = await Promise.all([
    window.fleet.getState(),
    window.fleet.getRuntimes(),
    window.fleet.getHealth(),
    window.fleet.getAllStatsHistory(),
    window.fleet.getSystemHistory(),
    window.fleet.getLogs(400),
    window.fleet.listHtmlAssets().catch(() => [])
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
    htmlAssets
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
