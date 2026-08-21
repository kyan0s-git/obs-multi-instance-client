import { useEffect, useMemo, useState } from 'react'
import type { InstanceAssets, SyncPlan, SyncTransform } from '@shared/types'
import { IconCheck, IconRefresh, IconSync, IconWarning } from '../components/Icons'
import { Callout, Check, Chip, Dialog, Empty, Field, Panel } from '../components/ui'
import { formatBytes, formatRelative, shortHash } from '../lib/format'
import { guard, toast, useFleet } from '../state/store'

function defaultTransform(): SyncTransform {
  return {
    pathRewrites: [],
    retargetRecordingPath: true,
    stripStreamKey: true,
    tagBrowserSources: false,
    regenerateUuids: true
  }
}

/**
 * Copies profiles and scene collections from one instance to others.
 *
 * The matrix answers the question an operator actually has before a show:
 * "does every instance have the same scene collection, and is it the same
 * version?" Hashes make "present but different" visible, which a file listing
 * alone cannot show.
 */
export default function SyncView(): JSX.Element {
  const workspace = useFleet((state) => state.workspace)
  const runtimes = useFleet((state) => state.runtimes)

  const [assets, setAssets] = useState<InstanceAssets[]>([])
  const [loading, setLoading] = useState(true)
  const [sourceId, setSourceId] = useState<string>('')
  const [targets, setTargets] = useState<Set<string>>(new Set())
  const [profiles, setProfiles] = useState<Set<string>>(new Set())
  const [collections, setCollections] = useState<Set<string>>(new Set())
  const [transform, setTransform] = useState<SyncTransform>(defaultTransform())
  const [skipIdentical, setSkipIdentical] = useState(true)
  const [plan, setPlan] = useState<SyncPlan | null>(null)
  const [applying, setApplying] = useState(false)

  const instances = useMemo(
    () => [...(workspace?.instances ?? [])].sort((a, b) => a.order - b.order),
    [workspace]
  )

  const reload = async (): Promise<void> => {
    setLoading(true)
    const result = await guard('Read instance assets', () => window.fleet.readAllAssets())
    setAssets(result ?? [])
    setLoading(false)
  }

  useEffect(() => {
    void reload()
  }, [])

  useEffect(() => {
    if (sourceId === '' && instances.length > 0) setSourceId(instances[0].id)
  }, [instances, sourceId])

  const sourceAssets = assets.find((entry) => entry.instanceId === sourceId)

  const buildPlan = async (): Promise<void> => {
    const result = await guard('Plan sync', () =>
      window.fleet.planSync({
        sourceInstanceId: sourceId,
        targetInstanceIds: [...targets],
        profiles: [...profiles],
        sceneCollections: [...collections],
        transform,
        skipIdentical
      })
    )
    if (result) setPlan(result)
  }

  const applyPlan = async (): Promise<void> => {
    if (!plan) return
    setApplying(true)
    const result = await guard('Apply sync', () => window.fleet.applySync(plan, transform))
    setApplying(false)
    if (!result) return

    setPlan(null)
    await reload()

    if (result.failed.length === 0) {
      toast('success', `Synced ${result.applied.length} item(s)`)
    } else {
      toast(
        'warn',
        `${result.failed.length} of ${plan.items.length} failed`,
        result.failed.map((entry) => `${entry.item.assetName}: ${entry.error}`).join('\n')
      )
    }
  }

  if (instances.length < 2) {
    return (
      <Empty title="Sync needs at least two instances">
        Create another instance and you can copy profiles and scene collections between them.
      </Empty>
    )
  }

  const selectionCount = profiles.size + collections.size
  const canPlan = sourceId !== '' && targets.size > 0 && selectionCount > 0

  return (
    <>
      <Panel
        title="Fleet consistency"
        actions={
          <button className="btn btn--sm" onClick={() => void reload()} disabled={loading}>
            <IconRefresh size={12} /> {loading ? 'Reading…' : 'Refresh'}
          </button>
        }
        flush
      >
        <ConsistencyMatrix instances={instances} assets={assets} sourceId={sourceId} />
      </Panel>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 16 }}>
        <Panel title="What to copy">
          <div style={{ display: 'grid', gap: 14 }}>
            <Field label="Source instance">
              <select
                className="select"
                value={sourceId}
                onChange={(e) => {
                  setSourceId(e.target.value)
                  setProfiles(new Set())
                  setCollections(new Set())
                  setTargets((current) => {
                    const next = new Set(current)
                    next.delete(e.target.value)
                    return next
                  })
                }}
              >
                {instances.map((instance) => (
                  <option key={instance.id} value={instance.id}>
                    {instance.name}
                  </option>
                ))}
              </select>
            </Field>

            {sourceAssets?.error && <Callout tone="danger">{sourceAssets.error}</Callout>}

            <div className="grid-2">
              <AssetPicker
                title="Profiles"
                items={sourceAssets?.profiles ?? []}
                selected={profiles}
                onChange={setProfiles}
              />
              <AssetPicker
                title="Scene collections"
                items={sourceAssets?.sceneCollections ?? []}
                selected={collections}
                onChange={setCollections}
              />
            </div>
          </div>
        </Panel>

        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          <Panel
            title="Targets"
            actions={
              <button
                className="btn btn--sm btn--ghost"
                onClick={() => {
                  const others = instances.filter((instance) => instance.id !== sourceId)
                  setTargets(
                    targets.size === others.length
                      ? new Set()
                      : new Set(others.map((instance) => instance.id))
                  )
                }}
              >
                {targets.size === instances.length - 1 ? 'None' : 'All'}
              </button>
            }
          >
            <div style={{ display: 'grid', gap: 3 }}>
              {instances
                .filter((instance) => instance.id !== sourceId)
                .map((instance) => {
                  const runtime = runtimes[instance.id]
                  const isRunning =
                    runtime && runtime.state !== 'stopped' && runtime.state !== 'crashed'
                  return (
                    <div key={instance.id} className="row">
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
                      {isRunning && <Chip tone="warn">running</Chip>}
                    </div>
                  )
                })}
            </div>
            {[...targets].some((id) => {
              const runtime = runtimes[id]
              return runtime && runtime.state !== 'stopped' && runtime.state !== 'crashed'
            }) && (
              <Callout>
                A running instance keeps its current configuration in memory. Restart it after the
                sync for the copied files to take effect.
              </Callout>
            )}
          </Panel>

          <Panel title="Rewrites">
            <div style={{ display: 'grid', gap: 6 }}>
              <Check
                checked={transform.retargetRecordingPath}
                onChange={(v) => setTransform({ ...transform, retargetRecordingPath: v })}
                label="Point recording output at each target's own folder"
              />
              <span className="field__hint" style={{ marginTop: -2, marginLeft: 22 }}>
                Without this, every instance using the copied profile records to the same directory
                with the same filename pattern and they overwrite each other.
              </span>

              <Check
                checked={transform.stripStreamKey}
                onChange={(v) => setTransform({ ...transform, stripStreamKey: v })}
                label="Clear stream keys in copied profiles"
              />
              <Check
                checked={transform.regenerateUuids}
                onChange={(v) => setTransform({ ...transform, regenerateUuids: v })}
                label="Give copied sources fresh UUIDs"
              />
              <Check
                checked={transform.tagBrowserSources}
                onChange={(v) => setTransform({ ...transform, tagBrowserSources: v })}
                label="Tag browser source URLs with the target instance"
              />
              <Check checked={skipIdentical} onChange={setSkipIdentical} label="Skip identical copies" />

              <Field
                label="Path replacements"
                hint="One per line as from => to. Applied to every path inside the copied files."
              >
                <textarea
                  className="textarea"
                  rows={3}
                  style={{ minHeight: 60 }}
                  placeholder="D:\Media => E:\Media"
                  value={transform.pathRewrites
                    .map((rewrite) => `${rewrite.from} => ${rewrite.to}`)
                    .join('\n')}
                  onChange={(e) =>
                    setTransform({
                      ...transform,
                      pathRewrites: e.target.value
                        .split('\n')
                        .map((line) => line.split('=>'))
                        .filter((parts) => parts.length === 2)
                        .map(([from, to]) => ({ from: from.trim(), to: to.trim() }))
                        .filter((rewrite) => rewrite.from !== '')
                    })
                  }
                />
              </Field>
            </div>
          </Panel>

          <button
            className="btn btn--primary"
            disabled={!canPlan}
            onClick={() => void buildPlan()}
          >
            <IconSync size={13} /> Review {selectionCount} item
            {selectionCount === 1 ? '' : 's'} to {targets.size} target
            {targets.size === 1 ? '' : 's'}
          </button>
        </div>
      </div>

      {plan && (
        <Dialog
          title="Confirm sync"
          wide
          onClose={() => setPlan(null)}
          footer={
            <>
              <span className="faint">
                {plan.items.filter((item) => item.action === 'overwrite').length} overwrite,{' '}
                {plan.items.filter((item) => item.action === 'create').length} new,{' '}
                {plan.items.filter((item) => item.action === 'skip-identical').length} unchanged
              </span>
              <div className="spacer" />
              <button className="btn" onClick={() => setPlan(null)}>
                Cancel
              </button>
              <button
                className="btn btn--primary"
                disabled={applying || plan.items.length === 0}
                onClick={() => void applyPlan()}
              >
                {applying ? 'Copying…' : 'Apply'}
              </button>
            </>
          }
        >
          {plan.warnings.map((warning, index) => (
            <Callout key={index}>{warning}</Callout>
          ))}

          <div className="table__scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Kind</th>
                  <th>Asset</th>
                  <th>Target instance</th>
                  <th>Destination</th>
                </tr>
              </thead>
              <tbody>
                {plan.items.map((item, index) => (
                  <tr key={index}>
                    <td>
                      <Chip
                        tone={
                          item.action === 'overwrite'
                            ? 'warn'
                            : item.action === 'create'
                              ? 'ok'
                              : undefined
                        }
                      >
                        {item.action === 'skip-identical' ? 'unchanged' : item.action}
                      </Chip>
                    </td>
                    <td className="muted">
                      {item.kind === 'profile' ? 'Profile' : 'Scene collection'}
                    </td>
                    <td>
                      {item.assetName}
                      {item.targetName !== item.assetName && (
                        <span className="faint"> → {item.targetName}</span>
                      )}
                    </td>
                    <td>{nameOf(instances, item.targetInstanceId)}</td>
                    <td className="mono faint truncate" style={{ maxWidth: 320 }}>
                      {item.targetPath}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {plan.items.length === 0 && (
            <Callout>Nothing to do — every selected item is already identical on the targets.</Callout>
          )}
        </Dialog>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */

function AssetPicker({
  title,
  items,
  selected,
  onChange
}: {
  title: string
  items: Array<{ slug: string; name: string; sizeBytes: number; modifiedAt: number }>
  selected: Set<string>
  onChange: (next: Set<string>) => void
}): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
      <div className="row">
        <span className="field__label">{title}</span>
        <div className="spacer" />
        <button
          className="btn btn--ghost btn--sm"
          onClick={() =>
            onChange(
              selected.size === items.length ? new Set() : new Set(items.map((item) => item.slug))
            )
          }
        >
          {selected.size === items.length && items.length > 0 ? 'None' : 'All'}
        </button>
      </div>

      {items.length === 0 && <span className="faint">None found.</span>}

      {items.map((item) => (
        <div key={item.slug} className="row" style={{ gap: 8 }}>
          <Check
            checked={selected.has(item.slug)}
            onChange={(checked) => {
              const next = new Set(selected)
              if (checked) next.add(item.slug)
              else next.delete(item.slug)
              onChange(next)
            }}
            label={item.name}
          />
          <div className="spacer" />
          <span className="faint num" style={{ fontSize: 11 }}>
            {formatBytes(item.sizeBytes)} · {formatRelative(item.modifiedAt)}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Cross-tab of every asset against every instance.
 *
 * The source instance's hash is the reference; a target holding the same name
 * but a different hash is the case worth catching.
 */
function ConsistencyMatrix({
  instances,
  assets,
  sourceId
}: {
  instances: Array<{ id: string; name: string; color: string }>
  assets: InstanceAssets[]
  sourceId: string
}): JSX.Element {
  const byInstance = new Map(assets.map((entry) => [entry.instanceId, entry]))

  const allNames = useMemo(() => {
    const profiles = new Set<string>()
    const collections = new Set<string>()
    for (const entry of assets) {
      for (const profile of entry.profiles) profiles.add(profile.slug)
      for (const collection of entry.sceneCollections) collections.add(collection.slug)
    }
    return {
      profiles: [...profiles].sort(),
      collections: [...collections].sort()
    }
  }, [assets])

  const reference = byInstance.get(sourceId)

  const renderRow = (
    slug: string,
    kind: 'profile' | 'sceneCollection'
  ): JSX.Element => {
    const refAsset =
      kind === 'profile'
        ? reference?.profiles.find((asset) => asset.slug === slug)
        : reference?.sceneCollections.find((asset) => asset.slug === slug)

    return (
      <tr key={`${kind}-${slug}`}>
        <td>
          <span className="row" style={{ gap: 6 }}>
            <span className="faint" style={{ fontSize: 10, textTransform: 'uppercase' }}>
              {kind === 'profile' ? 'PRF' : 'SC'}
            </span>
            {slug}
          </span>
        </td>
        {instances.map((instance) => {
          const entry = byInstance.get(instance.id)
          const asset =
            kind === 'profile'
              ? entry?.profiles.find((candidate) => candidate.slug === slug)
              : entry?.sceneCollections.find((candidate) => candidate.slug === slug)

          if (!asset) {
            return (
              <td key={instance.id} className="faint" title="Not present">
                —
              </td>
            )
          }

          const matches = refAsset ? asset.hash === refAsset.hash : true
          return (
            <td
              key={instance.id}
              title={`${asset.name} · ${shortHash(asset.hash)} · ${formatRelative(asset.modifiedAt)}`}
              style={{ color: matches ? 'var(--ok)' : 'var(--warn)' }}
            >
              {matches ? <IconCheck size={13} /> : <IconWarning size={13} />}
            </td>
          )
        })}
      </tr>
    )
  }

  if (allNames.profiles.length === 0 && allNames.collections.length === 0) {
    return (
      <div className="panel__body">
        <span className="faint">No profiles or scene collections found yet.</span>
      </div>
    )
  }

  return (
    <div className="table__scroll">
      <table className="table matrix">
        <thead>
          <tr>
            <th style={{ minWidth: 220 }}>Asset</th>
            {instances.map((instance) => (
              <th key={instance.id} title={instance.name}>
                <span
                  style={{
                    display: 'inline-block',
                    width: 18,
                    height: 3,
                    borderRadius: 2,
                    background: instance.color,
                    marginBottom: 3
                  }}
                />
                <div className="truncate" style={{ maxWidth: 90 }}>
                  {instance.name}
                  {instance.id === sourceId && ' *'}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {allNames.profiles.map((slug) => renderRow(slug, 'profile'))}
          {allNames.collections.map((slug) => renderRow(slug, 'sceneCollection'))}
        </tbody>
      </table>
    </div>
  )
}

function nameOf(instances: Array<{ id: string; name: string }>, id: string): string {
  return instances.find((instance) => instance.id === id)?.name ?? id
}
