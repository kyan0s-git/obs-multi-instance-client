import { useEffect, useMemo, useState } from 'react'
import type {
  CreateInstanceRequest,
  InstanceLaunchOptions,
  IsolationStrategy,
  ObsInstance
} from '@shared/types'
import type { LaunchPreview } from '@shared/api'
import {
  IconCopy,
  IconFolder,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconStop,
  IconTerminal,
  IconTrash,
  IconWrench
} from '../components/Icons'
import { Callout, Check, Chip, Dialog, Empty, Field, Panel } from '../components/ui'
import { formatRelative } from '../lib/format'
import { guard, toast, useFleet } from '../state/store'

export default function InstancesView(): JSX.Element {
  const workspace = useFleet((state) => state.workspace)
  const runtimes = useFleet((state) => state.runtimes)

  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<ObsInstance | null>(null)
  const [preview, setPreview] = useState<{ instance: ObsInstance; preview: LaunchPreview } | null>(
    null
  )

  const instances = useMemo(
    () => [...(workspace?.instances ?? [])].sort((a, b) => a.order - b.order),
    [workspace]
  )
  const installs = workspace?.installs ?? []

  const move = async (id: string, delta: number): Promise<void> => {
    const ordered = instances.map((instance) => instance.id)
    const index = ordered.indexOf(id)
    const target = index + delta
    if (index === -1 || target < 0 || target >= ordered.length) return

    ordered.splice(target, 0, ordered.splice(index, 1)[0])
    await guard('Reorder instances', () => window.fleet.reorderInstances(ordered))
  }

  return (
    <>
      <Panel
        title={`Instances (${instances.length})`}
        actions={
          <div className="btn-group">
            <button
              className="btn btn--sm"
              onClick={() =>
                void guard('Scan workspace', async () => {
                  const adopted = await window.fleet.discoverInstances()
                  toast(
                    adopted.length > 0 ? 'success' : 'info',
                    adopted.length > 0
                      ? `Adopted ${adopted.length} instance folder(s)`
                      : 'No unregistered instance folders found'
                  )
                })
              }
              title="Find instance folders in the workspace that are not in this list"
            >
              <IconRefresh size={13} /> Scan workspace
            </button>
            <button
              className="btn btn--sm btn--primary"
              disabled={installs.length === 0}
              onClick={() => setCreating(true)}
            >
              <IconPlus size={13} /> New instance
            </button>
          </div>
        }
        flush
      >
        {instances.length === 0 ? (
          <Empty title="No instances">
            Create your first instance to get started. Each one is a self-contained OBS
            configuration.
          </Empty>
        ) : (
          <div className="table__scroll">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 34 }} />
                  <th>Name</th>
                  <th>Role</th>
                  <th>State</th>
                  <th>Port</th>
                  <th>Isolation</th>
                  <th>Profile / Collection</th>
                  <th>Created</th>
                  <th style={{ width: 240 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {instances.map((instance, index) => {
                  const runtime = runtimes[instance.id]
                  const isRunning =
                    runtime && runtime.state !== 'stopped' && runtime.state !== 'crashed'

                  return (
                    <tr key={instance.id}>
                      <td>
                        <div style={{ display: 'grid', gap: 1 }}>
                          <button
                            className="btn btn--ghost btn--sm"
                            style={{ padding: '0 4px', lineHeight: 1 }}
                            disabled={index === 0}
                            onClick={() => void move(instance.id, -1)}
                            aria-label="Move up"
                          >
                            ▲
                          </button>
                          <button
                            className="btn btn--ghost btn--sm"
                            style={{ padding: '0 4px', lineHeight: 1 }}
                            disabled={index === instances.length - 1}
                            onClick={() => void move(instance.id, 1)}
                            aria-label="Move down"
                          >
                            ▼
                          </button>
                        </div>
                      </td>
                      <td>
                        <div className="row" style={{ gap: 7 }}>
                          <span
                            style={{
                              width: 3,
                              height: 16,
                              borderRadius: 2,
                              background: instance.color
                            }}
                          />
                          <button
                            className="btn btn--ghost btn--sm"
                            style={{ padding: 0, fontWeight: 600 }}
                            onClick={() => setEditing(instance)}
                          >
                            {instance.name}
                          </button>
                          {instance.disabled && <Chip>skipped</Chip>}
                          {instance.autoRestart && <Chip tone="ok">auto-restart</Chip>}
                        </div>
                      </td>
                      <td className="muted">{instance.role || '—'}</td>
                      <td>
                        {isRunning ? (
                          <Chip tone={runtime?.wsConnected ? 'ok' : 'warn'}>
                            {runtime?.wsConnected ? 'connected' : runtime?.state}
                          </Chip>
                        ) : (
                          <Chip tone={runtime?.state === 'crashed' ? 'critical' : undefined}>
                            {runtime?.state ?? 'stopped'}
                          </Chip>
                        )}
                      </td>
                      <td className="num">{instance.websocket.port}</td>
                      <td className="muted mono">{isolationLabel(instance.isolation)}</td>
                      <td className="muted truncate" style={{ maxWidth: 200 }}>
                        {runtime?.profile ?? instance.launch.profile ?? '—'}
                        {' / '}
                        {runtime?.sceneCollection ?? instance.launch.sceneCollection ?? '—'}
                      </td>
                      <td className="faint">{formatRelative(instance.createdAt)}</td>
                      <td>
                        <div className="btn-group">
                          {isRunning ? (
                            <button
                              className="btn btn--sm"
                              onClick={() =>
                                void guard('Stop', () => window.fleet.stop(instance.id, false))
                              }
                            >
                              <IconStop size={11} />
                            </button>
                          ) : (
                            <button
                              className="btn btn--sm"
                              onClick={() => void guard('Launch', () => window.fleet.launch(instance.id))}
                            >
                              <IconPlay size={11} />
                            </button>
                          )}
                          <button
                            className="btn btn--sm btn--ghost"
                            title="Show the exact launch command"
                            onClick={() =>
                              void guard('Preview launch', async () => {
                                const result = await window.fleet.previewLaunch(instance.id)
                                setPreview({ instance, preview: result })
                              })
                            }
                          >
                            <IconTerminal size={12} />
                          </button>
                          <button
                            className="btn btn--sm btn--ghost"
                            title="Open the instance folder"
                            onClick={() => void guard('Open folder', () => window.fleet.openPath(instance.dir))}
                          >
                            <IconFolder size={12} />
                          </button>
                          <button
                            className="btn btn--sm btn--ghost"
                            title="Duplicate this instance"
                            onClick={() =>
                              void guard('Clone instance', async () => {
                                const clone = await window.fleet.cloneInstance(
                                  instance.id,
                                  `${instance.name} copy`
                                )
                                toast('success', `Created "${clone.name}"`)
                              })
                            }
                          >
                            <IconCopy size={12} />
                          </button>
                          <button
                            className="btn btn--sm btn--ghost"
                            title="Repair the instance folder"
                            onClick={() =>
                              void guard('Repair instance', async () => {
                                const problems = await window.fleet.repairInstance(instance.id)
                                toast(
                                  problems.length > 0 ? 'warn' : 'success',
                                  problems.length > 0
                                    ? `${instance.name}: issues remain`
                                    : `${instance.name} repaired`,
                                  problems.join('\n')
                                )
                              })
                            }
                          >
                            <IconWrench size={12} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {creating && <CreateDialog onClose={() => setCreating(false)} />}
      {editing && <EditDialog instance={editing} onClose={() => setEditing(null)} />}
      {preview && (
        <Dialog
          title={`Launch command — ${preview.instance.name}`}
          onClose={() => setPreview(null)}
          wide
          footer={
            <>
              <div className="spacer" />
              <button
                className="btn"
                onClick={() => {
                  void navigator.clipboard.writeText(preview.preview.command)
                  toast('success', 'Command copied')
                }}
              >
                Copy command
              </button>
              <button className="btn" onClick={() => setPreview(null)}>
                Close
              </button>
            </>
          }
        >
          <Field label="Command">
            <textarea className="textarea" readOnly value={preview.preview.command} rows={4} />
          </Field>
          <div className="grid-2">
            <Field label="Working directory">
              <input className="input mono" readOnly value={preview.preview.cwd} />
            </Field>
            <Field label="Config directory">
              <input className="input mono" readOnly value={preview.preview.configDir} />
            </Field>
          </div>
          <Field
            label="Environment overrides"
            hint="Only variables OBS Fleet sets are shown. On Linux and macOS these are what isolate the instance's configuration."
          >
            <textarea
              className="textarea"
              readOnly
              rows={4}
              value={
                Object.entries(preview.preview.env)
                  .map(([key, value]) => `${key}=${value}`)
                  .join('\n') || '(none)'
              }
            />
          </Field>
          <Callout tone="info">
            The websocket password is masked here. It is passed to OBS on the command line and
            written into the instance&apos;s obs-websocket config.
          </Callout>
        </Dialog>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

function CreateDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const workspace = useFleet((state) => state.workspace)
  const installs = workspace?.installs ?? []
  const instances = workspace?.instances ?? []

  const [name, setName] = useState('Cam')
  const [role, setRole] = useState('')
  const [count, setCount] = useState(2)
  const [installId, setInstallId] = useState(installs[0]?.id ?? '')
  const [isolation, setIsolation] = useState<IsolationStrategy>(defaultIsolation())
  const [seed, setSeed] = useState<'empty' | 'host' | string>('empty')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)

    const request: CreateInstanceRequest = {
      name,
      role,
      installId,
      isolation,
      count,
      seedFromHostConfig: seed === 'host',
      seedFromInstanceId: seed !== 'host' && seed !== 'empty' ? seed : null
    }

    const result = await guard('Create instances', () => window.fleet.createInstances(request))
    setBusy(false)
    if (!result) return

    toast(
      'success',
      `Created ${result.instances.length} instance(s)`,
      result.warnings.join('\n') || undefined
    )
    onClose()
  }

  return (
    <Dialog
      title="New instances"
      onClose={onClose}
      footer={
        <>
          <span className="faint">
            {count > 1 ? `Creates ${name} 1 … ${name} ${count}` : `Creates ${name}`}
          </span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || name.trim() === '' || installId === ''}
            onClick={() => void submit()}
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Name" hint="Numbers are appended automatically when creating more than one.">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Role" hint="Free-form label, e.g. “ISO — wide” or “Stream mix”.">
          <input className="input" value={role} onChange={(e) => setRole(e.target.value)} />
        </Field>
      </div>

      <div className="grid-2">
        <Field label="How many">
          <input
            className="input num"
            type="number"
            min={1}
            max={32}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(32, Number(e.target.value) || 1)))}
          />
        </Field>
        <Field label="OBS installation">
          <select className="select" value={installId} onChange={(e) => setInstallId(e.target.value)}>
            {installs.map((install) => (
              <option key={install.id} value={install.id}>
                {install.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field
        label="Start from"
        hint="Seeding copies profiles and scene collections so a new instance is not empty."
      >
        <select className="select" value={seed} onChange={(e) => setSeed(e.target.value)}>
          <option value="empty">Empty (a blank default profile and scene)</option>
          <option value="host">Your existing OBS configuration on this machine</option>
          {instances.map((instance) => (
            <option key={instance.id} value={instance.id}>
              Copy of “{instance.name}”
            </option>
          ))}
        </select>
      </Field>

      <Field label="Isolation" hint={isolationHint(isolation)}>
        <select
          className="select"
          value={isolation}
          onChange={(e) => setIsolation(e.target.value as IsolationStrategy)}
        >
          {availableIsolations().map((option) => (
            <option key={option} value={option}>
              {isolationLabel(option)}
            </option>
          ))}
        </select>
      </Field>

      <Callout tone="info" title="What gets created">
        A folder per instance holding its own OBS configuration, a private recording directory, and
        a unique obs-websocket port. Instances launch with <code>--multi</code> so they run
        simultaneously without OBS complaining.
      </Callout>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/* Edit                                                                */
/* ------------------------------------------------------------------ */

function EditDialog({
  instance,
  onClose
}: {
  instance: ObsInstance
  onClose: () => void
}): JSX.Element {
  const workspace = useFleet((state) => state.workspace)
  const snapshot = useFleet((state) => state.snapshots[instance.id])

  const [draft, setDraft] = useState<ObsInstance>(instance)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => setDraft(instance), [instance])

  const patchLaunch = (patch: Partial<InstanceLaunchOptions>): void =>
    setDraft((current) => ({ ...current, launch: { ...current.launch, ...patch } }))

  const save = async (): Promise<void> => {
    setBusy(true)
    const result = await guard('Save instance', () =>
      window.fleet.updateInstance(instance.id, {
        name: draft.name,
        role: draft.role,
        color: draft.color,
        disabled: draft.disabled,
        autoRestart: draft.autoRestart,
        notes: draft.notes,
        websocket: draft.websocket,
        launch: draft.launch
      })
    )
    setBusy(false)
    if (result) {
      toast('success', `Saved "${result.name}"`)
      onClose()
    }
  }

  const profiles = snapshot?.profiles ?? []
  const collections = snapshot?.sceneCollections ?? []
  const install = workspace?.installs.find((entry) => entry.id === instance.installId)

  return (
    <Dialog
      title={`Configure — ${instance.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button
            className="btn btn--danger btn--sm"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
          >
            <IconTrash size={12} /> Delete
          </button>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="grid-3">
        <Field label="Name">
          <input
            className="input"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field label="Role">
          <input
            className="input"
            value={draft.role}
            onChange={(e) => setDraft({ ...draft, role: e.target.value })}
          />
        </Field>
        <Field label="Accent colour">
          <input
            className="input"
            type="color"
            value={draft.color}
            style={{ padding: 2, height: 30 }}
            onChange={(e) => setDraft({ ...draft, color: e.target.value })}
          />
        </Field>
      </div>

      <Panel title="Control connection">
        <div className="grid-3">
          <Field label="WebSocket port">
            <input
              className="input num"
              type="number"
              value={draft.websocket.port}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  websocket: { ...draft.websocket, port: Number(e.target.value) || 0 }
                })
              }
            />
          </Field>
          <Field label="Password" hint="Written into this instance's obs-websocket config.">
            <input
              className="input mono"
              value={draft.websocket.password}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  websocket: { ...draft.websocket, password: e.target.value }
                })
              }
            />
          </Field>
          <div style={{ display: 'grid', alignContent: 'end', gap: 4 }}>
            <Check
              checked={draft.websocket.enabled}
              onChange={(enabled) =>
                setDraft({ ...draft, websocket: { ...draft.websocket, enabled } })
              }
              label="Enable remote control"
            />
            <Check
              checked={draft.websocket.ipv4Only}
              onChange={(ipv4Only) =>
                setDraft({ ...draft, websocket: { ...draft.websocket, ipv4Only } })
              }
              label="Bind IPv4 only"
            />
          </div>
        </div>
        {draft.launch.safeMode && (
          <Callout>
            Safe Mode disables the websocket server, so OBS Fleet cannot control this instance while
            it is enabled.
          </Callout>
        )}
      </Panel>

      <Panel title="Launch options">
        <div className="grid-3">
          <Field label="Profile" hint="Passed as --profile.">
            <input
              className="input"
              list={`profiles-${instance.id}`}
              value={draft.launch.profile ?? ''}
              onChange={(e) => patchLaunch({ profile: e.target.value || null })}
            />
            <datalist id={`profiles-${instance.id}`}>
              {profiles.map((profile) => (
                <option key={profile} value={profile} />
              ))}
            </datalist>
          </Field>
          <Field label="Scene collection" hint="Passed as --collection.">
            <input
              className="input"
              list={`collections-${instance.id}`}
              value={draft.launch.sceneCollection ?? ''}
              onChange={(e) => patchLaunch({ sceneCollection: e.target.value || null })}
            />
            <datalist id={`collections-${instance.id}`}>
              {collections.map((collection) => (
                <option key={collection} value={collection} />
              ))}
            </datalist>
          </Field>
          <Field label="Start scene" hint="Passed as --scene.">
            <input
              className="input"
              value={draft.launch.startScene ?? ''}
              onChange={(e) => patchLaunch({ startScene: e.target.value || null })}
            />
          </Field>
        </div>

        <div className="grid-3" style={{ marginTop: 12 }}>
          <div>
            <div className="field__label" style={{ marginBottom: 6 }}>
              On launch
            </div>
            <Check
              checked={draft.launch.startRecording}
              onChange={(v) => patchLaunch({ startRecording: v })}
              label="Start recording"
            />
            <Check
              checked={draft.launch.startStreaming}
              onChange={(v) => patchLaunch({ startStreaming: v })}
              label="Start streaming"
            />
            <Check
              checked={draft.launch.startReplayBuffer}
              onChange={(v) => patchLaunch({ startReplayBuffer: v })}
              label="Start replay buffer"
            />
            <Check
              checked={draft.launch.startVirtualCam}
              onChange={(v) => patchLaunch({ startVirtualCam: v })}
              label="Start virtual camera"
            />
          </div>

          <div>
            <div className="field__label" style={{ marginBottom: 6 }}>
              Window
            </div>
            <Check
              checked={draft.launch.studioMode}
              onChange={(v) => patchLaunch({ studioMode: v })}
              label="Studio mode"
            />
            <Check
              checked={draft.launch.minimizeToTray}
              onChange={(v) => patchLaunch({ minimizeToTray: v })}
              label="Minimise to tray"
            />
            <Check
              checked={draft.launch.alwaysOnTop}
              onChange={(v) => patchLaunch({ alwaysOnTop: v })}
              label="Always on top"
            />
          </div>

          <div>
            <div className="field__label" style={{ marginBottom: 6 }}>
              Diagnostics
            </div>
            <Check
              checked={draft.launch.safeMode}
              onChange={(v) => patchLaunch({ safeMode: v })}
              label="Safe mode (no plugins)"
            />
            <Check
              checked={draft.launch.onlyBundledPlugins}
              onChange={(v) => patchLaunch({ onlyBundledPlugins: v })}
              label="Only bundled plugins"
            />
            <Check
              checked={draft.launch.verboseLog}
              onChange={(v) => patchLaunch({ verboseLog: v })}
              label="Verbose logging"
            />
            <Check
              checked={draft.launch.disableUpdater}
              onChange={(v) => patchLaunch({ disableUpdater: v })}
              label="Disable updater"
            />
          </div>
        </div>

        <Field
          label="Extra arguments"
          hint="One per line, appended verbatim to the OBS command line."
        >
          <textarea
            className="textarea"
            rows={3}
            value={draft.launch.extraArgs.join('\n')}
            onChange={(e) =>
              patchLaunch({ extraArgs: e.target.value.split('\n').filter((line) => line.trim() !== '') })
            }
          />
        </Field>
      </Panel>

      <Panel title="Fleet behaviour">
        <div className="grid-2">
          <div>
            <Check
              checked={draft.disabled}
              onChange={(disabled) => setDraft({ ...draft, disabled })}
              label="Skip in bulk operations"
            />
            <Check
              checked={draft.autoRestart}
              onChange={(autoRestart) => setDraft({ ...draft, autoRestart })}
              label="Restart automatically if it crashes"
            />
          </div>
          <Field label="Notes">
            <textarea
              className="textarea"
              rows={3}
              style={{ minHeight: 60 }}
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </Field>
        </div>
      </Panel>

      <Panel title="Location">
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="row">
            <span className="mono truncate faint">{instance.dir}</span>
            <div className="spacer" />
            <button
              className="btn btn--sm"
              onClick={() => void guard('Open folder', () => window.fleet.openPath(instance.dir))}
            >
              <IconFolder size={12} /> Open
            </button>
            <button
              className="btn btn--sm"
              onClick={() =>
                void guard('Open logs', () => window.fleet.openInstanceLogFolder(instance.id))
              }
            >
              OBS logs
            </button>
          </div>
          <div className="faint mono" style={{ fontSize: 11 }}>
            Isolation: {isolationLabel(instance.isolation)} · Install:{' '}
            {install?.label ?? 'missing'}
          </div>
        </div>
      </Panel>

      {confirmDelete && (
        <DeleteConfirm
          instance={instance}
          onCancel={() => setConfirmDelete(false)}
          onDone={onClose}
        />
      )}
    </Dialog>
  )
}

function DeleteConfirm({
  instance,
  onCancel,
  onDone
}: {
  instance: ObsInstance
  onCancel: () => void
  onDone: () => void
}): JSX.Element {
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)

  const confirmed = !deleteFiles || typed === instance.name

  return (
    <Dialog
      title={`Delete "${instance.name}"?`}
      onClose={onCancel}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn--danger"
            disabled={!confirmed || busy}
            onClick={() =>
              void (async () => {
                setBusy(true)
                const ok = await guard('Delete instance', () =>
                  window.fleet.removeInstance(instance.id, deleteFiles)
                )
                setBusy(false)
                if (ok !== undefined) {
                  toast('success', `Deleted "${instance.name}"`)
                  onDone()
                }
              })()
            }
          >
            Delete
          </button>
        </>
      }
    >
      <p className="muted">
        Removing the instance from the fleet stops OBS Fleet managing it. The folder on disk is kept
        unless you ask for it to be deleted.
      </p>

      <Check
        checked={deleteFiles}
        onChange={setDeleteFiles}
        label="Also delete the instance folder, including its recordings and scene collections"
      />

      {deleteFiles && (
        <>
          <Callout tone="danger" title="This cannot be undone">
            <span className="mono">{instance.dir}</span> and everything inside it will be removed.
          </Callout>
          <Field label={`Type "${instance.name}" to confirm`}>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </Field>
        </>
      )}
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */

function defaultIsolation(): IsolationStrategy {
  if (window.platform.os === 'win32') return 'portable-linkfarm'
  if (window.platform.os === 'darwin') return 'home-redirect'
  return 'xdg-config-home'
}

function availableIsolations(): IsolationStrategy[] {
  // Portable mode is only compiled into Windows builds of OBS, so offering it
  // elsewhere would produce instances that quietly share one config.
  if (window.platform.os === 'win32') return ['portable-linkfarm', 'portable-copy']
  if (window.platform.os === 'darwin') return ['home-redirect']
  return ['xdg-config-home']
}

export function isolationLabel(strategy: IsolationStrategy): string {
  switch (strategy) {
    case 'portable-linkfarm':
      return 'Portable (linked)'
    case 'portable-copy':
      return 'Portable (full copy)'
    case 'home-redirect':
      return 'Redirected HOME'
    case 'xdg-config-home':
      return 'XDG_CONFIG_HOME'
    default:
      return strategy
  }
}

function isolationHint(strategy: IsolationStrategy): string {
  switch (strategy) {
    case 'portable-linkfarm':
      return 'Links the OBS program files into the instance folder using directory junctions. Costs almost no disk space and needs no administrator rights.'
    case 'portable-copy':
      return 'Copies the whole OBS installation into the instance folder. Uses several hundred megabytes each, but survives the base installation being upgraded or removed.'
    case 'home-redirect':
      return 'Runs the shared OBS app bundle with a per-instance HOME, which is where macOS builds look for their configuration.'
    case 'xdg-config-home':
      return 'Runs the shared OBS binary with a per-instance XDG_CONFIG_HOME, which is where Linux builds look for their configuration.'
    default:
      return ''
  }
}
