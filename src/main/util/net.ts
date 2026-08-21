import net from 'node:net'

/** Resolves true when nothing is listening on `port` for the given host. */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

/**
 * Finds the lowest free TCP port at or above `start`, skipping anything in
 * `reserved` (ports already handed out to other instances).
 */
export async function findFreePort(
  start: number,
  reserved: Iterable<number> = [],
  span = 200
): Promise<number> {
  const taken = new Set(reserved)
  for (let port = start; port < start + span; port += 1) {
    if (taken.has(port)) continue
    if (await isPortFree(port)) return port
  }
  throw new Error(`No free TCP port found in ${start}-${start + span}`)
}

/** Resolves once something accepts a TCP connection on `port`, or times out. */
export function waitForPort(
  port: number,
  host: string,
  timeoutMs: number,
  intervalMs = 250
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const attempt = (): void => {
      const socket = net.connect({ port, host })
      const cleanup = (result: boolean): void => {
        socket.removeAllListeners()
        socket.destroy()
        if (result) return resolve(true)
        if (Date.now() >= deadline) return resolve(false)
        setTimeout(attempt, intervalMs)
      }
      socket.once('connect', () => cleanup(true))
      socket.once('error', () => cleanup(false))
      socket.setTimeout(Math.min(intervalMs * 4, 2000), () => cleanup(false))
    }
    attempt()
  })
}
