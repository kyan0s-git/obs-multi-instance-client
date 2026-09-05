import path from 'node:path'
import type { ObsInstall, ObsInstance, RemovalPlan } from '@shared/types'
import { dirSize, pathExists } from '../util/fsx.js'
import { workspacePaths } from './paths.js'

/**
 * Works out what removing something would do, before it is done.
 *
 * Deletion here is not "remove a row": an instance folder can hold the only
 * copy of a show's scene collections and its recordings, and an installation
 * can be the one several instances launch from. The rule used to be a flat
 * refusal whenever anything referenced the target, which is safe but leaves an
 * operator unable to clear an entry for an OBS that no longer exists.
 *
 * So instead: say exactly what breaks, let them decide, and keep only the
 * refusals that protect files this application does not own.
 */

export interface RemovalContext {
  workspaceRoot: string
  instances: ObsInstance[]
  installs: ObsInstall[]
  /** Instance ids with a live OBS process. */
  runningIds: Set<string>
}

export async function planInstanceRemoval(
  instanceId: string,
  deleteFiles: boolean,
  context: RemovalContext
): Promise<RemovalPlan> {
  const instance = context.instances.find((entry) => entry.id === instanceId)

  if (!instance) {
    return emptyPlan('This instance', ['That instance is no longer in the roster.'])
  }

  const plan: RemovalPlan = {
    subject: instance.name,
    affectedInstances: [],
    runningInstances: context.runningIds.has(instanceId) ? [instance.name] : [],
    deletions: [],
    warnings: [],
    blockers: [],
    destructive: false
  }

  if (plan.runningInstances.length > 0) {
    plan.warnings.push(
      `${instance.name} is running. It will be left running and will keep its window open, ` +
        'but OBS Fleet will no longer control or supervise it.'
    )
  }

  if (deleteFiles) {
    const workspace = workspacePaths(context.workspaceRoot)
    const resolved = path.resolve(instance.dir)
    const guard = path.resolve(workspace.instances)

    // The one refusal kept: never delete outside the workspace. An instance
    // adopted from elsewhere is unregistered, never erased.
    if (resolved === guard || !resolved.startsWith(guard + path.sep)) {
      plan.warnings.push(
        `${resolved} is outside the workspace, so its files will be left alone. ` +
          'The instance will be removed from the roster only.'
      )
    } else if (await pathExists(instance.dir)) {
      plan.deletions.push({ path: instance.dir, sizeBytes: await dirSize(instance.dir).catch(() => 0) })
      plan.destructive = true
      plan.warnings.push(
        'This deletes the instance folder, including its profiles, scene collections and any ' +
          'recordings still inside it. There is no undo.'
      )
    }
  }

  return plan
}

export async function planInstallRemoval(
  installId: string,
  deleteFiles: boolean,
  context: RemovalContext
): Promise<RemovalPlan> {
  const install = context.installs.find((entry) => entry.id === installId)

  if (!install) {
    return emptyPlan('This installation', ['That installation is no longer registered.'])
  }

  const users = context.instances.filter((instance) => instance.installId === installId)

  const plan: RemovalPlan = {
    subject: install.label,
    affectedInstances: users.map((instance) => instance.name),
    runningInstances: users
      .filter((instance) => context.runningIds.has(instance.id))
      .map((instance) => instance.name),
    deletions: [],
    warnings: [],
    blockers: [],
    destructive: false
  }

  if (users.length > 0) {
    plan.warnings.push(
      `${users.length} instance(s) launch from this installation. They will keep their settings ` +
        'and recordings, but each needs another installation chosen before it can start again.'
    )
  }

  if (plan.runningInstances.length > 0) {
    plan.warnings.push(
      'Some of those instances are running now. Removing the installation does not stop them, ' +
        'but they cannot be restarted until they point somewhere valid.'
    )
  }

  if (deleteFiles) {
    if (!install.managed) {
      // Auto-detected and hand-added installs belong to the system. Deleting
      // one would uninstall the user's OBS, which is not this app's business.
      plan.blockers.push(
        'OBS Fleet did not install this copy of OBS, so it will not delete it. ' +
          'Remove it with the installer that put it there; this only clears the entry.'
      )
    } else if (await pathExists(install.root)) {
      plan.deletions.push({ path: install.root, sizeBytes: await dirSize(install.root).catch(() => 0) })
      plan.destructive = true
      plan.warnings.push(
        'This deletes the downloaded OBS build itself. Instances using it will need another ' +
          'installation, and the build would have to be downloaded again.'
      )
    }
  }

  return plan
}

/**
 * Instances whose install is about to disappear.
 *
 * Returned so the caller can offer to repoint them in the same action rather
 * than leaving the operator to fix each one by hand.
 */
export function instancesUsingInstall(installId: string, instances: ObsInstance[]): ObsInstance[] {
  return instances.filter((instance) => instance.installId === installId)
}

/** Whether an instance folder is inside the workspace and safe to delete. */
export function isInsideWorkspace(instanceDir: string, workspaceRoot: string): boolean {
  const guard = path.resolve(workspacePaths(workspaceRoot).instances)
  const resolved = path.resolve(instanceDir)
  return resolved !== guard && resolved.startsWith(guard + path.sep)
}

function emptyPlan(subject: string, blockers: string[]): RemovalPlan {
  return {
    subject,
    affectedInstances: [],
    runningInstances: [],
    deletions: [],
    warnings: [],
    blockers,
    destructive: false
  }
}
