import { describe, expect, it } from 'vitest'
import { createSnapshotCache } from '../src/renderer/src/state/snapshot-cache'

/** Stands in for the store's state; only its identity matters here. */
interface FleetState {
  workspace: { instances: unknown[] } | null
}

/**
 * These pin the contract `useSyncExternalStore` imposes and that a blank
 * window is the punishment for breaking: repeated reads must hand back the
 * same reference until the store object itself is replaced.
 *
 * The selector below is the one that actually shipped broken — deriving an
 * empty array while the workspace is still loading — so it is the shape the
 * test uses.
 */
function stateWith(workspace: FleetState['workspace']): FleetState {
  return { workspace }
}

describe('snapshot cache', () => {
  it('returns one reference for a selector that allocates on every call', () => {
    const cache = createSnapshotCache<FleetState, unknown[]>()
    const select = (s: FleetState): unknown[] => s.workspace?.instances ?? []
    const state = stateWith(null)

    const first = cache.read(state, select)
    const second = cache.read(state, select)
    const third = cache.read(state, select)

    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('recomputes when the state object is replaced', () => {
    const cache = createSnapshotCache<FleetState, unknown>()
    const select = (s: FleetState): unknown => s.workspace
    const before = { instances: [{ id: 'a' }] }
    const after = { instances: [{ id: 'b' }] }

    expect(cache.read(stateWith(before), select)).toBe(before)
    expect(cache.read(stateWith(after), select)).toBe(after)
  })

  it('keeps the old reference when an unrelated update leaves the slice alone', () => {
    const cache = createSnapshotCache<FleetState, unknown>()
    const select = (s: FleetState): unknown => s.workspace
    const workspace = { instances: [] }

    const first = cache.read(stateWith(workspace), select)
    // A new state object, same slice: consumers of that slice must not be
    // told anything changed.
    const second = cache.read(stateWith(workspace), select)

    expect(second).toBe(first)
  })

  it('is independent per cache, the way one is per component', () => {
    const a = createSnapshotCache<FleetState, unknown[]>()
    const b = createSnapshotCache<FleetState, unknown[]>()
    const select = (s: FleetState): unknown[] => s.workspace?.instances ?? []
    const state = stateWith(null)

    expect(a.read(state, select)).not.toBe(b.read(state, select))
    expect(a.read(state, select)).toBe(a.read(state, select))
  })
})
