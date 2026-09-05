import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import type { BulkAction, ObsInstance } from '@shared/types'
import {
  BrandMark,
  IconBroadcast,
  IconChart,
  IconDashboard,
  IconGrid,
  IconInstances,
  IconLayers,
  IconPackage,
  IconPause,
  IconPlay,
  IconRecord,
  IconSettings,
  IconStop,
  IconSync,
  IconTerminal,
  IconWindows
} from './components/Icons'
import { HealthDot } from './components/ui'
import { dismissToast, guard, initialiseStore, toast, useFleet } from './state/store'

/**
 * Views load as separate chunks, then are pulled in immediately afterwards.
 *
 * Splitting alone would trade a faster start for a stutter the first time an
 * operator opens a view — which, on a control surface, lands mid-show rather
 * than at a quiet moment. Warming every chunk once the first paint is done
 * takes the startup win without ever making a view switch wait.
 */
const VIEW_LOADERS = {
  dashboard: () => import('./views/DashboardView'),
  multiview: () => import('./views/MultiviewView'),
  windows: () => import('./views/WindowsView'),
  instances: () => import('./views/InstancesView'),
  library: () => import('./views/LibraryView'),
  sync: () => import('./views/SyncView'),
  assets: () => import('./views/AssetsView'),
  stats: () => import('./views/StatsView'),
  logs: () => import('./views/LogsView'),
  settings: () => import('./views/SettingsView')
} as const

const VIEWS = {
  dashboard: lazy(VIEW_LOADERS.dashboard),
  multiview: lazy(VIEW_LOADERS.multiview),
  windows: lazy(VIEW_LOADERS.windows),
  instances: lazy(VIEW_LOADERS.instances),
  library: lazy(VIEW_LOADERS.library),
  sync: lazy(VIEW_LOADERS.sync),
  assets: lazy(VIEW_LOADERS.assets),
  stats: lazy(VIEW_LOADERS.stats),
  logs: lazy(VIEW_LOADERS.logs),
  settings: lazy(VIEW_LOADERS.settings)
} as const

type ViewId =
  | 'dashboard'
  | 'instances'
  | 'library'
  | 'multiview'
  | 'windows'
  | 'sync'
  | 'assets'
  | 'stats'
  | 'logs'
  | 'settings'

interface NavEntry {
  id: ViewId
  label: string
  icon: JSX.Element
  section: string
}

const NAV: NavEntry[] = [
  { id: 'dashboard', label: 'Dashboard', icon: <IconDashboard />, section: 'Operate' },
  { id: 'multiview', label: 'Multiview', icon: <IconGrid />, section: 'Operate' },
  { id: 'windows', label: 'Window layout', icon: <IconWindows />, section: 'Operate' },
  { id: 'instances', label: 'Instances', icon: <IconInstances />, section: 'Configure' },
  { id: 'library', label: 'OBS library', icon: <IconPackage />, section: 'Configure' },
  { id: 'sync', label: 'Sync', icon: <IconSync />, section: 'Configure' },
  { id: 'assets', label: 'HTML sources', icon: <IconLayers />, section: 'Configure' },
  { id: 'stats', label: 'Telemetry', icon: <IconChart />, section: 'Inspect' },
  { id: 'logs', label: 'Logs', icon: <IconTerminal />, section: 'Inspect' },
  // Settings used to sit under "Inspect", which is the one place nobody looks
  // for it. It configures the workspace, so it belongs with the other things
  // that do.
  { id: 'settings', label: 'Settings', icon: <IconSettings />, section: 'Configure' }
]

const VIEW_TITLES: Record<ViewId, { title: string; sub: string }> = {
  dashboard: { title: 'Dashboard', sub: 'Fleet status and per-instance transport' },
  multiview: { title: 'Multiview', sub: 'Live program previews and scene control' },
  windows: { title: 'Window layout', sub: 'Arrange the real OBS windows on your desktop' },
  instances: { title: 'Instances', sub: 'Create, configure and maintain instance folders' },
  library: {
    title: 'OBS library',
    sub: 'OBS versions on this machine, and the plugins and themes each instance loads'
  },
  sync: { title: 'Sync', sub: 'Copy profiles and scene collections across the fleet' },
  assets: { title: 'HTML sources', sub: 'Shared overlay library and browser source deployment' },
  stats: { title: 'Telemetry', sub: 'Resource and encoder metrics over time' },
  logs: { title: 'Logs', sub: 'Client and OBS process output' },
  settings: { title: 'Settings', sub: 'Workspace, ports, thresholds and appearance' }
}

/**
 * Shared empty list for the chrome that renders before the workspace loads.
 *
 * A literal `[]` here is a new array on every read, which is exactly what the
 * store's snapshot cache must not be handed. See `createSnapshotCache`.
 */
const NO_INSTANCES: ObsInstance[] = []

export default function App(): JSX.Element {
  const [view, setView] = useState<ViewId>('dashboard')
  const ready = useFleet((state) => state.ready)

  useEffect(() => {
    let dispose: (() => void) | undefined
    initialiseStore()
      .then((cleanup) => {
        dispose = cleanup
      })
      .catch((err) => toast('error', 'Could not load the workspace', String(err)))
    return () => dispose?.()
  }, [])

  // Warm the remaining view chunks once the first paint is out of the way, so
  // no view switch is ever the thing that waits on a disk read.
  useEffect(() => {
    const idle = window.requestIdleCallback?.bind(window) ?? ((cb: () => void) => setTimeout(cb, 400))
    const handle = idle(() => {
      for (const load of Object.values(VIEW_LOADERS)) void load()
    })
    return () => window.cancelIdleCallback?.(handle as number)
  }, [])

  return (
    <div className="app">
      <Rail view={view} onNavigate={setView} />
      <TopBar view={view} />
      <main className="main">
        {ready ? (
          <div className="view">
            <Suspense fallback={<div className="empty" />}>
              {view === 'dashboard' && <VIEWS.dashboard onNavigate={setView} />}
              {view === 'multiview' && <VIEWS.multiview />}
              {view === 'windows' && <VIEWS.windows />}
              {view === 'instances' && <VIEWS.instances />}
              {view === 'library' && <VIEWS.library />}
              {view === 'sync' && <VIEWS.sync />}
              {view === 'assets' && <VIEWS.assets />}
              {view === 'stats' && <VIEWS.stats />}
              {view === 'logs' && <VIEWS.logs />}
              {view === 'settings' && <VIEWS.settings />}
            </Suspense>
          </div>
        ) : (
          <div className="empty">
            <div className="empty__title">Starting up</div>
            <div className="muted">Loading the workspace and detecting OBS installations.</div>
          </div>
        )}
      </main>
      <Toasts />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Rail                                                                */
/* ------------------------------------------------------------------ */

function Rail({
  view,
  onNavigate
}: {
  view: ViewId
  onNavigate: (view: ViewId) => void
}): JSX.Element {
  const instances = useFleet((state) => state.workspace?.instances ?? NO_INSTANCES)
  const runtimes = useFleet((state) => state.runtimes)
  const assetUrl = useFleet((state) => state.workspace?.settings.assetServerPort)

  const running = instances.filter((instance) => {
    const runtime = runtimes[instance.id]
    return runtime && runtime.state !== 'stopped' && runtime.state !== 'crashed'
  }).length

  const sections = [...new Set(NAV.map((entry) => entry.section))]

  return (
    <nav className="rail">
      <div className="rail__brand">
        <BrandMark className="rail__mark" />
        <span className="rail__title">OBS Fleet</span>
      </div>

      <div className="rail__nav">
        {sections.map((section) => (
          <div key={section}>
            <div className="rail__section">{section}</div>
            {NAV.filter((entry) => entry.section === section).map((entry) => (
              <button
                key={entry.id}
                className={`navitem ${view === entry.id ? 'navitem--active' : ''}`}
                onClick={() => onNavigate(entry.id)}
              >
                {entry.icon}
                <span>{entry.label}</span>
                {entry.id === 'instances' && instances.length > 0 && (
                  <span className="navitem__badge">{instances.length}</span>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="rail__foot">
        <div className="row">
          <span>Running</span>
          <div className="spacer" />
          <span className="num">
            {running}/{instances.length}
          </span>
        </div>
        <div className="row faint">
          <span>Assets</span>
          <div className="spacer" />
          <span className="num">:{assetUrl ?? '—'}</span>
        </div>
      </div>
    </nav>
  )
}

/* ------------------------------------------------------------------ */
/* Top bar transport                                                   */
/* ------------------------------------------------------------------ */

function TopBar({ view }: { view: ViewId }): JSX.Element {
  const instances = useFleet((state) => state.workspace?.instances ?? NO_INSTANCES)
  const runtimes = useFleet((state) => state.runtimes)
  const health = useFleet((state) => state.health)
  const [busy, setBusy] = useState<string | null>(null)

  const meta = VIEW_TITLES[view]

  const summary = useMemo(() => {
    const connected = instances.filter((instance) => runtimes[instance.id]?.wsConnected)
    return {
      connected: connected.length,
      recording: connected.filter((instance) => runtimes[instance.id]?.recording).length,
      streaming: connected.filter((instance) => runtimes[instance.id]?.streaming).length,
      paused: connected.filter((instance) => runtimes[instance.id]?.recordingPaused).length,
      worst: worstHealth(instances.map((instance) => health[instance.id]?.level ?? 'unknown'))
    }
  }, [instances, runtimes, health])

  const anyStopped = instances.some(
    (instance) => !instance.disabled && (runtimes[instance.id]?.state ?? 'stopped') === 'stopped'
  )

  const runBulk = async (action: BulkAction, label: string): Promise<void> => {
    setBusy(action)
    const outcomes = await guard(label, () => window.fleet.bulk({ action, instanceIds: [] }))
    setBusy(null)
    if (!outcomes) return

    const failed = outcomes.filter((outcome) => !outcome.ok)
    if (failed.length === 0) {
      toast('success', label, `${outcomes.length} instance(s) responded.`)
    } else {
      toast(
        'warn',
        `${label}: ${failed.length} failed`,
        failed
          .map((outcome) => `${nameOf(instances, outcome.instanceId)}: ${outcome.detail}`)
          .join('\n')
      )
    }
  }

  return (
    <header className="topbar">
      <span className="topbar__title">{meta.title}</span>
      <span className="topbar__sub">{meta.sub}</span>
      <div className="topbar__spacer" />

      <div className="row" style={{ gap: 10, marginRight: 6 }}>
        <span className="chip">
          <HealthDot level={summary.worst} />
          {summary.connected}/{instances.length} connected
        </span>
        {summary.recording > 0 && (
          <span className="chip chip--rec">
            <IconRecord size={9} /> REC {summary.recording}
          </span>
        )}
        {summary.streaming > 0 && (
          <span className="chip chip--live">
            <span className="dot dot--live" /> LIVE {summary.streaming}
          </span>
        )}
      </div>

      <div className="btn-group">
        <button
          className="btn btn--sm"
          disabled={!anyStopped || busy !== null}
          onClick={() => void runBulk('launch', 'Launch all')}
          title="Launch every enabled instance in order"
        >
          <IconPlay size={13} /> Launch all
        </button>
        <button
          className="btn btn--sm"
          disabled={summary.connected === 0 || busy !== null}
          onClick={() => void runBulk('startRecording', 'Record all')}
        >
          <IconRecord size={12} /> Rec all
        </button>
        <button
          className="btn btn--sm"
          disabled={summary.recording === 0 || busy !== null}
          onClick={() => void runBulk('stopRecording', 'Stop recording')}
        >
          <IconStop size={12} /> Stop rec
        </button>
        <button
          className="btn btn--sm"
          disabled={summary.recording === 0 || busy !== null}
          onClick={() =>
            void runBulk(
              summary.paused > 0 ? 'resumeRecording' : 'pauseRecording',
              summary.paused > 0 ? 'Resume recording' : 'Pause recording'
            )
          }
        >
          <IconPause size={12} /> {summary.paused > 0 ? 'Resume' : 'Pause'}
        </button>
        <button
          className={`btn btn--sm ${summary.streaming > 0 ? 'btn--live' : ''}`}
          disabled={summary.connected === 0 || busy !== null}
          onClick={() =>
            void runBulk(
              summary.streaming > 0 ? 'stopStreaming' : 'startStreaming',
              summary.streaming > 0 ? 'Stop streaming' : 'Start streaming'
            )
          }
        >
          <IconBroadcast size={13} /> {summary.streaming > 0 ? 'Stop stream' : 'Stream all'}
        </button>
      </div>
    </header>
  )
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

function Toasts(): JSX.Element {
  const toasts = useFleet((state) => state.toasts)

  return (
    <div className="toasts">
      {toasts.map((entry) => (
        <div
          key={entry.id}
          className={`toast toast--${entry.kind}`}
          onClick={() => dismissToast(entry.id)}
          role="status"
        >
          <div className="toast__title">{entry.title}</div>
          {entry.body && <div className="toast__body">{entry.body}</div>}
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function worstHealth(levels: string[]): 'ok' | 'warn' | 'critical' | 'unknown' {
  if (levels.includes('critical')) return 'critical'
  if (levels.includes('warn')) return 'warn'
  if (levels.includes('ok')) return 'ok'
  return 'unknown'
}

function nameOf(instances: Array<{ id: string; name: string }>, id: string): string {
  return instances.find((instance) => instance.id === id)?.name ?? id
}

export type { ViewId }
