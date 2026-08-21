export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Rejects with `message` if `promise` has not settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * Runs `worker` over `items` with at most `limit` in flight, preserving
 * input order in the result. Used so bulk operations across a dozen
 * instances do not open a dozen simultaneous websocket storms.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })

  await Promise.all(runners)
  return results
}

/**
 * Coalesces bursts of calls into a single trailing invocation. Telemetry and
 * workspace broadcasts use this so a flurry of changes produces one IPC push.
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number
): ((...args: A) => void) & { cancel: () => void; flush: () => void } {
  let timer: NodeJS.Timeout | null = null
  let pending: A | null = null

  const invoke = (): void => {
    timer = null
    if (pending) {
      const args = pending
      pending = null
      fn(...args)
    }
  }

  const wrapped = (...args: A): void => {
    pending = args
    if (timer) clearTimeout(timer)
    timer = setTimeout(invoke, ms)
  }

  wrapped.cancel = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    pending = null
  }
  wrapped.flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      invoke()
    }
  }

  return wrapped
}
