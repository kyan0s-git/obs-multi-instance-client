import type { FleetApi } from '@shared/api'

export interface PlatformInfo {
  os: NodeJS.Platform
  arch: string
  versions: { electron: string; chrome: string; node: string }
}

declare global {
  interface Window {
    fleet: FleetApi
    platform: PlatformInfo
  }
}

export {}
