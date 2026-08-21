import { EventEmitter } from 'node:events'
import type { LogEntry, LogLevel } from '@shared/types'

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * In-memory ring-buffer log that also mirrors to stdout. The renderer
 * subscribes to `entry` so the Logs pane stays live without polling.
 */
class Logger extends EventEmitter {
  private buffer: LogEntry[] = []
  private nextId = 1
  private capacity = 2000
  private minLevel: LogLevel = process.env.OBSFLEET_LOG_LEVEL === 'debug' ? 'debug' : 'info'

  setLevel(level: LogLevel): void {
    this.minLevel = level
  }

  write(level: LogLevel, scope: string, message: string, instanceId: string | null = null): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return

    const entry: LogEntry = { id: this.nextId++, at: Date.now(), level, scope, message, instanceId }
    this.buffer.push(entry)
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity)
    }

    const line = `[${new Date(entry.at).toISOString()}] ${level.toUpperCase().padEnd(5)} ${scope} — ${message}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)

    this.emit('entry', entry)
  }

  debug(scope: string, message: string, instanceId?: string | null): void {
    this.write('debug', scope, message, instanceId ?? null)
  }

  info(scope: string, message: string, instanceId?: string | null): void {
    this.write('info', scope, message, instanceId ?? null)
  }

  warn(scope: string, message: string, instanceId?: string | null): void {
    this.write('warn', scope, message, instanceId ?? null)
  }

  error(scope: string, message: string, instanceId?: string | null): void {
    this.write('error', scope, message, instanceId ?? null)
  }

  history(limit = 500): LogEntry[] {
    return this.buffer.slice(-limit)
  }

  clear(): void {
    this.buffer = []
  }
}

export const log = new Logger()

/** Normalises anything thrown into a readable single-line message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
