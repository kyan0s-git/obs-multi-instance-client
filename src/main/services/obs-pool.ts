import { EventEmitter } from 'node:events'
import type { ObsInstance } from '@shared/types'
import { ObsConnection, type ConnectionStatus } from './obs-connection.js'
import { log } from '../util/logger.js'

export interface ObsEventEnvelope {
  instanceId: string
  eventType: string
  data: unknown
}

/**
 * Keeps one {@link ObsConnection} per instance and routes their traffic onto
 * two channels: `status` for connectivity changes and `obsEvent` for OBS's
 * own events.
 */
export class ObsPool extends EventEmitter {
  private connections = new Map<string, ObsConnection>()

  get(instanceId: string): ObsConnection | undefined {
    return this.connections.get(instanceId)
  }

  /** Throws a caller-friendly error rather than returning undefined. */
  require(instanceId: string): ObsConnection {
    const connection = this.connections.get(instanceId)
    if (!connection) throw new Error(`No OBS connection for instance ${instanceId}`)
    if (!connection.isConnected) throw new Error('OBS is not connected')
    return connection
  }

  isConnected(instanceId: string): boolean {
    return this.connections.get(instanceId)?.isConnected ?? false
  }

  connectedIds(): string[] {
    return [...this.connections.entries()]
      .filter(([, connection]) => connection.isConnected)
      .map(([id]) => id)
  }

  statuses(): ConnectionStatus[] {
    return [...this.connections.values()].map((connection) => connection.status)
  }

  /** Opens (or reconfigures) the connection for an instance. */
  async open(instance: ObsInstance): Promise<void> {
    if (!instance.websocket.enabled) {
      await this.close(instance.id)
      return
    }

    const existing = this.connections.get(instance.id)
    if (existing) {
      existing.reconfigure(instance)
      return
    }

    const connection = new ObsConnection(instance)
    connection.on('status', (status: ConnectionStatus) => this.emit('status', status))
    connection.on('connected', (status: ConnectionStatus) => this.emit('connected', status))
    connection.on('obsEvent', (envelope: ObsEventEnvelope) => this.emit('obsEvent', envelope))

    this.connections.set(instance.id, connection)
    await connection.start()
  }

  async close(instanceId: string): Promise<void> {
    const connection = this.connections.get(instanceId)
    if (!connection) return
    this.connections.delete(instanceId)
    connection.removeAllListeners()
    await connection.stop()
    log.debug('ws', 'Connection closed', instanceId)
    this.emit('status', {
      instanceId,
      connected: false,
      error: null,
      obsVersion: null,
      negotiatedRpcVersion: null
    } satisfies ConnectionStatus)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.close(id)))
  }

  /**
   * Reconciles the pool against the current roster: opens connections for
   * instances that should have one, closes the rest.
   */
  async sync(instances: ObsInstance[], shouldConnect: (instance: ObsInstance) => boolean): Promise<void> {
    const wanted = new Set<string>()

    for (const instance of instances) {
      if (!shouldConnect(instance)) continue
      wanted.add(instance.id)
      await this.open(instance)
    }

    for (const id of [...this.connections.keys()]) {
      if (!wanted.has(id)) await this.close(id)
    }
  }
}
