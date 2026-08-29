import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { screen } from 'electron'
import type { NativeWindow, Platform, TileRequest, TileResult } from '@shared/types'
import { log, errorMessage } from '../util/logger.js'
import { computeTiling, type Rect } from '@shared/tiling.js'

const run = promisify(execFile)
const platform = process.platform as Platform

/**
 * Arranges the *real* OBS windows on the operator's desktop.
 *
 * The client deliberately does not try to reparent OBS windows into itself:
 * embedding another process's top-level window is fragile on every platform
 * and breaks OBS's own previews and dialogs. Driving the window manager
 * instead keeps every OBS window fully interactive — sources, properties
 * dialogs, docks and all — while still giving a fleet-wide layout.
 */
export class WindowControl {
  /** Windows belonging to tracked OBS processes, keyed back to instances. */
  async listWindows(pidToInstance: Map<number, string>): Promise<NativeWindow[]> {
    try {
      switch (platform) {
        case 'win32':
          return await listWindowsWin32(pidToInstance)
        case 'linux':
          return await listWindowsLinux(pidToInstance)
        case 'darwin':
          return await listWindowsDarwin(pidToInstance)
        default:
          return []
      }
    } catch (err) {
      log.warn('windows', `Could not enumerate windows: ${errorMessage(err)}`)
      return []
    }
  }

  /** Reports whether the platform helper this build needs is actually present. */
  async capabilities(): Promise<{ available: boolean; detail: string }> {
    if (platform === 'win32') {
      return { available: true, detail: 'Uses PowerShell and the Win32 window API.' }
    }
    if (platform === 'darwin') {
      return {
        available: true,
        detail:
          'Uses AppleScript. macOS asks for Accessibility permission the first time a window is moved.'
      }
    }

    const hasWmctrl = await commandExists('wmctrl')
    return hasWmctrl
      ? { available: true, detail: 'Uses wmctrl (X11).' }
      : {
          available: false,
          detail:
            'wmctrl is not installed. Install it (for example `sudo apt install wmctrl`) to arrange windows. Note that wmctrl does not work on Wayland sessions.'
        }
  }

  /** Moves each instance's main window into its computed slot. */
  /**
   * Places windows for every display in the request.
   *
   * Assignments are applied in order and an instance named twice is placed
   * once, by the first assignment that claims it — two displays fighting over
   * one window would just leave it wherever the last write landed.
   */
  async tile(request: TileRequest, pidToInstance: Map<number, string>): Promise<TileResult> {
    const result: TileResult = { moved: [], failed: [], warnings: [] }
    const requested = request.assignments.flatMap((assignment) => assignment.instanceIds)

    const capability = await this.capabilities()
    if (!capability.available) {
      result.warnings.push(capability.detail)
      for (const instanceId of requested) {
        result.failed.push({ instanceId, reason: 'Window control helper unavailable' })
      }
      return result
    }

    const windows = await this.listWindows(pidToInstance)
    const byInstance = new Map<string, NativeWindow>()
    for (const window of windows) {
      if (!window.instanceId) continue
      // OBS opens auxiliary windows (projectors, properties). The main window
      // is the one whose title carries the OBS version banner, so prefer it.
      const existing = byInstance.get(window.instanceId)
      if (!existing || looksLikeMainWindow(window.title)) byInstance.set(window.instanceId, window)
    }

    const claimed = new Set<string>()

    for (const assignment of request.assignments) {
      const placeable: string[] = []

      for (const instanceId of assignment.instanceIds) {
        if (claimed.has(instanceId)) continue
        claimed.add(instanceId)

        if (byInstance.has(instanceId)) placeable.push(instanceId)
        else result.failed.push({ instanceId, reason: 'No visible OBS window found' })
      }

      if (placeable.length === 0) continue

      const area = this.displayArea(assignment.displayId, assignment.fullBounds)
      const rects = computeTiling({
        layout: assignment.layout,
        count: placeable.length,
        area,
        gap: assignment.gap,
        margin: assignment.margin,
        mainIndex: assignment.mainInstanceId
          ? Math.max(0, placeable.indexOf(assignment.mainInstanceId))
          : 0
      })

      for (let index = 0; index < placeable.length; index += 1) {
        const instanceId = placeable[index]
        const window = byInstance.get(instanceId)!

        try {
          await this.moveWindow(window, rects[index])
          result.moved.push({ instanceId, handle: window.handle })
        } catch (err) {
          result.failed.push({ instanceId, reason: errorMessage(err) })
        }
      }
    }

    return result
  }

  /** Brings one instance's window to the front. */
  async focus(instanceId: string, pidToInstance: Map<number, string>): Promise<void> {
    const windows = await this.listWindows(pidToInstance)
    const window = windows.find((candidate) => candidate.instanceId === instanceId)
    if (!window) throw new Error('No visible OBS window found for this instance')

    if (platform === 'win32') {
      await runPowerShell(`${WIN32_HELPER}
[Fleet.Win]::Focus([IntPtr]${window.handle})`)
      return
    }
    if (platform === 'linux') {
      await run('wmctrl', ['-i', '-a', window.handle])
      return
    }
    await runAppleScript(
      `tell application "System Events" to set frontmost of (first process whose unix id is ${window.pid}) to true`
    )
  }

  /** Minimises every listed instance, for clearing the desktop between shows. */
  async minimizeAll(instanceIds: string[], pidToInstance: Map<number, string>): Promise<void> {
    const windows = await this.listWindows(pidToInstance)
    for (const window of windows) {
      if (!window.instanceId || !instanceIds.includes(window.instanceId)) continue
      try {
        if (platform === 'win32') {
          await runPowerShell(`${WIN32_HELPER}
[Fleet.Win]::Minimize([IntPtr]${window.handle})`)
        } else if (platform === 'linux') {
          await run('xdotool', ['windowminimize', window.handle]).catch(() =>
            run('wmctrl', ['-i', '-r', window.handle, '-b', 'add,hidden'])
          )
        } else {
          await runAppleScript(
            `tell application "System Events" to set visible of (first process whose unix id is ${window.pid}) to false`
          )
        }
      } catch (err) {
        log.debug('windows', `Minimise failed: ${errorMessage(err)}`, window.instanceId)
      }
    }
  }

  /**
   * The rectangle to tile into.
   *
   * A display that was unplugged between planning and applying falls back to
   * the primary rather than throwing: the operator asked for windows to be
   * arranged, and putting them somewhere visible beats an error.
   */
  private displayArea(displayId: number | null, fullBounds: boolean): Rect {
    const display =
      (displayId !== null
        ? screen.getAllDisplays().find((candidate) => candidate.id === displayId)
        : undefined) ?? screen.getPrimaryDisplay()
    const { x, y, width, height } = fullBounds ? display.bounds : display.workArea
    return { x, y, width, height }
  }

  private async moveWindow(window: NativeWindow, rect: Rect): Promise<void> {
    if (platform === 'win32') {
      await runPowerShell(`${WIN32_HELPER}
[Fleet.Win]::Place([IntPtr]${window.handle}, ${rect.x}, ${rect.y}, ${rect.width}, ${rect.height})`)
      return
    }

    if (platform === 'linux') {
      // wmctrl cannot move a maximised window, so the state is cleared first.
      await run('wmctrl', ['-i', '-r', window.handle, '-b', 'remove,maximized_vert,maximized_horz'])
      await run('wmctrl', [
        '-i',
        '-r',
        window.handle,
        '-e',
        `0,${rect.x},${rect.y},${rect.width},${rect.height}`
      ])
      return
    }

    await runAppleScript(`
tell application "System Events"
  tell (first process whose unix id is ${window.pid})
    set frontWindow to first window whose subrole is "AXStandardWindow"
    set position of frontWindow to {${rect.x}, ${rect.y}}
    set size of frontWindow to {${rect.width}, ${rect.height}}
  end tell
end tell`)
  }
}

/* ------------------------------------------------------------------ */
/* Platform helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * P/Invoke shim compiled by PowerShell on demand.
 *
 * `SetWindowPos` with SWP_NOZORDER keeps whatever stacking the operator had,
 * and the window is un-maximised first because a maximised window silently
 * ignores move requests.
 */
const WIN32_HELPER = `
if (-not ([System.Management.Automation.PSTypeName]'Fleet.Win').Type) {
Add-Type -Namespace Fleet -Name Win -MemberDefinition @'
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);

  public static void Place(IntPtr hWnd, int x, int y, int w, int h) {
    ShowWindow(hWnd, 9);
    SetWindowPos(hWnd, IntPtr.Zero, x, y, w, h, 0x0004);
  }
  public static void Focus(IntPtr hWnd) {
    if (IsIconic(hWnd)) { ShowWindow(hWnd, 9); }
    SetForegroundWindow(hWnd);
  }
  public static void Minimize(IntPtr hWnd) { ShowWindow(hWnd, 6); }
'@
}
`

async function listWindowsWin32(pidToInstance: Map<number, string>): Promise<NativeWindow[]> {
  const pids = [...pidToInstance.keys()]
  if (pids.length === 0) return []

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$pids = @(${pids.join(',')})
$result = @()
foreach ($p in $pids) {
  try { $proc = Get-Process -Id $p -ErrorAction Stop } catch { continue }
  foreach ($proc2 in @($proc)) {
    if ($proc2.MainWindowHandle -ne 0) {
      $result += [PSCustomObject]@{
        handle = [int64]$proc2.MainWindowHandle
        pid = $proc2.Id
        title = $proc2.MainWindowTitle
      }
    }
  }
}
$result | ConvertTo-Json -Compress -Depth 3
`
  const { stdout } = await runPowerShell(script)
  const parsed = parseJsonList(stdout)

  return parsed.map((entry) => {
    const pid = Number(entry.pid ?? 0)
    return {
      handle: String(entry.handle ?? ''),
      pid,
      title: String(entry.title ?? ''),
      instanceId: pidToInstance.get(pid) ?? null,
      bounds: null,
      minimized: false
    }
  })
}

async function listWindowsLinux(pidToInstance: Map<number, string>): Promise<NativeWindow[]> {
  // `-lpG` gives: id, desktop, pid, x, y, w, h, host, title
  const { stdout } = await run('wmctrl', ['-lpG'], { timeout: 8000 })
  const windows: NativeWindow[] = []

  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 8) continue

    const pid = Number(parts[2])
    const instanceId = pidToInstance.get(pid) ?? null
    if (!instanceId) continue

    windows.push({
      handle: parts[0],
      pid,
      title: parts.slice(8).join(' '),
      instanceId,
      bounds: {
        x: Number(parts[3]),
        y: Number(parts[4]),
        width: Number(parts[5]),
        height: Number(parts[6])
      },
      minimized: false
    })
  }

  return windows
}

async function listWindowsDarwin(pidToInstance: Map<number, string>): Promise<NativeWindow[]> {
  const windows: NativeWindow[] = []

  for (const [pid, instanceId] of pidToInstance) {
    try {
      const title = await runAppleScript(
        `tell application "System Events" to get name of first window of (first process whose unix id is ${pid})`
      )
      windows.push({
        // AppleScript addresses windows by process, so the pid is the handle.
        handle: String(pid),
        pid,
        title: title.trim(),
        instanceId,
        bounds: null,
        minimized: false
      })
    } catch {
      // Process has no window yet, or Accessibility permission is missing.
    }
  }

  return windows
}

async function runPowerShell(script: string): Promise<{ stdout: string }> {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
  )
  return { stdout }
}

async function runAppleScript(script: string): Promise<string> {
  const { stdout } = await run('/usr/bin/osascript', ['-e', script], { timeout: 15_000 })
  return stdout
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await run('which', [command], { timeout: 4000 })
    return true
  } catch {
    return false
  }
}

/** `ConvertTo-Json` emits a bare object for a single result, not an array. */
function parseJsonList(text: string): Array<Record<string, unknown>> {
  const trimmed = text.trim()
  if (trimmed === '') return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>
    return [parsed as Record<string, unknown>]
  } catch {
    return []
  }
}

function looksLikeMainWindow(title: string): boolean {
  return /^OBS\b/i.test(title.trim())
}
