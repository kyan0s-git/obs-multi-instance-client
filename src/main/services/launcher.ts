import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { promisify } from 'node:util'
import type { ObsInstall, ObsInstance, InstanceRunState, Platform } from '@shared/types'
import { sleep } from '../util/async.js'
import { ensureDir } from '../util/fsx.js'
import { log, errorMessage } from '../util/logger.js'
import { layoutFor } from './obs-install.js'
import { buildLaunchSpec, formatCommandRedacted, type LaunchSpec } from './launch-args.js'
import { instanceExecutable, instancePaths } from './paths.js'
import { verifyInstance } from './provision.js'

const run = promisify(execFile)
const platform = process.platform as Platform

interface ManagedProcess {
  instanceId: string
  child: ChildProcess
  pid: number
  startedAt: number
  /** Set while an intentional quit/kill is in flight, so exit is not a crash. */
  stopping: boolean
  spec: LaunchSpec
}

export interface LauncherExit {
  instanceId: string
  code: number | null
  signal: NodeJS.Signals | null
  /** True when the process ended without us asking it to. */
  unexpected: boolean
  at: number
}

/**
 * Owns the lifetime of every OBS child process.
 *
 * Deliberately does *not* know about websockets or telemetry — it reports
 * process facts (`starting`, `running`, `stopping`, exit) and lets the
 * supervisor above it decide what those mean.
 */
export class Launcher extends EventEmitter {
  private processes = new Map<string, ManagedProcess>()

  isRunning(instanceId: string): boolean {
    return this.processes.has(instanceId)
  }

  getPid(instanceId: string): number | null {
    return this.processes.get(instanceId)?.pid ?? null
  }

  getStartedAt(instanceId: string): number | null {
    return this.processes.get(instanceId)?.startedAt ?? null
  }

  runningIds(): string[] {
    return [...this.processes.keys()]
  }

  /** Every tracked OBS pid, for whole-fleet resource sampling. */
  pids(): Array<{ instanceId: string; pid: number }> {
    return [...this.processes.values()].map((p) => ({ instanceId: p.instanceId, pid: p.pid }))
  }

  /**
   * Starts one instance. Resolves once the process is spawned; readiness
   * (websocket connected) is the supervisor's concern.
   */
  async launch(instance: ObsInstance, install: ObsInstall): Promise<number> {
    if (this.processes.has(instance.id)) {
      throw new Error(`"${instance.name}" is already running`)
    }

    const problems = await verifyInstance(instance, install)
    if (problems.length > 0) {
      throw new Error(`"${instance.name}" is not ready to launch: ${problems.join('; ')}`)
    }

    const executable = instanceExecutable(instance, install, layoutFor().executableRel)
    const spec = buildLaunchSpec(instance, install, executable)

    // macOS home-redirect needs the fake home to exist before Foundation
    // resolves Application Support under it.
    const paths = instancePaths(instance, install)
    if (paths.fakeHome) await ensureDir(paths.configParent)

    this.emitState(instance.id, 'starting')
    log.info('launcher', `Launching: ${formatCommandRedacted(spec)}`, instance.id)

    let child: ChildProcess
    try {
      child = spawn(spec.executable, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        // Keep the child attached so we observe its exit, but give it its own
        // process group on POSIX so a signal to us does not take the fleet down.
        detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false
      })
    } catch (err) {
      this.emitState(instance.id, 'stopped')
      throw new Error(`Failed to spawn OBS: ${errorMessage(err)}`)
    }

    if (!child.pid) {
      this.emitState(instance.id, 'stopped')
      throw new Error('OBS process started without a pid')
    }

    const managed: ManagedProcess = {
      instanceId: instance.id,
      child,
      pid: child.pid,
      startedAt: Date.now(),
      stopping: false,
      spec
    }
    this.processes.set(instance.id, managed)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.forwardOutput(instance, chunk, 'debug'))
    child.stderr?.on('data', (chunk: string) => this.forwardOutput(instance, chunk, 'warn'))

    child.once('error', (err) => {
      log.error('launcher', `Process error: ${errorMessage(err)}`, instance.id)
      this.emit('error', { instanceId: instance.id, error: errorMessage(err) })
    })

    child.once('exit', (code, signal) => {
      const unexpected = !managed.stopping
      this.processes.delete(instance.id)
      const exit: LauncherExit = { instanceId: instance.id, code, signal, unexpected, at: Date.now() }

      if (unexpected) {
        log.error(
          'launcher',
          `"${instance.name}" exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'})`,
          instance.id
        )
      } else {
        log.info('launcher', `"${instance.name}" stopped`, instance.id)
      }

      this.emitState(instance.id, unexpected ? 'crashed' : 'stopped')
      this.emit('exit', exit)
    })

    // OBS on Windows relaunches itself in some configurations (safe-mode
    // prompt, updater handoff). Give the process a beat to settle so a
    // launch that dies instantly surfaces as a failure rather than a success.
    await sleep(400)
    if (!this.processes.has(instance.id)) {
      throw new Error(`"${instance.name}" exited immediately after launch; check the log pane`)
    }

    this.emitState(instance.id, 'running')
    return managed.pid
  }

  /**
   * Asks OBS to close down cleanly, then escalates.
   *
   * Clean shutdown matters beyond politeness: a killed OBS leaves its log
   * unterminated, and the next launch of that instance greets the operator
   * with the Safe Mode prompt.
   */
  async quit(instanceId: string, options: { force?: boolean; timeoutMs?: number } = {}): Promise<void> {
    const managed = this.processes.get(instanceId)
    if (!managed) return

    const { force = false, timeoutMs = 15_000 } = options
    managed.stopping = true
    this.emitState(instanceId, 'stopping')

    if (force) {
      await this.hardKill(managed)
      return
    }

    await this.gracefulStop(managed)

    const deadline = Date.now() + timeoutMs
    while (this.processes.has(instanceId) && Date.now() < deadline) {
      await sleep(250)
    }

    if (this.processes.has(instanceId)) {
      log.warn(
        'launcher',
        `Instance did not close within ${Math.round(timeoutMs / 1000)}s; terminating`,
        instanceId
      )
      await this.hardKill(managed)
    }
  }

  /** Stops every running instance, used on app quit. */
  async quitAll(options: { force?: boolean; timeoutMs?: number } = {}): Promise<void> {
    await Promise.all(this.runningIds().map((id) => this.quit(id, options)))
  }

  private async gracefulStop(managed: ManagedProcess): Promise<void> {
    if (platform === 'win32') {
      // taskkill without /F posts WM_CLOSE, which OBS handles as a normal
      // shutdown. /T catches the browser-source helper children too.
      try {
        await run('taskkill.exe', ['/PID', String(managed.pid), '/T'], {
          timeout: 8000,
          windowsHide: true
        })
      } catch (err) {
        log.debug('launcher', `taskkill request failed: ${errorMessage(err)}`, managed.instanceId)
      }
      return
    }

    try {
      managed.child.kill('SIGTERM')
    } catch (err) {
      log.debug('launcher', `SIGTERM failed: ${errorMessage(err)}`, managed.instanceId)
    }
  }

  private async hardKill(managed: ManagedProcess): Promise<void> {
    if (platform === 'win32') {
      try {
        await run('taskkill.exe', ['/PID', String(managed.pid), '/T', '/F'], {
          timeout: 8000,
          windowsHide: true
        })
      } catch (err) {
        log.warn('launcher', `Force kill failed: ${errorMessage(err)}`, managed.instanceId)
      }
      return
    }

    try {
      // Negative pid targets the process group we created with `detached`.
      process.kill(-managed.pid, 'SIGKILL')
    } catch {
      try {
        managed.child.kill('SIGKILL')
      } catch (err) {
        log.warn('launcher', `Force kill failed: ${errorMessage(err)}`, managed.instanceId)
      }
    }
  }

  /**
   * OBS is chatty on stderr during normal startup; only lines that look like
   * real problems are promoted, the rest go to the debug channel.
   */
  private forwardOutput(instance: ObsInstance, chunk: string, level: 'debug' | 'warn'): void {
    for (const line of chunk.split(/\r?\n/)) {
      const text = line.trim()
      if (text === '') continue
      const looksBad = /error|failed|fatal|cannot|unable/i.test(text)
      log.write(level === 'warn' && looksBad ? 'warn' : 'debug', `obs:${instance.name}`, text, instance.id)
    }
  }

  private emitState(instanceId: string, state: InstanceRunState): void {
    this.emit('state', { instanceId, state })
  }

  /** The command that was used to start a running instance, for the UI. */
  getSpec(instanceId: string): LaunchSpec | null {
    return this.processes.get(instanceId)?.spec ?? null
  }
}
