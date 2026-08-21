import { useEffect, useState } from 'react'
import type { HealthThresholds, WorkspaceSettings } from '@shared/types'
import { IconFolder, IconPlus, IconRefresh, IconTrash, IconWarning } from '../components/Icons'
import { Callout, Check, Chip, Field, Panel } from '../components/ui'
import { guard, toast, useFleet } from '../state/store'
import { isolationLabel } from './InstancesView'

export default function SettingsView(): JSX.Element {
  const workspace = useFleet((state) => state.workspace)
  const [draft, setDraft] = useState<WorkspaceSettings | null>(workspace?.settings ?? null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (workspace?.settings) setDraft(workspace.settings)
  }, [workspace?.settings])

  if (!draft || !workspace) return <></>

  const dirty = JSON.stringify(draft) !== JSON.stringify(workspace.settings)

  const save = async (patch?: Partial<WorkspaceSettings>): Promise<void> => {
    setSaving(true)
    const result = await guard('Save settings', () =>
      window.fleet.updateSettings(patch ?? draft)
    )
    setSaving(false)
    if (result) toast('success', 'Settings saved')
  }

  const patchThreshold = (key: keyof HealthThresholds, value: number): void =>
    setDraft({ ...draft, thresholds: { ...draft.thresholds, [key]: value } })

  return (
    <>
      <Panel
        title="Workspace"
        actions={
          dirty && (
            <button className="btn btn--sm btn--primary" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          )
        }
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <Field
            label="Workspace folder"
            hint="Holds every instance folder, the shared asset library, templates and sync backups."
          >
            <div className="row">
              <input className="input mono" readOnly value={draft.root} />
              <button
                className="btn"
                onClick={() =>
                  void guard('Choose folder', async () => {
                    const picked = await window.fleet.chooseWorkspaceRoot()
                    if (picked) setDraft({ ...draft, root: picked })
                  })
                }
              >
                Change
              </button>
              <button
                className="btn"
                onClick={() => void guard('Open folder', () => window.fleet.openPath(draft.root))}
              >
                <IconFolder size={13} />
              </button>
            </div>
          </Field>

          {draft.root !== workspace.settings.root && (
            <Callout tone="danger" title="Changing the workspace does not move anything">
              Existing instances keep their current folders. Point this at a new location only when
              starting fresh, or move the folders yourself first and use Scan workspace on the
              Instances page.
            </Callout>
          )}

          <div className="grid-3">
            <Field label="Base websocket port" hint="New instances get the first free port from here.">
              <input
                className="input num"
                type="number"
                value={draft.basePort}
                onChange={(e) => setDraft({ ...draft, basePort: Number(e.target.value) || 4456 })}
              />
            </Field>
            <Field
              label="Bulk launch stagger (ms)"
              hint="Delay between launches. Starting several instances at once can make GPU encoder initialisation fail."
            >
              <input
                className="input num"
                type="number"
                step={250}
                value={draft.bulkLaunchStaggerMs}
                onChange={(e) =>
                  setDraft({ ...draft, bulkLaunchStaggerMs: Number(e.target.value) || 0 })
                }
              />
            </Field>
            <Field label="Theme">
              <select
                className="select"
                value={draft.theme}
                onChange={(e) =>
                  setDraft({ ...draft, theme: e.target.value as WorkspaceSettings['theme'] })
                }
              >
                <option value="dark">Dark</option>
                <option value="midnight">Midnight</option>
                <option value="light">Light</option>
              </select>
            </Field>
          </div>

          <div className="grid-2">
            <div>
              <Check
                checked={draft.perInstancePasswords}
                onChange={(v) => setDraft({ ...draft, perInstancePasswords: v })}
                label="Give each instance its own websocket password"
              />
              <Check
                checked={draft.confirmDestructive}
                onChange={(v) => setDraft({ ...draft, confirmDestructive: v })}
                label="Confirm before destructive actions"
              />
            </div>
            {!draft.perInstancePasswords && (
              <Field
                label="Shared password"
                hint="Used for every new instance. Existing instances keep the password they were created with."
              >
                <input
                  className="input mono"
                  value={draft.sharedPassword}
                  onChange={(e) => setDraft({ ...draft, sharedPassword: e.target.value })}
                />
              </Field>
            )}
          </div>

          <div className="row">
            <button
              className="btn btn--sm"
              onClick={() =>
                void guard('Renumber ports', async () => {
                  await window.fleet.renumberPorts()
                  toast('success', 'Ports reassigned from the base port')
                })
              }
            >
              Renumber all instance ports
            </button>
          </div>
        </div>
      </Panel>

      <Panel title="OBS installations" flush>
        <div className="table__scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Installation</th>
                <th>Version</th>
                <th>Executable</th>
                <th>Status</th>
                <th style={{ width: 120 }} />
              </tr>
            </thead>
            <tbody>
              {workspace.installs.map((install) => {
                const inUse = workspace.instances.filter(
                  (instance) => instance.installId === install.id
                ).length
                return (
                  <tr key={install.id}>
                    <td>
                      <div>{install.label}</div>
                      <div className="faint mono" style={{ fontSize: 11 }}>
                        {install.root}
                      </div>
                    </td>
                    <td className="num">{install.version ?? '—'}</td>
                    <td className="faint mono truncate" style={{ maxWidth: 260 }}>
                      {install.executable}
                    </td>
                    <td>
                      {install.problems.length > 0 ? (
                        <Chip tone="critical" >
                          <IconWarning size={11} /> {install.problems.length} issue(s)
                        </Chip>
                      ) : (
                        <Chip tone="ok">OK</Chip>
                      )}
                      {inUse > 0 && <Chip>{inUse} instance(s)</Chip>}
                    </td>
                    <td>
                      <button
                        className="btn btn--sm btn--ghost"
                        disabled={inUse > 0}
                        title={
                          inUse > 0
                            ? 'Instances still use this installation'
                            : 'Remove this installation'
                        }
                        onClick={() =>
                          void guard('Remove install', () => window.fleet.removeInstall(install.id))
                        }
                      >
                        <IconTrash size={12} />
                      </button>
                    </td>
                  </tr>
                )
              })}
              {workspace.installs.length === 0 && (
                <tr>
                  <td colSpan={5} className="faint">
                    No OBS installations registered.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="panel__body row">
          <button
            className="btn btn--sm"
            onClick={() =>
              void guard('Detect installations', async () => {
                const found = await window.fleet.detectInstalls()
                toast('success', `${found.length} installation(s) registered`)
              })
            }
          >
            <IconRefresh size={12} /> Detect automatically
          </button>
          <button
            className="btn btn--sm"
            onClick={() => void guard('Add installation', () => window.fleet.browseForInstall())}
          >
            <IconPlus size={12} /> Add manually
          </button>
          <button
            className="btn btn--sm btn--ghost"
            onClick={() => void guard('Re-check', () => window.fleet.revalidateInstalls())}
          >
            Re-check
          </button>
          <div className="spacer" />
          <span className="faint">
            Default isolation on this platform: {isolationLabel(defaultIsolationForPlatform())}
          </span>
        </div>

        {workspace.installs.some((install) => install.problems.length > 0) && (
          <div className="panel__body" style={{ paddingTop: 0 }}>
            {workspace.installs
              .filter((install) => install.problems.length > 0)
              .map((install) => (
                <Callout key={install.id} title={install.label}>
                  {install.problems.join(' · ')}
                </Callout>
              ))}
          </div>
        )}
      </Panel>

      <Panel title="Telemetry and previews">
        <div className="grid-3">
          <Field label="Sampling interval (ms)" hint="How often each instance is polled for stats.">
            <input
              className="input num"
              type="number"
              step={250}
              min={250}
              value={draft.statsIntervalMs}
              onChange={(e) => setDraft({ ...draft, statsIntervalMs: Number(e.target.value) || 1000 })}
            />
          </Field>
          <Field label="History length (samples)">
            <input
              className="input num"
              type="number"
              step={30}
              min={30}
              value={draft.statsHistoryLength}
              onChange={(e) =>
                setDraft({ ...draft, statsHistoryLength: Number(e.target.value) || 300 })
              }
            />
          </Field>
          <Field label="Preview source">
            <select
              className="select"
              value={draft.multiview.source}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  multiview: {
                    ...draft.multiview,
                    source: e.target.value as 'program' | 'preview'
                  }
                })
              }
            >
              <option value="program">Program output</option>
              <option value="preview">Preview (studio mode)</option>
            </select>
          </Field>
        </div>

        <Check
          checked={draft.multiview.enabled}
          onChange={(enabled) => setDraft({ ...draft, multiview: { ...draft.multiview, enabled } })}
          label="Capture multiview previews"
        />
      </Panel>

      <Panel title="HTML asset server">
        <div className="grid-2">
          <Field
            label="Port"
            hint="Bound to 127.0.0.1 only. Overlays often carry unpublished content, so they are never exposed to the network."
          >
            <input
              className="input num"
              type="number"
              value={draft.assetServerPort}
              onChange={(e) =>
                setDraft({ ...draft, assetServerPort: Number(e.target.value) || 4599 })
              }
            />
          </Field>
          <div style={{ display: 'grid', alignContent: 'center' }}>
            <Check
              checked={draft.assetServerEnabled}
              onChange={(v) => setDraft({ ...draft, assetServerEnabled: v })}
              label="Serve the shared asset library over HTTP"
            />
            <span className="field__hint">
              Serving over HTTP is what lets one overlay file render per-instance content and reload
              live when you edit it.
            </span>
          </div>
        </div>
      </Panel>

      <Panel title="Health thresholds">
        <div className="field__hint" style={{ marginBottom: 12 }}>
          These decide when an instance card turns amber or red. Frame-drop percentages are measured
          over the recent sample window rather than the instance's lifetime.
        </div>
        <div className="grid-3">
          <ThresholdPair
            label="Render frames dropped (%)"
            warn={draft.thresholds.renderSkipWarnPercent}
            critical={draft.thresholds.renderSkipCriticalPercent}
            onWarn={(v) => patchThreshold('renderSkipWarnPercent', v)}
            onCritical={(v) => patchThreshold('renderSkipCriticalPercent', v)}
          />
          <ThresholdPair
            label="Encoder frames dropped (%)"
            warn={draft.thresholds.outputSkipWarnPercent}
            critical={draft.thresholds.outputSkipCriticalPercent}
            onWarn={(v) => patchThreshold('outputSkipWarnPercent', v)}
            onCritical={(v) => patchThreshold('outputSkipCriticalPercent', v)}
          />
          <ThresholdPair
            label="Frame render time (ms)"
            warn={draft.thresholds.frameRenderTimeWarnMs}
            critical={draft.thresholds.frameRenderTimeCriticalMs}
            onWarn={(v) => patchThreshold('frameRenderTimeWarnMs', v)}
            onCritical={(v) => patchThreshold('frameRenderTimeCriticalMs', v)}
          />
          <ThresholdPair
            label="FPS below target (%)"
            warn={draft.thresholds.fpsDropWarnPercent}
            critical={draft.thresholds.fpsDropCriticalPercent}
            onWarn={(v) => patchThreshold('fpsDropWarnPercent', v)}
            onCritical={(v) => patchThreshold('fpsDropCriticalPercent', v)}
          />
          <ThresholdPair
            label="Host CPU (%)"
            warn={draft.thresholds.cpuWarnPercent}
            critical={draft.thresholds.cpuCriticalPercent}
            onWarn={(v) => patchThreshold('cpuWarnPercent', v)}
            onCritical={(v) => patchThreshold('cpuCriticalPercent', v)}
          />
          <ThresholdPair
            label="Host memory (%)"
            warn={draft.thresholds.memoryWarnPercent}
            critical={draft.thresholds.memoryCriticalPercent}
            onWarn={(v) => patchThreshold('memoryWarnPercent', v)}
            onCritical={(v) => patchThreshold('memoryCriticalPercent', v)}
          />
          <ThresholdPair
            label="Recording disk free (MB)"
            warn={draft.thresholds.diskSpaceWarnMb}
            critical={draft.thresholds.diskSpaceCriticalMb}
            onWarn={(v) => patchThreshold('diskSpaceWarnMb', v)}
            onCritical={(v) => patchThreshold('diskSpaceCriticalMb', v)}
            inverted
          />
          <ThresholdPair
            label="Stream congestion (0–1)"
            warn={draft.thresholds.congestionWarn}
            critical={draft.thresholds.congestionCritical}
            onWarn={(v) => patchThreshold('congestionWarn', v)}
            onCritical={(v) => patchThreshold('congestionCritical', v)}
            step={0.05}
          />
        </div>
      </Panel>

      <Panel title="About">
        <div className="grid-2">
          <div className="field__hint">
            OBS Fleet runs several isolated OBS Studio instances side by side. Each instance is a
            folder with its own configuration; instances launch with <code>--multi</code> and a
            unique obs-websocket port, and are controlled entirely over that connection.
          </div>
          <div className="mono faint" style={{ fontSize: 11, display: 'grid', gap: 2 }}>
            <span>Platform: {window.platform.os} ({window.platform.arch})</span>
            <span>Electron {window.platform.versions.electron}</span>
            <span>Chromium {window.platform.versions.chrome}</span>
            <span>Node {window.platform.versions.node}</span>
          </div>
        </div>
      </Panel>

      {dirty && (
        <div className="row">
          <div className="spacer" />
          <button className="btn" onClick={() => setDraft(workspace.settings)}>
            Discard changes
          </button>
          <button className="btn btn--primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}
    </>
  )
}

function ThresholdPair({
  label,
  warn,
  critical,
  onWarn,
  onCritical,
  step = 1,
  inverted = false
}: {
  label: string
  warn: number
  critical: number
  onWarn: (value: number) => void
  onCritical: (value: number) => void
  step?: number
  inverted?: boolean
}): JSX.Element {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="row" style={{ gap: 6 }}>
        <input
          className="input num"
          type="number"
          step={step}
          value={warn}
          onChange={(e) => onWarn(Number(e.target.value) || 0)}
          aria-label={`${label} warning threshold`}
        />
        <input
          className="input num"
          type="number"
          step={step}
          value={critical}
          onChange={(e) => onCritical(Number(e.target.value) || 0)}
          aria-label={`${label} critical threshold`}
        />
      </div>
      <span className="field__hint">
        {inverted ? 'Warn at or below, critical at or below.' : 'Warn at or above, critical at or above.'}
      </span>
    </div>
  )
}

function defaultIsolationForPlatform(): 'portable-linkfarm' | 'home-redirect' | 'xdg-config-home' {
  if (window.platform.os === 'win32') return 'portable-linkfarm'
  if (window.platform.os === 'darwin') return 'home-redirect'
  return 'xdg-config-home'
}
