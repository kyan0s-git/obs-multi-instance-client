import fs from 'node:fs/promises'
import path from 'node:path'
import { parseIni, serializeIni, type IniDocument } from '../util/ini.js'
import { pathExists, writeTextAtomic } from '../util/fsx.js'

/**
 * The OBS window arrangement — docks, panels, toolbars — lives in `user.ini`
 * under `[BasicWindow]`, not in a profile or a scene collection. Copying it is
 * how a team gets every instance laid out identically.
 *
 * Keys were taken from OBS's own reads of `App()->GetUserConfig()` in
 * `OBSBasic.cpp` and `OBSBasic_Browser.cpp`.
 */
const SECTION = 'BasicWindow'

/**
 * `DockState` is a base64 `QMainWindow::saveState()` blob and carries the
 * position, size, floating state and visibility of every dock, including ones
 * added by plugins. It is the single most valuable key here.
 */
export const UI_LAYOUT_KEYS = [
  'DockState',
  'DocksLocked',
  'ExtraBrowserDocks',
  'ShowListboxToolbars',
  'ShowStatusBar',
  'ShowSourceIcons',
  'ShowContextToolbars',
  'ShowTransitions',
  'PreviewProgramMode',
  'PreviewEnabled',
  'SceneDuplicationMode',
  'SwapScenesMode',
  'EditPropertiesMode',
  'gridMode',
  'VerticalVolControl',
  'MixerShowInactive',
  'MixerKeepInactiveLast',
  'MixerShowHidden',
  'MixerKeepHiddenLast',
  'MultiviewLayout',
  'MultiviewMouseSwitch',
  'MultiviewDrawNames',
  'MultiviewDrawAreas',
  'AlwaysOnTop',
  'SysTrayEnabled',
  'SysTrayWhenStarted',
  'SysTrayMinimizeToTray'
] as const

/**
 * The main window's saved position and size.
 *
 * Kept separate because copying it puts every instance's window in exactly
 * the same place — fine if the fleet is going to be tiled afterwards, wrong
 * if the operator has arranged them by hand.
 */
export const GEOMETRY_KEY = 'geometry'

export interface UiLayout {
  /** `[BasicWindow]` key/value pairs that describe the arrangement. */
  values: Record<string, string>
  /** Present only when geometry was included. */
  geometry: string | null
}

/** Reads the layout out of an instance's `user.ini`. */
export async function readUiLayout(userIni: string): Promise<UiLayout | null> {
  if (!(await pathExists(userIni))) return null

  const doc = parseIni(await fs.readFile(userIni, 'utf8').catch(() => ''))
  const section = doc.get(SECTION)
  if (!section) return null

  const values: Record<string, string> = {}
  for (const key of UI_LAYOUT_KEYS) {
    const value = section.get(key)
    if (value !== undefined) values[key] = value
  }

  // An instance that has never been opened has no DockState; there is nothing
  // meaningful to copy from it.
  if (Object.keys(values).length === 0) return null

  return { values, geometry: section.get(GEOMETRY_KEY) ?? null }
}

/** Merges a layout into an instance's `user.ini`, leaving everything else alone. */
export async function writeUiLayout(
  userIni: string,
  layout: UiLayout,
  options: { includeGeometry: boolean }
): Promise<void> {
  const doc: IniDocument = parseIni(await fs.readFile(userIni, 'utf8').catch(() => ''))

  let section = doc.get(SECTION)
  if (!section) {
    section = new Map<string, string>()
    doc.set(SECTION, section)
  }

  for (const [key, value] of Object.entries(layout.values)) section.set(key, value)

  if (options.includeGeometry && layout.geometry !== null) {
    section.set(GEOMETRY_KEY, layout.geometry)
  }

  await writeTextAtomic(userIni, serializeIni(doc))
}

/**
 * Human summary of what a layout contains, for the sync table.
 *
 * `DockState` is an opaque Qt blob, so the useful signal is how many custom
 * browser docks came with it and whether a saved arrangement exists at all.
 */
export function describeUiLayout(layout: UiLayout): string {
  const parts: string[] = []
  parts.push(layout.values.DockState ? 'saved dock arrangement' : 'no dock arrangement')

  const docks = parseExtraBrowserDocks(layout.values.ExtraBrowserDocks)
  if (docks.length > 0) {
    parts.push(`${docks.length} custom browser dock${docks.length === 1 ? '' : 's'}`)
  }
  if (layout.geometry) parts.push('window geometry')

  return parts.join(', ')
}

export interface BrowserDock {
  title: string
  url: string
  uuid?: string
}

/**
 * `ExtraBrowserDocks` is a JSON array of `{title, url, uuid}` stored as an ini
 * value. Malformed content is treated as "no docks" rather than failing the
 * whole layout copy.
 */
export function parseExtraBrowserDocks(raw: string | undefined): BrowserDock[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry) => entry as Record<string, unknown>)
      .filter((entry) => typeof entry.title === 'string' && typeof entry.url === 'string')
      .map((entry) => ({
        title: String(entry.title),
        url: String(entry.url),
        uuid: typeof entry.uuid === 'string' ? entry.uuid : undefined
      }))
  } catch {
    return []
  }
}

export function serializeExtraBrowserDocks(docks: BrowserDock[]): string {
  return JSON.stringify(
    docks.map((dock) => ({
      title: dock.title,
      url: dock.url,
      uuid: dock.uuid ?? crypto.randomUUID()
    }))
  )
}

/**
 * Gives each copied browser dock a fresh uuid.
 *
 * OBS keys a dock's persisted state by uuid, so two instances sharing one
 * would fight over the same saved dock geometry.
 */
export function regenerateDockUuids(layout: UiLayout): UiLayout {
  const docks = parseExtraBrowserDocks(layout.values.ExtraBrowserDocks)
  if (docks.length === 0) return layout

  return {
    ...layout,
    values: {
      ...layout.values,
      ExtraBrowserDocks: serializeExtraBrowserDocks(
        docks.map((dock) => ({ ...dock, uuid: crypto.randomUUID() }))
      )
    }
  }
}

/** Where an exported layout lives inside a bundle. */
export function uiLayoutBundlePath(instanceName: string): string {
  return path.posix.join('ui-layouts', `${instanceName}.json`)
}
