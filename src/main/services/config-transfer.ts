import type {
  ConfigExport,
  ConfigImportOptions,
  ConfigImportPlan,
  ConfigInstanceEntry,
  ObsInstance,
  WorkspaceSettings
} from '@shared/types'
import { CONFIG_FORMAT } from '@shared/types'
import { mergeLaunchOptions, mergeSettings } from './defaults.js'

/**
 * The client's own configuration, as a portable document.
 *
 * Distinct from a bundle on purpose. A bundle carries OBS's files — profiles,
 * scene collections, dock layouts — and is measured in megabytes. This carries
 * how the fleet itself is arranged, and is small enough to keep in a show
 * repository, diff between rigs, or paste into a ticket when something is set
 * up wrongly.
 *
 * The planner is pure so an import can be shown before it is applied: taking
 * someone else's configuration is exactly the operation where "what is this
 * about to change" matters.
 */

export const CONFIG_VERSION = 1

/* ------------------------------------------------------------------ */
/* Export                                                             */
/* ------------------------------------------------------------------ */

export function buildConfigExport(
  settings: WorkspaceSettings,
  instances: ObsInstance[],
  options: { includeSecrets: boolean; appVersion: string }
): ConfigExport {
  return {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    createdAt: Date.now(),
    createdBy: `OBS Fleet ${options.appVersion}`,
    platform: process.platform,
    settings,
    instances: [...instances]
      .sort((a, b) => a.order - b.order)
      .map((instance) => toEntry(instance, options.includeSecrets)),
    includesSecrets: options.includeSecrets
  }
}

function toEntry(instance: ObsInstance, includeSecrets: boolean): ConfigInstanceEntry {
  return {
    name: instance.name,
    role: instance.role,
    color: instance.color,
    notes: instance.notes,
    isolation: instance.isolation,
    disabled: instance.disabled,
    autoRestart: instance.autoRestart,
    order: instance.order,
    launch: instance.launch,
    websocket: {
      enabled: instance.websocket.enabled,
      port: instance.websocket.port,
      ipv4Only: instance.websocket.ipv4Only,
      // A password is a credential, so it travels only when explicitly asked
      // for. Without it an imported instance gets a freshly generated one.
      ...(includeSecrets ? { password: instance.websocket.password } : {})
    }
  }
}

/* ------------------------------------------------------------------ */
/* Import                                                            */
/* ------------------------------------------------------------------ */

/** Validates a document and reports why it cannot be used, if it cannot. */
export function readConfigExport(json: string): ConfigExport {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('That file is not valid JSON, so it is not an OBS Fleet configuration.')
  }

  const document = parsed as Partial<ConfigExport>

  if (document.format !== CONFIG_FORMAT) {
    throw new Error(
      'That file is not an OBS Fleet configuration. A fleet bundle (.zip) is imported from the Sync page instead.'
    )
  }

  if (typeof document.version !== 'number' || document.version > CONFIG_VERSION) {
    throw new Error(
      `This configuration was written by a newer version of OBS Fleet (format ${String(document.version)}, ` +
        `this build understands ${CONFIG_VERSION}).`
    )
  }

  return {
    ...document,
    settings: mergeSettings(document.settings ?? null),
    instances: Array.isArray(document.instances) ? document.instances : []
  } as ConfigExport
}

/**
 * Works out what importing would change.
 *
 * Settings are compared key by key so the confirmation can list them, rather
 * than saying "settings will be replaced" and leaving the operator to find out
 * that the workspace root moved.
 */
export function planConfigImport(
  current: { settings: WorkspaceSettings; instances: ObsInstance[]; installCount?: number },
  incoming: ConfigExport,
  options: ConfigImportOptions
): ConfigImportPlan {
  const plan: ConfigImportPlan = {
    settingChanges: [],
    newInstances: [],
    updatedInstances: [],
    skippedInstances: [],
    warnings: [],
    blockers: []
  }

  if (options.settings) {
    for (const [key, value] of Object.entries(incoming.settings)) {
      const mine = current.settings[key as keyof WorkspaceSettings]

      // Paths and ports are properties of this machine. Importing them from
      // another rig is the fastest way to point a fleet at a folder that does
      // not exist, so they are held back unless asked for.
      if (options.keepLocalPaths && MACHINE_SPECIFIC.has(key)) continue
      if (stringify(mine) === stringify(value)) continue

      plan.settingChanges.push({ key, from: stringify(mine), to: stringify(value) })
    }

    if (!options.keepLocalPaths) {
      plan.warnings.push(
        'The workspace root and ports are being taken from the document. If they name folders or ' +
          'ports that do not exist on this machine, instances will not start until they are fixed.'
      )
    }
  }

  if (options.instances) {
    const byName = new Map(current.instances.map((instance) => [instance.name, instance]))

    for (const entry of incoming.instances) {
      const existing = byName.get(entry.name)
      if (!existing) {
        plan.newInstances.push(entry.name)
      } else if (options.existing === 'update') {
        plan.updatedInstances.push(entry.name)
      } else {
        plan.skippedInstances.push(entry.name)
      }
    }

    if (plan.newInstances.length > 0) {
      plan.warnings.push(
        `${plan.newInstances.length} instance(s) will be created. Their folders are provisioned ` +
          'empty — profiles and scene collections come from a bundle, not from this document.'
      )
    }

    if (!incoming.includesSecrets && plan.newInstances.length > 0) {
      plan.warnings.push(
        'This document carries no websocket passwords, so new instances get freshly generated ones.'
      )
    }
  }

  if (incoming.platform !== process.platform) {
    plan.warnings.push(
      `This configuration was written on ${incoming.platform} and this machine is ${process.platform}. ` +
        'Instance isolation differs between platforms and will be re-chosen locally.'
    )
  }

  if (!options.settings && !options.instances) {
    plan.blockers.push('Nothing selected to import.')
  }

  // An instance needs an OBS to launch. Creating them against nothing would
  // produce a roster of instances that all fail at the first launch, which is
  // worse than refusing here.
  if (options.instances && plan.newInstances.length > 0 && current.installCount === 0) {
    plan.blockers.push(
      'No OBS installation is registered, so instances cannot be created. Install or add one from ' +
        'the OBS library first.'
    )
  }

  return plan
}

/**
 * Settings that describe this machine rather than this fleet's conventions.
 *
 * Held back by default on import; see {@link planConfigImport}.
 */
const MACHINE_SPECIFIC = new Set<string>([
  'root',
  'basePort',
  'assetServerPort',
  'assetMounts',
  'sharedPassword'
])

/** Settings to apply, honouring the keep-local-paths choice. */
export function settingsToApply(
  incoming: WorkspaceSettings,
  options: ConfigImportOptions
): Partial<WorkspaceSettings> {
  if (!options.settings) return {}

  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(incoming)) {
    if (options.keepLocalPaths && MACHINE_SPECIFIC.has(key)) continue
    patch[key] = value
  }

  return patch as Partial<WorkspaceSettings>
}

/** Normalises an imported entry into the shape instance creation expects. */
export function entryToLaunchOptions(entry: ConfigInstanceEntry): ConfigInstanceEntry['launch'] {
  return mergeLaunchOptions(entry.launch)
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '(unset)'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
