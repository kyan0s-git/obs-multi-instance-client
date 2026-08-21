import { contextBridge, ipcRenderer } from 'electron'
import { API_METHODS, IPC_EVENT_CHANNEL, IPC_PREFIX, type FleetApi } from '@shared/api'
import type { IpcEventName, IpcEvents } from '@shared/types'

/**
 * The only bridge between the renderer and Node.
 *
 * Every method is a plain `invoke` forwarder, and the event channel is
 * one-way (main -> renderer). The renderer therefore has no way to reach the
 * filesystem, spawn processes or open sockets except through the vetted
 * handlers in the main process.
 */
const api = {} as Record<string, unknown>

for (const method of API_METHODS) {
  api[method] = (...args: unknown[]) => ipcRenderer.invoke(`${IPC_PREFIX}:${method}`, ...args)
}

/** Subscribes to a main-process event; returns an unsubscribe function. */
api.on = <E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): (() => void) => {
  const wrapped = (_ipcEvent: unknown, message: { event: IpcEventName; payload: unknown }): void => {
    if (message?.event === event) listener(message.payload as IpcEvents[E])
  }
  ipcRenderer.on(IPC_EVENT_CHANNEL, wrapped)
  return () => ipcRenderer.removeListener(IPC_EVENT_CHANNEL, wrapped)
}

contextBridge.exposeInMainWorld('fleet', api as unknown as FleetApi)

contextBridge.exposeInMainWorld('platform', {
  os: process.platform,
  arch: process.arch,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }
})
