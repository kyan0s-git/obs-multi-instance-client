import { useEffect, useMemo, useState } from 'react'
import type {
  DownloadJob,
  InstanceAddons,
  ObsCatalog,
  ObsInstall,
  ObsUpdateCandidate
} from '@shared/types'
import {
  IconDownload,
  IconExternal,
  IconFolder,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconWarning
} from '../components/Icons'
import { Callout, Chip, Empty, Field, Panel } from '../components/ui'
import { RemovalDialog } from '../components/RemovalDialog'
import { guard, toast, useFleet } from '../state/store'

type Tab = 'versions' | 'plugins' | 'themes'

/**
 * The library: which OBS builds are on this machine, and what each instance
 * loads on top of them.
 *
 * This is the page that makes the application a launcher rather than a remote
 * control. A production machine should be able to hold several OBS versions,
 * pin instances to one of them, and upgrade deliberately — instead of having
 * one system install that an automatic update changes underneath a show.
 */
export default function LibraryView(): JSX.Element {
  const workspace = useFleet((state) => state.workspace)
  const downloads = useFleet((state) => state.downloads)

  const [tab, setTab] = useState<Tab>('versions')
  const [catalog, setCatalog] = useState<ObsCatalog | null>(null)
  const [updates, setUpdates] = useState<ObsUpdateCandidate[]>([])
  const [loading, setLoading] = useState(false)

  const installs = workspace?.installs ?? []
  const instances = workspace?.instances ?? []

  const refresh = async (force = false): Promise<void> => {
    setLoading(true)
    const [list, available] = await Promise.all([
      window.fleet.obsCatalog(force).catch(() => null),
      window.fleet.obsUpdates().catch(() => [])
    ])
    setCatalog(list)
    setUpdates(available)
    setLoading(false)
  }

  useEffect(() => {
    void refresh()
  }, [])

  return (
    <>
      <div className="row" style={{ gap: 6, marginBottom: 14 }}>
        {(
          [
            ['versions', 'OBS versions'],
            ['plugins', 'Plugins'],
            ['themes', 'Themes']
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            className={`btn btn--sm ${tab === id ? 'btn--primary' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
        <div className="spacer" />
        {tab === 'versions' && (
          <button className="btn btn--sm" disabled={loading} onClick={() => void refresh(true)}>
            <IconRefresh size={12} /> {loading ? 'Checking…' : 'Check for updates'}
          </button>
        )}
      </div>

      {tab === 'versions' && (
        <VersionsTab
          catalog={catalog}
          installs={installs}
          updates={updates}
          downloads={downloads}
          instances={instances}
          onChanged={() => void refresh()}
        />
      )}

      {tab !== 'versions' && <AddonsTab kind={tab} />}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* OBS versions                                                        */
/* ------------------------------------------------------------------ */

function VersionsTab({
  catalog,
  installs,
  updates,
  downloads,
  instances,
  onChanged
}: {
  catalog: ObsCatalog | null
  installs: ObsInstall[]
  updates: ObsUpdateCandidate[]
  downloads: DownloadJob[]
  instances: Array<{ id: string; name: string; installId: string }>
  onChanged: () => void
}): JSX.Element {
  const [removing, setRemoving] = useState<ObsInstall | null>(null)
  const [deleteFiles, setDeleteFiles] = useState(true)
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof window.fleet.planInstallRemoval>> | null>(
    null
  )
  const [busy, setBusy] = useState(false)

  const active = downloads.filter(
    (job) => job.state === 'downloading' || job.state === 'extracting' || job.state === 'queued'
  )

  const installedVersions = useMemo(
    () => new Set(installs.map((install) => install.version).filter(Boolean)),
    [installs]
  )

  useEffect(() => {
    if (!removing) {
      setPlan(null)
      return
    }
    let cancelled = false
    setPlan(null)
    void window.fleet
      .planInstallRemoval(removing.id, deleteFiles)
      .then((next) => !cancelled && setPlan(next))
    return () => {
      cancelled = true
    }
  }, [removing, deleteFiles])

  const install = async (version: string): Promise<void> => {
    const ok = await guard('Install OBS', () => window.fleet.installObsVersion({ version }))
    if (ok) {
      toast('success', `OBS ${version} installed`)
      onChanged()
    }
  }

  const confirmRemoval = async (): Promise<void> => {
    if (!removing) return
    setBusy(true)
    const ok = await guard('Remove installation', () =>
      window.fleet.removeInstall({ installId: removing.id, deleteFiles, force: true })
    )
    setBusy(false)
    if (ok !== undefined) {
      toast('success', `Removed ${removing.label}`)
      setRemoving(null)
      onChanged()
    }
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {catalog?.unsupportedReason && (
        <Callout tone="warn" title="Downloading OBS is not available on this platform">
          {catalog.unsupportedReason}
        </Callout>
      )}

      {updates.length > 0 && (
        <Callout tone="warn" title={`${updates.length} installation(s) have a newer release`}>
          {updates.map((update) => (
            <div key={update.installId}>
              {update.installLabel}: {update.currentVersion ?? 'unknown'} → {update.latestVersion}
              {update.usedBy.length > 0 && ` — used by ${update.usedBy.join(', ')}`}
            </div>
          ))}
          <div className="field__hint" style={{ marginTop: 6 }}>
            Installing a newer version adds it alongside the old one. Nothing moves to it until you
            point instances at it, so a show mid-run is never changed underneath.
          </div>
        </Callout>
      )}

      {active.length > 0 && (
        <Panel title="In progress">
          <div style={{ display: 'grid', gap: 10 }}>
            {active.map((job) => (
              <DownloadRow key={job.id} job={job} />
            ))}
          </div>
        </Panel>
      )}

      <Panel title={`Installed (${installs.length})`}>
        {installs.length === 0 ? (
          <Empty title="No OBS installations">
            Install one below, or add an existing OBS from Settings.
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Installation</th>
                <th>Version</th>
                <th>Source</th>
                <th>Used by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {installs.map((entry) => {
                const users = instances.filter((instance) => instance.installId === entry.id)
                return (
                  <tr key={entry.id}>
                    <td>
                      <div>{entry.label}</div>
                      <div className="faint mono" style={{ fontSize: 11 }}>
                        {entry.root}
                      </div>
                    </td>
                    <td className="num">{entry.version ?? '—'}</td>
                    <td>
                      {entry.managed ? (
                        <Chip tone="ok">Downloaded here</Chip>
                      ) : (
                        <Chip>{entry.detected ? 'Detected' : 'Added by hand'}</Chip>
                      )}
                    </td>
                    <td className="num faint">{users.length}</td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        <button
                          className="btn btn--ghost btn--icon"
                          title="Open the installation folder"
                          onClick={() => void window.fleet.revealPath(entry.root)}
                        >
                          <IconFolder size={12} />
                        </button>
                        <button
                          className="btn btn--ghost btn--icon"
                          title="Remove this installation"
                          onClick={() => {
                            setDeleteFiles(entry.managed === true)
                            setRemoving(entry)
                          }}
                        >
                          <IconTrash size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Available to download">
        {!catalog || catalog.releases.length === 0 ? (
          <Empty title="No release list">
            The OBS release list could not be fetched. This machine may have no internet access,
            which does not affect anything already installed.
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Published</th>
                <th>Download</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {catalog.releases.slice(0, 12).map((release) => {
                const already = installedVersions.has(release.version)
                const asset = release.assets.find(
                  (entry) => entry.kind === 'portable-archive' || entry.kind === 'disk-image'
                )
                return (
                  <tr key={release.tagName}>
                    <td>
                      <span className="num">{release.version}</span>
                      {release.prerelease && <Chip tone="warn">pre-release</Chip>}
                    </td>
                    <td className="faint">
                      {release.publishedAt
                        ? new Date(release.publishedAt).toLocaleDateString()
                        : '—'}
                    </td>
                    <td className="faint num">
                      {asset ? formatBytes(asset.sizeBytes) : '—'}
                      {asset && !asset.sha256 && (
                        <span title="Upstream published no checksum for this asset">
                          {' '}
                          <IconWarning size={11} />
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        <button
                          className="btn btn--ghost btn--icon"
                          title="Open the release notes"
                          onClick={() => void window.fleet.openUrl(release.htmlUrl)}
                        >
                          <IconExternal size={12} />
                        </button>
                        <button
                          className="btn btn--sm"
                          disabled={already || !!catalog.unsupportedReason || !asset}
                          title={
                            already
                              ? 'Already installed'
                              : catalog.unsupportedReason ?? 'Download and install this version'
                          }
                          onClick={() => void install(release.version)}
                        >
                          <IconDownload size={12} /> {already ? 'Installed' : 'Install'}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>

      {removing && (
        <RemovalDialog
          plan={plan}
          loading={busy}
          deleteFiles={deleteFiles}
          onDeleteFilesChange={removing.managed ? setDeleteFiles : null}
          confirmLabel="Remove installation"
          onConfirm={() => void confirmRemoval()}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  )
}

function DownloadRow({ job }: { job: DownloadJob }): JSX.Element {
  const percent =
    job.totalBytes && job.totalBytes > 0
      ? Math.min(100, Math.round((job.receivedBytes / job.totalBytes) * 100))
      : null

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div className="row" style={{ gap: 8 }}>
        <span>{job.label}</span>
        <span className="faint">{job.detail}</span>
        <div className="spacer" />
        <span className="num faint">
          {formatBytes(job.receivedBytes)}
          {job.totalBytes ? ` / ${formatBytes(job.totalBytes)}` : ''}
        </span>
        <button className="btn btn--sm btn--ghost" onClick={() => void window.fleet.cancelDownload(job.id)}>
          Cancel
        </button>
      </div>
      <div className="progress">
        <div
          className={`progress__bar ${percent === null ? 'progress__bar--indeterminate' : ''}`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Plugins and themes                                                  */
/* ------------------------------------------------------------------ */

function AddonsTab({ kind }: { kind: 'plugins' | 'themes' }): JSX.Element {
  const workspace = useFleet((state) => state.workspace)
  const instances = useMemo(
    () => [...(workspace?.instances ?? [])].sort((a, b) => a.order - b.order),
    [workspace]
  )

  const [selected, setSelected] = useState<string | null>(null)
  const [addons, setAddons] = useState<InstanceAddons | null>(null)
  const [busy, setBusy] = useState(false)

  const instanceId = selected ?? instances[0]?.id ?? null

  const load = async (id: string): Promise<void> => {
    const result = await guard('Read plugins and themes', () => window.fleet.readAddons(id))
    if (result) setAddons(result)
  }

  useEffect(() => {
    if (instanceId) void load(instanceId)
    else setAddons(null)
  }, [instanceId])

  if (instances.length === 0) {
    return (
      <Empty title="No instances yet">
        Plugins and themes are managed per instance, so create an instance first.
      </Empty>
    )
  }

  const act = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    const ok = await guard(label, run)
    setBusy(false)
    if (ok !== undefined && instanceId) {
      await load(instanceId)
      toast('success', `${label} — done`)
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', gap: 16 }}>
      <Panel title="Instance">
        <div style={{ display: 'grid', gap: 2 }}>
          {instances.map((instance) => (
            <button
              key={instance.id}
              className={`navitem ${instance.id === instanceId ? 'navitem--active' : ''}`}
              onClick={() => setSelected(instance.id)}
            >
              <span
                style={{ width: 3, height: 14, borderRadius: 2, background: instance.color }}
              />
              <span>{instance.name}</span>
            </button>
          ))}
        </div>
      </Panel>

      {kind === 'plugins' ? (
        <Panel
          title="Plugins"
          actions={
            <button
              className="btn btn--sm"
              disabled={busy || !instanceId}
              onClick={() =>
                void act('Install plugin', () => window.fleet.installPluginArchive(instanceId!))
              }
            >
              <IconPlus size={12} /> Install from .zip
            </button>
          }
        >
          <Callout>
            Plugins installed here belong to this instance alone — OBS is pointed at a per-instance
            folder, so one instance can run a plugin another does not. Plugins that came with the
            OBS installation are shown for reference and are part of that installation.
          </Callout>

          <table className="table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Plugin</th>
                <th>Scope</th>
                <th>Size</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(addons?.plugins ?? []).map((plugin) => (
                <tr key={`${plugin.scope}-${plugin.id}`}>
                  <td>
                    {plugin.name}
                    {!plugin.loadable && (
                      <Chip tone="critical">
                        <IconWarning size={11} /> broken
                      </Chip>
                    )}
                  </td>
                  <td>
                    {plugin.scope === 'instance' ? (
                      <Chip tone="ok">this instance</Chip>
                    ) : (
                      <Chip>from the installation</Chip>
                    )}
                  </td>
                  <td className="num faint">{formatBytes(plugin.sizeBytes)}</td>
                  <td>
                    {plugin.scope === 'instance' && (
                      <button
                        className="btn btn--ghost btn--icon"
                        title="Remove this plugin from this instance"
                        disabled={busy}
                        onClick={() =>
                          void act('Remove plugin', () =>
                            window.fleet.removePlugin(instanceId!, plugin.id)
                          )
                        }
                      >
                        <IconTrash size={12} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {(addons?.plugins ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className="faint">
                    No plugins found for this instance.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Panel>
      ) : (
        <Panel
          title="Themes"
          actions={
            <button
              className="btn btn--sm"
              disabled={busy || !instanceId}
              onClick={() =>
                void act('Install theme', () => window.fleet.installThemeFile(instanceId!))
              }
            >
              <IconPlus size={12} /> Install .obt / .ovt
            </button>
          }
        >
          <Field
            label="Theme for this instance"
            hint="Written to the instance's config. A running OBS keeps its current theme until it restarts."
          >
            <select
              className="select"
              value={addons?.currentTheme ?? ''}
              disabled={busy || !addons}
              onChange={(event) =>
                void act('Set theme', () =>
                  window.fleet.setTheme(instanceId!, event.target.value)
                )
              }
            >
              <option value="" disabled>
                {addons?.currentTheme ? 'Change theme' : 'Not set — OBS picks its default'}
              </option>
              {(addons?.themes ?? []).map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.name} {theme.dark ? '(dark)' : '(light)'}
                </option>
              ))}
            </select>
          </Field>

          <table className="table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Theme</th>
                <th>Kind</th>
                <th>Source</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(addons?.themes ?? []).map((theme) => (
                <tr key={theme.id}>
                  <td>
                    {theme.name}
                    {theme.id === addons?.currentTheme && <Chip tone="ok">in use</Chip>}
                    <div className="faint mono" style={{ fontSize: 11 }}>
                      {theme.id}
                    </div>
                  </td>
                  <td className="faint">{theme.kind}</td>
                  <td>
                    {theme.scope === 'instance' ? (
                      <Chip tone="ok">installed here</Chip>
                    ) : (
                      <Chip>ships with OBS</Chip>
                    )}
                  </td>
                  <td>
                    {theme.scope === 'instance' && (
                      <button
                        className="btn btn--ghost btn--icon"
                        title="Remove this theme"
                        disabled={busy}
                        onClick={() =>
                          void act('Remove theme', () =>
                            window.fleet.removeTheme(instanceId!, theme.id)
                          )
                        }
                      >
                        <IconTrash size={12} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {(addons?.themes ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className="faint">
                    No themes found. Launch this instance once so OBS creates its config folder.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}
