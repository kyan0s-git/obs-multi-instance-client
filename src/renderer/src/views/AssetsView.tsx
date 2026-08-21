import { useEffect, useMemo, useState } from 'react'
import type { BrowserSourceSpec, HtmlAsset } from '@shared/types'
import {
  IconExternal,
  IconFolder,
  IconLayers,
  IconPlus,
  IconRefresh,
  IconTrash
} from '../components/Icons'
import { Callout, Check, Chip, Dialog, Empty, Field, Panel } from '../components/ui'
import { formatBytes, formatRelative } from '../lib/format'
import { guard, toast, useFleet } from '../state/store'

const STARTER_OVERLAY = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Lower third</title>
    <style>
      html, body { margin: 0; height: 100%; background: transparent; }
      body {
        font-family: system-ui, sans-serif;
        color: #fff;
        display: flex;
        align-items: flex-end;
        padding: 64px;
      }
      .bar {
        border-left: 6px solid var(--accent, #4f9dff);
        background: rgba(10, 14, 20, 0.82);
        padding: 14px 22px;
      }
      .name { font-size: 34px; font-weight: 650; }
      .role { font-size: 18px; opacity: 0.72; }
    </style>
  </head>
  <body>
    <div class="bar">
      <div class="name" id="name">Guest name</div>
      <div class="role" id="role">Title</div>
    </div>

    <script>
      // window.OBSFleet is injected by the asset server and carries the
      // identity of the instance rendering this page.
      var fleet = window.OBSFleet || {};
      if (fleet.color) document.documentElement.style.setProperty('--accent', fleet.color);
      if (fleet.instance) document.getElementById('role').textContent = fleet.role || fleet.instance;
    </script>
  </body>
</html>
`

/**
 * Shared HTML/media library plus one-click deployment of browser sources
 * across instances.
 *
 * Files are served over loopback HTTP rather than referenced as `file://`
 * because that is what makes query strings, live reload and per-instance
 * variation work inside OBS's embedded browser.
 */
export default function AssetsView(): JSX.Element {
  const assets = useFleet((state) => state.htmlAssets)
  const workspace = useFleet((state) => state.workspace)
  const runtimes = useFleet((state) => state.runtimes)

  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [deploying, setDeploying] = useState<HtmlAsset | 'url' | null>(null)
  const [creating, setCreating] = useState(false)
  const [existing, setExisting] = useState<Record<string, Array<{ name: string; url: string }>>>({})

  const connected = useMemo(
    () =>
      [...(workspace?.instances ?? [])]
        .sort((a, b) => a.order - b.order)
        .filter((instance) => runtimes[instance.id]?.wsConnected),
    [workspace, runtimes]
  )

  useEffect(() => {
    void window.fleet.assetServerUrl().then(setServerUrl)
  }, [workspace?.settings.assetServerPort, workspace?.settings.assetServerEnabled])

  const scanExisting = async (): Promise<void> => {
    const result: Record<string, Array<{ name: string; url: string }>> = {}
    for (const instance of connected) {
      const sources = await window.fleet.listBrowserSources(instance.id).catch(() => [])
      result[instance.id] = sources
    }
    setExisting(result)
  }

  const htmlAssets = assets.filter((asset) => /\.html?$/i.test(asset.name))
  const otherAssets = assets.filter((asset) => !/\.html?$/i.test(asset.name))

  return (
    <>
      {!serverUrl && (
        <Callout tone="danger" title="Asset server is not running">
          Browser sources are served over loopback HTTP. Enable the asset server in Settings, or
          check whether its port is already taken.
        </Callout>
      )}

      <Panel
        title="Shared asset library"
        actions={
          <div className="btn-group">
            <span className="mono faint">{serverUrl ?? 'offline'}</span>
            <button
              className="btn btn--sm"
              onClick={() =>
                void guard('Open folder', async () => {
                  const root = workspace?.settings.root
                  if (root) await window.fleet.openPath(`${root}/assets`)
                })
              }
            >
              <IconFolder size={12} /> Open folder
            </button>
            <button
              className="btn btn--sm"
              onClick={() =>
                void guard('Reload overlays', async () => {
                  await window.fleet.reloadHtmlAssets()
                  toast('success', 'Reload sent to every served page')
                })
              }
            >
              <IconRefresh size={12} /> Reload all
            </button>
            <button className="btn btn--sm" onClick={() => setCreating(true)}>
              <IconPlus size={12} /> New overlay
            </button>
            <button
              className="btn btn--sm btn--primary"
              onClick={() => void guard('Import files', () => window.fleet.importHtmlAssets())}
            >
              Import files
            </button>
          </div>
        }
        flush
      >
        {assets.length === 0 ? (
          <Empty title="The library is empty">
            Drop HTML overlays, images or video into the workspace <code>assets/</code> folder, or
            import them here. Anything in that folder is served to every instance and reloads
            automatically when you edit it.
          </Empty>
        ) : (
          <div className="table__scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Size</th>
                  <th>Modified</th>
                  <th>Placeholders</th>
                  <th style={{ width: 200 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {[...htmlAssets, ...otherAssets].map((asset) => (
                  <tr key={asset.id}>
                    <td>
                      <span className="row" style={{ gap: 7 }}>
                        {/\.html?$/i.test(asset.name) && <IconLayers size={13} />}
                        <span>{asset.relPath}</span>
                      </span>
                    </td>
                    <td className="num faint">{formatBytes(asset.sizeBytes)}</td>
                    <td className="faint">{formatRelative(asset.modifiedAt)}</td>
                    <td className="faint mono" style={{ fontSize: 11 }}>
                      {asset.tokens.length > 0 ? asset.tokens.join(', ') : '—'}
                    </td>
                    <td>
                      <div className="btn-group">
                        <button
                          className="btn btn--sm"
                          disabled={connected.length === 0 || !serverUrl}
                          onClick={() => setDeploying(asset)}
                        >
                          Add to instances
                        </button>
                        <button
                          className="btn btn--sm btn--ghost"
                          title="Open in your browser"
                          onClick={() => void guard('Open', () => window.fleet.openUrl(asset.url))}
                        >
                          <IconExternal size={12} />
                        </button>
                        <button
                          className="btn btn--sm btn--ghost"
                          title="Delete from the library"
                          onClick={() =>
                            void guard('Delete asset', async () => {
                              await window.fleet.deleteHtmlAsset(asset.relPath)
                              toast('success', `Deleted ${asset.relPath}`)
                            })
                          }
                        >
                          <IconTrash size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Browser sources in the fleet"
        actions={
          <div className="btn-group">
            <button
              className="btn btn--sm"
              disabled={connected.length === 0}
              onClick={() => void scanExisting()}
            >
              <IconRefresh size={12} /> Scan
            </button>
            <button
              className="btn btn--sm"
              disabled={connected.length === 0}
              onClick={() => setDeploying('url')}
            >
              Add source from URL
            </button>
            <button
              className="btn btn--sm"
              disabled={connected.length === 0}
              onClick={() =>
                void guard('Refresh browser sources', async () => {
                  const outcomes = await window.fleet.bulk({
                    action: 'refreshBrowserSources',
                    instanceIds: connected.map((instance) => instance.id)
                  })
                  toast(
                    'success',
                    'Refreshed browser sources',
                    outcomes.map((o) => `${nameOf(connected, o.instanceId)}: ${o.detail}`).join('\n')
                  )
                })
              }
            >
              Refresh caches
            </button>
          </div>
        }
      >
        {connected.length === 0 ? (
          <span className="faint">No connected instances.</span>
        ) : Object.keys(existing).length === 0 ? (
          <span className="faint">Press Scan to list the browser sources each instance has.</span>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {connected.map((instance) => (
              <div key={instance.id}>
                <div className="row" style={{ gap: 7, marginBottom: 4 }}>
                  <span
                    style={{ width: 3, height: 14, borderRadius: 2, background: instance.color }}
                  />
                  <strong>{instance.name}</strong>
                  <Chip>{(existing[instance.id] ?? []).length} source(s)</Chip>
                </div>
                {(existing[instance.id] ?? []).length === 0 ? (
                  <span className="faint" style={{ marginLeft: 10 }}>
                    None.
                  </span>
                ) : (
                  <div style={{ display: 'grid', gap: 2, marginLeft: 10 }}>
                    {(existing[instance.id] ?? []).map((source) => (
                      <div key={source.name} className="row" style={{ fontSize: 12 }}>
                        <span style={{ minWidth: 160 }}>{source.name}</span>
                        <span className="faint mono truncate">{source.url}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>

      {deploying && (
        <DeployDialog
          asset={deploying === 'url' ? null : deploying}
          onClose={() => setDeploying(null)}
        />
      )}

      {creating && <CreateOverlayDialog onClose={() => setCreating(false)} />}
    </>
  )
}

/* ------------------------------------------------------------------ */

function DeployDialog({
  asset,
  onClose
}: {
  asset: HtmlAsset | null
  onClose: () => void
}): JSX.Element {
  const workspace = useFleet((state) => state.workspace)
  const runtimes = useFleet((state) => state.runtimes)
  const snapshots = useFleet((state) => state.snapshots)

  const connected = useMemo(
    () =>
      [...(workspace?.instances ?? [])]
        .sort((a, b) => a.order - b.order)
        .filter((instance) => runtimes[instance.id]?.wsConnected),
    [workspace, runtimes]
  )

  const [spec, setSpec] = useState<BrowserSourceSpec>({
    name: asset ? asset.name.replace(/\.html?$/i, '') : 'Browser source',
    assetId: asset?.id ?? null,
    url: asset?.url ?? '',
    width: 1920,
    height: 1080,
    fps: 60,
    fpsCustom: false,
    css: 'body { background: rgba(0,0,0,0); margin: 0; overflow: hidden; }',
    shutdownWhenNotVisible: true,
    restartWhenActivated: true,
    controlAudio: false,
    perInstanceParams: true
  })

  const [targets, setTargets] = useState<Set<string>>(new Set(connected.map((i) => i.id)))
  const [scenePerInstance, setScenePerInstance] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const deploy = async (): Promise<void> => {
    setBusy(true)
    const reports = await guard('Deploy browser source', () =>
      window.fleet.deployBrowserSource(
        spec,
        [...targets].map((instanceId) => ({
          instanceId,
          sceneName: scenePerInstance[instanceId] || null
        }))
      )
    )
    setBusy(false)
    if (!reports) return

    const failed = reports.filter((report) => !report.ok)
    if (failed.length === 0) {
      toast('success', `Added to ${reports.length} instance(s)`)
      onClose()
    } else {
      toast(
        'warn',
        `${failed.length} of ${reports.length} failed`,
        failed.map((r) => `${nameOf(connected, r.instanceId)}: ${r.detail}`).join('\n')
      )
    }
  }

  return (
    <Dialog
      title={asset ? `Add "${asset.name}" to instances` : 'Add browser source from URL'}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="faint">{targets.size} target(s)</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || targets.size === 0 || spec.name.trim() === '' || spec.url.trim() === ''}
            onClick={() => void deploy()}
          >
            {busy ? 'Deploying…' : 'Deploy'}
          </button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Source name" hint="Re-running with the same name updates the source in place.">
          <input
            className="input"
            value={spec.name}
            onChange={(e) => setSpec({ ...spec, name: e.target.value })}
          />
        </Field>
        <Field label="URL">
          <input
            className="input mono"
            value={spec.url}
            placeholder="http://127.0.0.1:4599/overlay.html"
            onChange={(e) => setSpec({ ...spec, url: e.target.value, assetId: null })}
          />
        </Field>
      </div>

      <div className="grid-3">
        <Field label="Width">
          <input
            className="input num"
            type="number"
            value={spec.width}
            onChange={(e) => setSpec({ ...spec, width: Number(e.target.value) || 1920 })}
          />
        </Field>
        <Field label="Height">
          <input
            className="input num"
            type="number"
            value={spec.height}
            onChange={(e) => setSpec({ ...spec, height: Number(e.target.value) || 1080 })}
          />
        </Field>
        <Field label="FPS" hint="Only used when a custom rate is enabled.">
          <input
            className="input num"
            type="number"
            value={spec.fps}
            disabled={!spec.fpsCustom}
            onChange={(e) => setSpec({ ...spec, fps: Number(e.target.value) || 60 })}
          />
        </Field>
      </div>

      <div className="grid-2">
        <div>
          <Check
            checked={spec.perInstanceParams}
            onChange={(v) => setSpec({ ...spec, perInstanceParams: v })}
            label="Append instance identity to the URL"
          />
          <span className="field__hint" style={{ marginLeft: 22 }}>
            Adds <code>?instance=</code>, <code>instanceId</code>, <code>role</code> and{' '}
            <code>color</code>, so one file can render differently per instance.
          </span>
          <Check
            checked={spec.fpsCustom}
            onChange={(v) => setSpec({ ...spec, fpsCustom: v })}
            label="Use a custom frame rate"
          />
          <Check
            checked={spec.shutdownWhenNotVisible}
            onChange={(v) => setSpec({ ...spec, shutdownWhenNotVisible: v })}
            label="Shut down when not visible"
          />
          <Check
            checked={spec.restartWhenActivated}
            onChange={(v) => setSpec({ ...spec, restartWhenActivated: v })}
            label="Refresh when the scene becomes active"
          />
          <Check
            checked={spec.controlAudio}
            onChange={(v) => setSpec({ ...spec, controlAudio: v })}
            label="Route page audio through OBS"
          />
        </div>

        <Field label="Custom CSS">
          <textarea
            className="textarea"
            rows={4}
            style={{ minHeight: 90 }}
            value={spec.css}
            onChange={(e) => setSpec({ ...spec, css: e.target.value })}
          />
        </Field>
      </div>

      <Panel title="Targets">
        <div style={{ display: 'grid', gap: 5 }}>
          {connected.map((instance) => {
            const scenes = snapshots[instance.id]?.scenes ?? []
            return (
              <div key={instance.id} className="row" style={{ gap: 10 }}>
                <Check
                  checked={targets.has(instance.id)}
                  onChange={(checked) =>
                    setTargets((current) => {
                      const next = new Set(current)
                      if (checked) next.add(instance.id)
                      else next.delete(instance.id)
                      return next
                    })
                  }
                  label={instance.name}
                />
                <div className="spacer" />
                <select
                  className="select"
                  style={{ width: 220 }}
                  disabled={!targets.has(instance.id)}
                  value={scenePerInstance[instance.id] ?? ''}
                  onChange={(e) =>
                    setScenePerInstance({ ...scenePerInstance, [instance.id]: e.target.value })
                  }
                >
                  <option value="">Current program scene</option>
                  {scenes.map((scene) => (
                    <option key={scene} value={scene}>
                      {scene}
                    </option>
                  ))}
                </select>
              </div>
            )
          })}
        </div>
      </Panel>
    </Dialog>
  )
}

function CreateOverlayDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [name, setName] = useState('lower-third')
  const [contents, setContents] = useState(STARTER_OVERLAY)
  const [busy, setBusy] = useState(false)

  return (
    <Dialog
      title="New overlay"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="faint">Saved into the workspace asset folder and served immediately.</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || name.trim() === ''}
            onClick={() =>
              void (async () => {
                setBusy(true)
                const result = await guard('Create overlay', () =>
                  window.fleet.createHtmlAsset(name, contents)
                )
                setBusy(false)
                if (result) {
                  toast('success', `Created ${name}.html`)
                  onClose()
                }
              })()
            }
          >
            Create
          </button>
        </>
      }
    >
      <Field label="File name" hint="`.html` is added automatically.">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Contents">
        <textarea
          className="textarea"
          rows={18}
          style={{ minHeight: 340 }}
          value={contents}
          onChange={(e) => setContents(e.target.value)}
          spellCheck={false}
        />
      </Field>
      <Callout tone="info">
        Pages served from the library get a live-reload script and a{' '}
        <code>window.OBSFleet</code> object describing the instance rendering them. Editing the file
        on disk reloads every browser source showing it.
      </Callout>
    </Dialog>
  )
}

function nameOf(instances: Array<{ id: string; name: string }>, id: string): string {
  return instances.find((instance) => instance.id === id)?.name ?? id
}
