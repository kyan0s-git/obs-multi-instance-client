import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Platform } from '@shared/types'
import { log, errorMessage } from './logger.js'

const run = promisify(execFile)
const platform = process.platform as Platform

/**
 * Finds the pid of whatever is listening on a loopback TCP port.
 *
 * Used to take control of an OBS instance this session did not launch. The
 * client deliberately leaves instances running when it quits, so on the next
 * start it can reconnect over the websocket — but stopping one cleanly needs
 * a real pid, and the websocket protocol has no request that reports it.
 */
export async function findListenerPid(port: number): Promise<number | null> {
  try {
    if (platform === 'win32') return await findListenerPidWindows(port)
    return await findListenerPidPosix(port)
  } catch (err) {
    log.debug('process', `Could not resolve listener on port ${port}: ${errorMessage(err)}`)
    return null
  }
}

async function findListenerPidPosix(port: number): Promise<number | null> {
  try {
    const { stdout } = await run(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { timeout: 6000 }
    )
    const pid = Number(stdout.trim().split('\n')[0])
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    // lsof is missing on some minimal systems; ss is the usual replacement.
    return findListenerPidSs(port)
  }
}

async function findListenerPidSs(port: number): Promise<number | null> {
  try {
    const { stdout } = await run('ss', ['-lptnH', `sport = :${port}`], { timeout: 6000 })
    const match = stdout.match(/pid=(\d+)/)
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}

async function findListenerPidWindows(port: number): Promise<number | null> {
  const { stdout } = await run('netstat.exe', ['-ano', '-p', 'TCP'], {
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  })

  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    // Proto  Local Address  Foreign Address  State  PID
    if (parts.length < 5 || parts[3] !== 'LISTENING') continue

    const localPort = Number(parts[1].split(':').pop())
    if (localPort !== port) continue

    const pid = Number(parts[4])
    if (Number.isFinite(pid) && pid > 0) return pid
  }

  return null
}

/**
 * Asks a process to close, then terminates it if it will not.
 *
 * Mirrors the launcher's escalation for processes it does not own, which is
 * what makes an adopted instance stoppable at all.
 */
export async function stopPid(
  pid: number,
  options: { force?: boolean } = {}
): Promise<void> {
  const args = options.force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T']

  if (platform === 'win32') {
    await run('taskkill.exe', args, { timeout: 10_000, windowsHide: true })
    return
  }

  process.kill(pid, options.force ? 'SIGKILL' : 'SIGTERM')
}

/** True when a pid still exists (and we are allowed to see it). */
export function pidAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering.
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
