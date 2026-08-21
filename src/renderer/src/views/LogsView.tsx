import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogLevel } from '@shared/types'
import { IconTrash } from '../components/Icons'
import { Check, Panel } from '../components/ui'
import { formatTime } from '../lib/format'
import { guard, toast, useFleet } from '../state/store'

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

/**
 * Combined client and OBS output.
 *
 * OBS's own stdout/stderr is forwarded here per instance, which is usually
 * enough to diagnose a failed launch without going hunting for OBS log files
 * (the link to those is one button away regardless).
 */
export default function LogsView(): JSX.Element {
  const logs = useFleet((state) => state.logs)
  const workspace = useFleet((state) => state.workspace)

  const [levels, setLevels] = useState<Set<LogLevel>>(new Set(['info', 'warn', 'error']))
  const [instanceFilter, setInstanceFilter] = useState<string>('')
  const [search, setSearch] = useState('')
  const [follow, setFollow] = useState(true)

  const scrollRef = useRef<HTMLDivElement | null>(null)

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return logs.filter((entry) => {
      if (!levels.has(entry.level)) return false
      if (instanceFilter !== '' && entry.instanceId !== instanceFilter) return false
      if (needle !== '') {
        return (
          entry.message.toLowerCase().includes(needle) ||
          entry.scope.toLowerCase().includes(needle)
        )
      }
      return true
    })
  }, [logs, levels, instanceFilter, search])

  useEffect(() => {
    if (!follow || !scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [filtered, follow])

  const instances = workspace?.instances ?? []

  return (
    <Panel
      title={`Logs (${filtered.length}/${logs.length})`}
      actions={
        <div className="row" style={{ gap: 10 }}>
          <div className="btn-group">
            {LEVELS.map((level) => (
              <button
                key={level}
                className={`btn btn--sm ${levels.has(level) ? 'btn--primary' : ''}`}
                onClick={() =>
                  setLevels((current) => {
                    const next = new Set(current)
                    if (next.has(level)) next.delete(level)
                    else next.add(level)
                    return next
                  })
                }
              >
                {level}
              </button>
            ))}
          </div>

          <select
            className="select"
            style={{ width: 170 }}
            value={instanceFilter}
            onChange={(e) => setInstanceFilter(e.target.value)}
          >
            <option value="">All sources</option>
            {instances.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.name}
              </option>
            ))}
          </select>

          <input
            className="input"
            style={{ width: 200 }}
            placeholder="Filter…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <Check checked={follow} onChange={setFollow} label="Follow" />

          <button
            className="btn btn--sm"
            onClick={() => {
              void navigator.clipboard.writeText(
                filtered
                  .map(
                    (entry) =>
                      `${new Date(entry.at).toISOString()} ${entry.level.toUpperCase()} ${entry.scope} ${entry.message}`
                  )
                  .join('\n')
              )
              toast('success', `Copied ${filtered.length} line(s)`)
            }}
          >
            Copy
          </button>

          <button
            className="btn btn--sm btn--ghost"
            onClick={() => void guard('Clear logs', () => window.fleet.clearLogs())}
          >
            <IconTrash size={12} />
          </button>
        </div>
      }
      flush
    >
      <div className="logs" ref={scrollRef}>
        {filtered.length === 0 && <span className="faint">Nothing matches the current filter.</span>}
        {filtered.map((entry) => (
          <div key={entry.id} className={`logline logline--${entry.level}`}>
            <span className="logline__time">{formatTime(entry.at)}</span>
            <span className="logline__level">{entry.level}</span>
            <span className="logline__scope truncate" title={entry.scope}>
              {entry.scope}
            </span>
            <span className="logline__msg">{entry.message}</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}
