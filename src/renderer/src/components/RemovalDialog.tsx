import { useEffect, useState } from 'react'
import type { RemovalPlan } from '@shared/types'
import { Callout, Check, Dialog, Field } from './ui'
import { IconTrash, IconWarning } from './Icons'

/**
 * The confirmation shown before anything is removed.
 *
 * It states consequences rather than asking "are you sure?" — which instances
 * are left without an installation, which are still running, exactly which
 * folders disappear and how big they are. A dialog that only asks for
 * confirmation trains people to click through it.
 *
 * Typing the name is required only when the action destroys files. Guarding
 * every removal that way would be theatre; guarding the irreversible ones is
 * the point.
 */
export function RemovalDialog({
  plan,
  loading,
  deleteFiles,
  onDeleteFilesChange,
  confirmLabel,
  onConfirm,
  onClose
}: {
  plan: RemovalPlan | null
  loading: boolean
  deleteFiles: boolean
  onDeleteFilesChange: ((next: boolean) => void) | null
  confirmLabel: string
  onConfirm: () => void
  onClose: () => void
}): JSX.Element {
  const [typed, setTyped] = useState('')

  // A fresh plan is a different question; a confirmation typed for the last
  // one must not carry over.
  useEffect(() => setTyped(''), [plan?.subject, plan?.destructive])

  const blocked = (plan?.blockers.length ?? 0) > 0
  const needsTyping = plan?.destructive === true
  const nameMatches = typed.trim() === plan?.subject.trim()
  const canConfirm = !loading && !blocked && plan !== null && (!needsTyping || nameMatches)

  return (
    <Dialog
      title={
        <span className="row" style={{ gap: 8 }}>
          <IconWarning size={14} />
          Remove {plan?.subject ?? '…'}
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--danger" disabled={!canConfirm} onClick={onConfirm}>
            <IconTrash size={13} /> {loading ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      {plan === null ? (
        <div className="muted">Working out what this would change…</div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {plan.blockers.map((blocker) => (
            <Callout key={blocker} tone="danger" title="This cannot be done">
              {blocker}
            </Callout>
          ))}

          {onDeleteFilesChange && (
            <Check
              checked={deleteFiles}
              onChange={onDeleteFilesChange}
              label="Also delete the files on disk"
            />
          )}

          {plan.affectedInstances.length > 0 && (
            <Field label={`Instances affected (${plan.affectedInstances.length})`}>
              <div className="chips">
                {plan.affectedInstances.map((name) => (
                  <span key={name} className="chip">
                    {name}
                  </span>
                ))}
              </div>
            </Field>
          )}

          {plan.runningInstances.length > 0 && (
            <Field label="Running right now">
              <div className="chips">
                {plan.runningInstances.map((name) => (
                  <span key={name} className="chip chip--live">
                    {name}
                  </span>
                ))}
              </div>
            </Field>
          )}

          {plan.deletions.length > 0 && (
            <Field label="Folders that will be erased">
              <div style={{ display: 'grid', gap: 4 }}>
                {plan.deletions.map((deletion) => (
                  <div key={deletion.path} className="row mono" style={{ fontSize: 11, gap: 8 }}>
                    <span style={{ wordBreak: 'break-all' }}>{deletion.path}</span>
                    <div className="spacer" />
                    <span className="num faint">
                      {deletion.partialSize ? 'over ' : ''}
                      {formatBytes(deletion.sizeBytes)}
                    </span>
                  </div>
                ))}
              </div>
            </Field>
          )}

          {plan.warnings.map((warning) => (
            <Callout key={warning} tone={plan.destructive ? 'danger' : 'warn'}>
              {warning}
            </Callout>
          ))}

          {plan.warnings.length === 0 && plan.blockers.length === 0 && (
            <Callout>Nothing else uses this. Removing it affects nothing already set up.</Callout>
          )}

          {needsTyping && (
            <Field
              label={`Type "${plan.subject}" to confirm`}
              hint="Required because this deletes files that cannot be recovered."
            >
              <input
                className="input"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder={plan.subject}
                autoFocus
              />
            </Field>
          )}
        </div>
      )}
    </Dialog>
  )
}

/** Local copy so the dialog does not depend on a view's helpers. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}
