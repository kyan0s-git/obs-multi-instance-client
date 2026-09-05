import { useEffect, useMemo, useState } from 'react'
import type {
  BulkUpdatableField,
  BulkUpdatePreview,
  BulkUpdateValues,
  CreateInstanceRequest,
  InstanceLaunchOptions,
  IsolationStrategy,
  ObsInstance,
  RemovalPlan
} from '@shared/types'
import type { LaunchPreview } from '@shared/api'
import {
  IconCheck,
  IconCopy,
  IconFolder,
  IconLayers,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconStop,
  IconTerminal,
  IconTrash,
  IconWarning,
  IconWrench
} from '../components/Icons'
import { Callout, Check, Chip, Dialog, Empty, Field, Panel } from '../components/ui'
import { RemovalDialog } from '../components/RemovalDialog'
import { formatRelative } from '../lib/format'
import { guard, toast, useFleet } from '../state/store'

export default function InstancesView(): JSX.Element {
  const workspace = useFleet((state) => state.workspace)
  const runtimes = useFleet((state) => state.runtimes)

  const [creating, setCreating] = useState(false)
  const [massUpdating, setMassUpdating] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
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
              className="btn btn--sm"
              disabled={instances.length === 0}
              title="Change settings on many instances at once"
              onClick={() => setMassUpdating(true)}
            >
              <IconLayers size={13} /> Mass update
              {selected.size > 0 ? ` (${selected.size})` : ''}
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
                  <th style={{ width: 30 }}>
                    <input
                      type="checkbox"
                      aria-label="Select all instances"
                      checked={selected.size === instances.length && instances.length > 0}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked ? new Set(instances.map((i) => i.id)) : new Set()
                        )
                      }
                    />
                  </th>
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
                        <input
                          type="checkbox"
                          aria-label={`Select ${instance.name}`}
                          checked={selected.has(instance.id)}
                          onChange={(e) =>
                            setSelected((current) => {
                              const next = new Set(current)
                              if (e.target.checked) next.add(instance.id)
                              else next.delete(instance.id)
                              return next
                            })
                          }
                        />
                      </td>
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
      {massUpdating && (
        <MassUpdateDialog
          preselected={selected}
          onClose={() => setMassUpdating(false)}
          onApplied={() => setSelected(new Set())}
        />
      )}
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
/* Mass update                                                         */
/* ------------------------------------------------------------------ */

interface FieldSpec {
  field: BulkUpdatableField
  label: string
  group: string
  kind: 'boolean' | 'text' | 'nullableText' | 'color' | 'install' | 'lines'
  hint?: string
}

/**
 * Fields a mass update can write.
 *
 * Only ticked fields are applied. That distinction is the whole point: a plain
 * patch cannot tell "leave auto-restart alone" from "turn auto-restart off",
 * and quietly clearing a flag on twelve instances is discovered mid-show.
 */
const MASS_FIELDS: FieldSpec[] = [
  { field: 'installId', label: 'OBS installation', group: 'Installation', kind: 'install',
    hint: 'Re-runs provisioning, because portable instances link into the install they were built against.' },
  { field: 'profile', label: 'Profile', group: 'Launch selection', kind: 'nullableText' },
  { field: 'sceneCollection', label: 'Scene collection', group: 'Launch selection', kind: 'nullableText' },
  { field: 'startScene', label: 'Start scene', group: 'Launch selection', kind: 'nullableText' },
  { field: 'startRecording', label: 'Start recording on launch', group: 'On launch', kind: 'boolean' },
  { field: 'startStreaming', label: 'Start streaming on launch', group: 'On launch', kind: 'boolean' },
  { field: 'startReplayBuffer', label: 'Start replay buffer', group: 'On launch', kind: 'boolean' },
  { field: 'startVirtualCam', label: 'Start virtual camera', group: 'On launch', kind: 'boolean' },
  { field: 'studioMode', label: 'Studio mode', group: 'Window', kind: 'boolean' },
  { field: 'minimizeToTray', label: 'Minimise to tray', group: 'Window', kind: 'boolean' },
  { field: 'alwaysOnTop', label: 'Always on top', group: 'Window', kind: 'boolean' },
  { field: 'safeMode', label: 'Safe mode', group: 'Diagnostics', kind: 'boolean',
    hint: 'Safe mode also disables the websocket server, so OBS Fleet loses control of the instance.' },
  { field: 'onlyBundledPlugins', label: 'Only bundled plugins', group: 'Diagnostics', kind: 'boolean' },
  { field: 'disableUpdater', label: 'Disable updater', group: 'Diagnostics', kind: 'boolean' },
  { field: 'disableMissingFilesCheck', label: 'Disable missing files check', group: 'Diagnostics', kind: 'boolean' },
  { field: 'verboseLog', label: 'Verbose logging', group: 'Diagnostics', kind: 'boolean' },
  { field: 'extraArgs', label: 'Extra arguments', group: 'Diagnostics', kind: 'lines',
    hint: 'One per line. Replaces the existing list on every selected instance.' },
  { field: 'websocketEnabled', label: 'Remote control enabled', group: 'Control', kind: 'boolean' },
  { field: 'websocketIpv4Only', label: 'Bind IPv4 only', group: 'Control', kind: 'boolean' },
  { field: 'disabled', label: 'Skip in bulk operations', group: 'Fleet behaviour', kind: 'boolean' },
  { field: 'autoRestart', label: 'Restart on crash', group: 'Fleet behaviour', kind: 'boolean' },
  { field: 'role', label: 'Role', group: 'Identity', kind: 'text' },
  { field: 'color', label: 'Accent colour', group: 'Identity', kind: 'color' },
  { field: 'notes', label: 'Notes', group: 'Identity', kind: 'text' }
]

/**
 * Applies settings across many instances at once.
 *
 * Everything else in this app is per-instance; on a twelve-instance rig that
 * means twelve dialogs to turn one flag on. This is also the repair path after
 * OBS itself is upgraded or moved, since re-provisioning rebuilds the junction
 * farm each portable instance depends on.
 */
function MassUpdateDialog({
  preselected,
  onClose,
  onApplied
}: {
  preselected: Set<string>
  onClose: () => void
  onApplied: () => void
}): JSX.Element {
  const workspace = useFleet((state) => state.workspace)
  const runtimes = useFleet((state) => state.runtimes)

  const instances = useMemo(
    () => [...(workspace?.instances ?? [])].sort((a, b) => a.order - b.order),
    [workspace]
  )
  const installs = workspace?.installs ?? []

  const [targets, setTargets] = useState<Set<string>>(
    preselected.size > 0 ? new Set(preselected) : new Set(instances.map((i) => i.id))
  )
  const [fields, setFields] = useState<Set<BulkUpdatableField>>(new Set())
  const [values, setValues] = useState<BulkUpdateValues>({
    installId: installs[0]?.id ?? '',
    color: '#4f9dff',
    extraArgs: []
  })
  const [reprovision, setReprovision] = useState(false)
  const [preview, setPreview] = useState<BulkUpdatePreview | null>(null)
  const [busy, setBusy] = useState(false)

  const request = {
    instanceIds: [...targets],
    fields: [...fields],
    values,
    reprovision
  }

  const buildPreview = async (): Promise<void> => {
    setBusy(true)
    const result = await guard('Preview update', () => window.fleet.previewBulkUpdate(request))
    setBusy(false)
    if (result) setPreview(result)
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    const outcomes = await guard('Apply update', () => window.fleet.applyBulkUpdate(request))
    setBusy(false)
    if (!outcomes) return

    const failed = outcomes.filter((outcome) => !outcome.ok)
    const changed = outcomes.filter((outcome) => outcome.ok && outcome.changed > 0).length

    if (failed.length === 0) {
      toast('success', `Updated ${changed} instance(s)`,
        changed < outcomes.length ? `${outcomes.length - changed} already matched.` : undefined)
      onApplied()
      onClose()
    } else {
      toast(
        'warn',
        `${failed.length} of ${outcomes.length} failed`,
        failed.map((o) => `${nameOf(instances, o.instanceId)}: ${o.detail}`).join('\n')
      )
      setPreview(null)
    }
  }

  const toggleField = (field: BulkUpdatableField, on: boolean): void => {
    setPreview(null)
    setFields((current) => {
      const next = new Set(current)
      if (on) next.add(field)
      else next.delete(field)
      return next
    })
  }

  const groups = [...new Set(MASS_FIELDS.map((spec) => spec.group))]
  const totalChanges = preview?.items.reduce((sum, item) => sum + item.changes.length, 0) ?? 0
  const canPreview = targets.size > 0 && (fields.size > 0 || reprovision)

  return (
    <Dialog
      title="Mass update instances"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="faint">
            {targets.size} instance(s), {fields.size} field(s)
            {preview && ` · ${totalChanges} change(s)`}
          </span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {preview ? (
            <button
              className="btn btn--primary"
              disabled={busy || totalChanges === 0}
              onClick={() => void apply()}
            >
              {busy ? 'Applying…' : `Apply to ${preview.items.filter((i) => i.changes.length > 0).length} instance(s)`}
            </button>
          ) : (
            <button
              className="btn btn--primary"
              disabled={busy || !canPreview}
              onClick={() => void buildPreview()}
            >
              Review changes
            </button>
          )}
        </>
      }
    >
      <Panel
        title="Instances"
        actions={
          <button
            className="btn btn--sm btn--ghost"
            onClick={() => {
              setPreview(null)
              setTargets(
                targets.size === instances.length ? new Set() : new Set(instances.map((i) => i.id))
              )
            }}
          >
            {targets.size === instances.length ? 'None' : 'All'}
          </button>
        }
      >
        <div className="row row--wrap" style={{ gap: 14 }}>
          {instances.map((instance) => {
            const runtime = runtimes[instance.id]
            const running = runtime && runtime.state !== 'stopped' && runtime.state !== 'crashed'
            return (
              <Check
                key={instance.id}
                checked={targets.has(instance.id)}
                onChange={(checked) => {
                  setPreview(null)
                  setTargets((current) => {
                    const next = new Set(current)
                    if (checked) next.add(instance.id)
                    else next.delete(instance.id)
                    return next
                  })
                }}
                label={
                  <span className="row" style={{ gap: 6 }}>
                    <span
                      style={{ width: 3, height: 14, borderRadius: 2, background: instance.color }}
                    />
                    {instance.name}
                    {running && <Chip tone="warn">running</Chip>}
                  </span>
                }
              />
            )
          })}
        </div>
      </Panel>

      <Panel title="What to change">
        <div className="field__hint" style={{ marginBottom: 12 }}>
          Only ticked fields are written. Anything left unticked keeps whatever each instance
          already has.
        </div>

        <div style={{ display: 'grid', gap: 16 }}>
          {groups.map((group) => (
            <div key={group} style={{ display: 'grid', gap: 6 }}>
              <span className="field__label">{group}</span>
              {MASS_FIELDS.filter((spec) => spec.group === group).map((spec) => (
                <MassField
                  key={spec.field}
                  spec={spec}
                  installs={installs}
                  active={fields.has(spec.field)}
                  values={values}
                  onToggle={(on) => toggleField(spec.field, on)}
                  onChange={(next) => {
                    setPreview(null)
                    setValues((current) => ({ ...current, ...next }))
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Provisioning">
        <Check
          checked={reprovision || fields.has('installId')}
          disabled={fields.has('installId')}
          onChange={(v) => {
            setPreview(null)
            setReprovision(v)
          }}
          label="Re-run provisioning on each instance"
        />
        <span className="field__hint" style={{ marginLeft: 22 }}>
          Rebuilds the per-instance view of the OBS installation and rewrites the websocket config.
          This is the repair path after OBS itself is upgraded, moved or reinstalled. Forced on when
          the installation changes.
        </span>
      </Panel>

      {preview && (
        <>
          {preview.warnings.map((warning, index) => (
            <Callout key={index}>{warning}</Callout>
          ))}

          <div className="table__scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Instance</th>
                  <th>Changes</th>
                  <th style={{ width: 120 }}>Provisioning</th>
                </tr>
              </thead>
              <tbody>
                {preview.items.map((item) => (
                  <tr key={item.instanceId}>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        {item.changes.length === 0 ? (
                          <IconCheck size={12} />
                        ) : item.warnings.length > 0 ? (
                          <IconWarning size={12} />
                        ) : null}
                        {item.instanceName}
                      </div>
                      {item.warnings.map((warning, index) => (
                        <div key={index} className="faint" style={{ fontSize: 11 }}>
                          {warning}
                        </div>
                      ))}
                    </td>
                    <td>
                      {item.changes.length === 0 ? (
                        <span className="faint">Already matches</span>
                      ) : (
                        <div style={{ display: 'grid', gap: 2 }}>
                          {item.changes.map((change) => (
                            <div key={change.field} style={{ fontSize: 12 }}>
                              <span className="muted">{change.label}: </span>
                              <span className="faint mono">{change.from}</span>
                              <span className="faint"> {'\u2192'} </span>
                              <span className="mono">{change.to}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>{item.willReprovision ? <Chip tone="warn">re-provision</Chip> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalChanges === 0 && (
            <Callout>Nothing to do — every selected instance already matches.</Callout>
          )}
        </>
      )}
    </Dialog>
  )
}

/** One toggleable field row in the mass-update form. */
function MassField({
  spec,
  installs,
  active,
  values,
  onToggle,
  onChange
}: {
  spec: FieldSpec
  installs: Array<{ id: string; label: string }>
  active: boolean
  values: BulkUpdateValues
  onToggle: (on: boolean) => void
  onChange: (next: Partial<BulkUpdateValues>) => void
}): JSX.Element {
  const value = values[spec.field]

  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <div className="row" style={{ gap: 10 }}>
        <Check checked={active} onChange={onToggle} label={spec.label} />
        <div className="spacer" />

        {spec.kind === 'boolean' && (
          <select
            className="select"
            style={{ width: 110 }}
            disabled={!active}
            value={value === true ? 'on' : 'off'}
            onChange={(e) => onChange({ [spec.field]: e.target.value === 'on' })}
          >
            <option value="on">on</option>
            <option value="off">off</option>
          </select>
        )}

        {(spec.kind === 'text' || spec.kind === 'nullableText') && (
          <input
            className="input"
            style={{ width: 260 }}
            disabled={!active}
            placeholder={spec.kind === 'nullableText' ? '(leave OBS to decide)' : ''}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) =>
              onChange({
                [spec.field]:
                  spec.kind === 'nullableText' && e.target.value === '' ? null : e.target.value
              })
            }
          />
        )}

        {spec.kind === 'color' && (
          <input
            className="input"
            type="color"
            style={{ width: 60, padding: 2, height: 28 }}
            disabled={!active}
            value={typeof value === 'string' ? value : '#4f9dff'}
            onChange={(e) => onChange({ color: e.target.value })}
          />
        )}

        {spec.kind === 'install' && (
          <select
            className="select"
            style={{ width: 260 }}
            disabled={!active}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange({ installId: e.target.value })}
          >
            {installs.map((install) => (
              <option key={install.id} value={install.id}>
                {install.label}
              </option>
            ))}
          </select>
        )}

        {spec.kind === 'lines' && (
          <textarea
            className="textarea"
            style={{ width: 260, minHeight: 52 }}
            rows={2}
            disabled={!active}
            value={Array.isArray(value) ? value.join('\n') : ''}
            onChange={(e) =>
              onChange({
                extraArgs: e.target.value.split('\n').filter((line) => line.trim() !== '')
              })
            }
          />
        )}
      </div>

      {spec.hint && active && (
        <span className="field__hint" style={{ marginLeft: 22 }}>
          {spec.hint}
        </span>
      )}
    </div>
  )
}

function nameOf(instances: Array<{ id: string; name: string }>, id: string): string {
  return instances.find((instance) => instance.id === id)?.name ?? id
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

/**
 * Deleting an instance, with the same plan-first confirmation used everywhere
 * else. It replaces a hand-rolled copy of the pattern, so the two cannot
 * disagree about what a deletion does.
 */
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
  const [plan, setPlan] = useState<RemovalPlan | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setPlan(null)
    void window.fleet
      .planInstanceRemoval(instance.id, deleteFiles)
      .then((next) => !cancelled && setPlan(next))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [instance.id, deleteFiles])

  return (
    <RemovalDialog
      plan={plan}
      loading={busy}
      deleteFiles={deleteFiles}
      onDeleteFilesChange={setDeleteFiles}
      confirmLabel="Delete instance"
      onClose={onCancel}
      onConfirm={() =>
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
    />
  )
}
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
