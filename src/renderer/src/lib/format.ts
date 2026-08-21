/** Presentation helpers. Everything here is pure and display-only. */

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

export function formatMb(mb: number | null | undefined): string {
  if (mb === null || mb === undefined || !Number.isFinite(mb)) return '—'
  if (mb >= 1_048_576) return `${(mb / 1_048_576).toFixed(1)} TB`
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.round(mb)} MB`
}

export function formatKbps(kbps: number | null | undefined): string {
  if (kbps === null || kbps === undefined || !Number.isFinite(kbps)) return '—'
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(2)} Mb/s`
  return `${Math.round(kbps)} kb/s`
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}%`
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value.toFixed(2)} ms`
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString()
}

/** `h:mm:ss` for on-air timers; drops the hour when it is zero. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

export function formatUptime(startedAt: number | null): string {
  if (startedAt === null) return '—'
  return formatDuration(Date.now() - startedAt)
}

export function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false })
}

export function formatDateTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { hour12: false })
}

export function formatRelative(at: number | null | undefined): string {
  if (!at) return 'never'
  const delta = Date.now() - at
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} h ago`
  return `${Math.floor(delta / 86_400_000)} d ago`
}

/** Percentage of frames dropped between two cumulative counters. */
export function dropPercent(skipped: number | null, total: number | null): number | null {
  if (skipped === null || total === null || total <= 0) return null
  return (skipped / total) * 100
}

export function shortHash(hash: string): string {
  return hash.slice(0, 8)
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}
