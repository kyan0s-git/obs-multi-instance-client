/**
 * Snapshot memoisation for `useSyncExternalStore`.
 *
 * `useSyncExternalStore` requires `getSnapshot` to return the *same reference*
 * every time it is called while the store is unchanged. React calls it more
 * than once per render to check for tearing, so a selector that derives a
 * fresh value on each call — `state.workspace?.instances ?? []` was the one
 * that shipped — looks to React like a store that never stops changing. It
 * gives up with "Maximum update depth exceeded", the render throws, and the
 * window is blank: not a degraded UI, no UI at all.
 *
 * Caching on the identity of the state object makes any selector safe. That
 * works because the store always replaces its state rather than mutating it,
 * which is the property this depends on.
 *
 * Kept free of React and DOM types so it can be tested directly; that is why
 * `tsconfig.node.json` can list this one renderer file without pulling the DOM
 * into the main-process project.
 */

export interface SnapshotCache<S, T> {
  read(current: S, selector: (state: S) => T): T
}

/** One cache per consumer; they must not share, or they would fight. */
export function createSnapshotCache<S, T>(): SnapshotCache<S, T> {
  let lastState: S
  let lastValue: T
  let primed = false

  return {
    read(current, selector) {
      if (primed && lastState === current) return lastValue

      const next = selector(current)
      // Hold the previous reference when the derived value did not actually
      // change, so an unrelated event in the same tick does not re-render
      // every consumer of the store.
      lastValue = primed && Object.is(next, lastValue) ? lastValue : next
      lastState = current
      primed = true
      return lastValue
    }
  }
}
