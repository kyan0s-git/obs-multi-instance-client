import type {
  AudioInputInfo,
  BrowserSourceSpec,
  InstanceSnapshot,
  ObsInstance,
  SceneItemInfo
} from '@shared/types'
import type { ObsConnection } from './obs-connection.js'
import { errorMessage } from '../util/logger.js'

/** Input kinds OBS uses for the browser source across platforms. */
export const BROWSER_SOURCE_KINDS = ['browser_source', 'linuxbrowser-source'] as const

/**
 * High-level operations against a single connected instance.
 *
 * Everything here is a thin, typed wrapper over obs-websocket requests, kept
 * out of the IPC layer so the same helpers serve bulk actions, telemetry and
 * the multiview control surface.
 */

/** One round trip that captures everything the control surface renders. */
export async function readSnapshot(connection: ObsConnection): Promise<InstanceSnapshot> {
  const [sceneList, studioMode, profiles, collections, transitions] = await Promise.all([
    connection.call('GetSceneList'),
    connection.call('GetStudioModeEnabled').catch(() => ({ studioModeEnabled: false })),
    connection.call('GetProfileList'),
    connection.call('GetSceneCollectionList'),
    connection.call('GetSceneTransitionList').catch(() => ({
      currentSceneTransitionName: null,
      transitions: [] as Array<{ transitionName: string }>
    }))
  ])

  const programScene = sceneList.currentProgramSceneName ?? null
  const sceneItems = programScene ? await readSceneItems(connection, programScene) : []
  const audioInputs = await readAudioInputs(connection)

  return {
    instanceId: connection.instanceId,
    // OBS returns scenes newest-first; reverse so the order matches the UI.
    scenes: [...sceneList.scenes]
      .map((scene) => String((scene as { sceneName?: unknown }).sceneName ?? ''))
      .filter((name) => name !== '')
      .reverse(),
    currentProgramScene: programScene,
    currentPreviewScene: sceneList.currentPreviewSceneName ?? null,
    studioMode: Boolean(studioMode.studioModeEnabled),
    sceneItems,
    audioInputs,
    profiles: profiles.profiles ?? [],
    sceneCollections: collections.sceneCollections ?? [],
    currentProfile: profiles.currentProfileName ?? null,
    currentSceneCollection: collections.currentSceneCollectionName ?? null,
    transitions: (transitions.transitions ?? []).map((t) =>
      String((t as { transitionName?: unknown }).transitionName ?? '')
    ),
    currentTransition: transitions.currentSceneTransitionName ?? null
  }
}

export async function readSceneItems(
  connection: ObsConnection,
  sceneName: string
): Promise<SceneItemInfo[]> {
  const response = await connection.call('GetSceneItemList', { sceneName })
  return (response.sceneItems ?? []).map((raw) => {
    const item = raw as Record<string, unknown>
    return {
      id: Number(item.sceneItemId ?? 0),
      sourceName: String(item.sourceName ?? ''),
      enabled: Boolean(item.sceneItemEnabled),
      locked: Boolean(item.sceneItemLocked),
      isGroup: Boolean(item.isGroup),
      inputKind: typeof item.inputKind === 'string' ? item.inputKind : null
    }
  })
}

/**
 * Audio inputs with their mute/volume state. OBS has no batched "get all
 * volumes" request, so this is one round trip per input — acceptable because
 * the snapshot is only refreshed on demand and on relevant events.
 */
export async function readAudioInputs(connection: ObsConnection): Promise<AudioInputInfo[]> {
  const { inputs } = await connection.call('GetInputList')
  const audio: AudioInputInfo[] = []

  for (const raw of inputs ?? []) {
    const input = raw as Record<string, unknown>
    const name = String(input.inputName ?? '')
    if (name === '') continue

    try {
      const [mute, volume] = await Promise.all([
        connection.call('GetInputMute', { inputName: name }),
        connection.call('GetInputVolume', { inputName: name })
      ])
      audio.push({
        name,
        muted: Boolean(mute.inputMuted),
        volumeMul: Number(volume.inputVolumeMul ?? 1),
        volumeDb: Number(volume.inputVolumeDb ?? 0),
        inputKind: typeof input.inputKind === 'string' ? input.inputKind : null
      })
    } catch {
      // Inputs without an audio track reject these requests; skipping them is
      // exactly right, they do not belong in the mixer.
    }
  }

  return audio
}

/* ------------------------------------------------------------------ */
/* Scene / transition control                                          */
/* ------------------------------------------------------------------ */

export async function setProgramScene(connection: ObsConnection, sceneName: string): Promise<void> {
  await connection.call('SetCurrentProgramScene', { sceneName })
}

export async function setPreviewScene(connection: ObsConnection, sceneName: string): Promise<void> {
  await connection.call('SetCurrentPreviewScene', { sceneName })
}

export async function setStudioMode(connection: ObsConnection, enabled: boolean): Promise<void> {
  await connection.call('SetStudioModeEnabled', { studioModeEnabled: enabled })
}

export async function triggerTransition(connection: ObsConnection): Promise<void> {
  await connection.call('TriggerStudioModeTransition')
}

export async function setSceneItemEnabled(
  connection: ObsConnection,
  sceneName: string,
  sceneItemId: number,
  enabled: boolean
): Promise<void> {
  await connection.call('SetSceneItemEnabled', {
    sceneName,
    sceneItemId,
    sceneItemEnabled: enabled
  })
}

export async function setInputMute(
  connection: ObsConnection,
  inputName: string,
  muted: boolean
): Promise<void> {
  await connection.call('SetInputMute', { inputName, inputMuted: muted })
}

export async function setInputVolumeDb(
  connection: ObsConnection,
  inputName: string,
  volumeDb: number
): Promise<void> {
  await connection.call('SetInputVolume', { inputName, inputVolumeDb: volumeDb })
}

/* ------------------------------------------------------------------ */
/* Output control                                                      */
/* ------------------------------------------------------------------ */

export async function startRecording(connection: ObsConnection): Promise<void> {
  await connection.call('StartRecord')
}

export async function stopRecording(connection: ObsConnection): Promise<void> {
  await connection.call('StopRecord')
}

export async function pauseRecording(connection: ObsConnection): Promise<void> {
  await connection.call('PauseRecord')
}

export async function resumeRecording(connection: ObsConnection): Promise<void> {
  await connection.call('ResumeRecord')
}

export async function splitRecordFile(connection: ObsConnection): Promise<void> {
  await connection.call('SplitRecordFile')
}

export async function startStreaming(connection: ObsConnection): Promise<void> {
  await connection.call('StartStream')
}

export async function stopStreaming(connection: ObsConnection): Promise<void> {
  await connection.call('StopStream')
}

export async function startReplayBuffer(connection: ObsConnection): Promise<void> {
  await connection.call('StartReplayBuffer')
}

export async function stopReplayBuffer(connection: ObsConnection): Promise<void> {
  await connection.call('StopReplayBuffer')
}

export async function saveReplayBuffer(connection: ObsConnection): Promise<void> {
  await connection.call('SaveReplayBuffer')
}

export async function startVirtualCam(connection: ObsConnection): Promise<void> {
  await connection.call('StartVirtualCam')
}

export async function stopVirtualCam(connection: ObsConnection): Promise<void> {
  await connection.call('StopVirtualCam')
}

export async function setProfile(connection: ObsConnection, profileName: string): Promise<void> {
  await connection.call('SetCurrentProfile', { profileName })
}

export async function setSceneCollection(
  connection: ObsConnection,
  sceneCollectionName: string
): Promise<void> {
  // Switching collections tears down and rebuilds every source, so OBS can
  // take several seconds to answer.
  await connection.call('SetCurrentSceneCollection', { sceneCollectionName }, 30_000)
}

/* ------------------------------------------------------------------ */
/* Preview capture                                                     */
/* ------------------------------------------------------------------ */

/**
 * Grabs a JPEG of the program (or preview) output as a data URI.
 *
 * OBS screenshots a *source*, and a scene is a source, so the current scene
 * name is the handle for "what is on air".
 */
export async function captureScene(
  connection: ObsConnection,
  sceneName: string,
  maxWidth: number,
  quality = 60
): Promise<string> {
  const response = await connection.call(
    'GetSourceScreenshot',
    {
      sourceName: sceneName,
      imageFormat: 'jpg',
      imageWidth: Math.max(8, Math.round(maxWidth)),
      imageHeight: Math.max(8, Math.round((maxWidth * 9) / 16)),
      imageCompressionQuality: quality
    },
    8000
  )
  return response.imageData
}

/* ------------------------------------------------------------------ */
/* Browser sources                                                     */
/* ------------------------------------------------------------------ */

/** Resolves whichever browser source kind this OBS build actually offers. */
export async function resolveBrowserKind(connection: ObsConnection): Promise<string> {
  const { inputKinds } = await connection.call('GetInputKindList')
  for (const candidate of BROWSER_SOURCE_KINDS) {
    if (inputKinds?.includes(candidate)) return candidate
  }
  throw new Error('This OBS build has no browser source plugin available')
}

/** JSON-safe settings blob, matching the shape obs-websocket accepts. */
export type InputSettings = Record<string, string | number | boolean>

/** Settings blob OBS expects for a browser source. */
export function browserSettings(spec: BrowserSourceSpec, url: string): InputSettings {
  return {
    url,
    width: spec.width,
    height: spec.height,
    fps_custom: spec.fpsCustom,
    fps: spec.fps,
    css: spec.css,
    shutdown: spec.shutdownWhenNotVisible,
    restart_when_active: spec.restartWhenActivated,
    reroute_audio: spec.controlAudio,
    // Local-file mode has stricter CEF restrictions and no query string, so
    // the client always serves assets over http instead.
    is_local_file: false
  }
}

/**
 * Adds (or updates) a browser source in one instance.
 *
 * Re-running with the same source name updates settings in place rather than
 * creating a duplicate, which is what makes "push to all instances" safe to
 * press twice.
 */
export async function deployBrowserSource(
  connection: ObsConnection,
  instance: ObsInstance,
  spec: BrowserSourceSpec,
  sceneName: string | null
): Promise<string> {
  const url = spec.perInstanceParams ? decorateUrl(spec.url, instance) : spec.url
  const settings = browserSettings(spec, url)

  const existing = await connection
    .call('GetInputSettings', { inputName: spec.name })
    .then(() => true)
    .catch(() => false)

  if (existing) {
    await connection.call('SetInputSettings', {
      inputName: spec.name,
      inputSettings: settings,
      overlay: true
    })
    return `Updated existing source "${spec.name}"`
  }

  const targetScene = sceneName ?? (await connection.call('GetCurrentProgramScene')).sceneName
  const kind = await resolveBrowserKind(connection)

  await connection.call('CreateInput', {
    sceneName: targetScene,
    inputName: spec.name,
    inputKind: kind,
    inputSettings: settings,
    sceneItemEnabled: true
  })

  return `Created "${spec.name}" in scene "${targetScene}"`
}

/**
 * Appends instance identity to a URL so one HTML overlay can render
 * differently per instance without maintaining N copies of the file.
 */
export function decorateUrl(url: string, instance: ObsInstance): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.set('instance', instance.name)
    parsed.searchParams.set('instanceId', instance.id)
    if (instance.role !== '') parsed.searchParams.set('role', instance.role)
    parsed.searchParams.set('color', instance.color)
    return parsed.toString()
  } catch {
    // Not a parseable URL (a bare path, say) — leave it untouched rather than
    // producing something OBS cannot load.
    return url
  }
}

/** Presses the browser source's "Refresh cache of current page" button. */
export async function refreshBrowserSources(connection: ObsConnection): Promise<number> {
  const { inputs } = await connection.call('GetInputList')
  let refreshed = 0

  for (const raw of inputs ?? []) {
    const input = raw as Record<string, unknown>
    const kind = String(input.inputKind ?? '')
    if (!BROWSER_SOURCE_KINDS.includes(kind as (typeof BROWSER_SOURCE_KINDS)[number])) continue

    try {
      await connection.call('PressInputPropertiesButton', {
        inputName: String(input.inputName ?? ''),
        propertyName: 'refreshnocache'
      })
      refreshed += 1
    } catch {
      // Older browser plugin builds name the button differently; a failure
      // here is cosmetic, not something to abort the whole sweep for.
    }
  }

  return refreshed
}

/** Lists browser sources across an instance, for the assets pane. */
export async function listBrowserSources(
  connection: ObsConnection
): Promise<Array<{ name: string; url: string }>> {
  const { inputs } = await connection.call('GetInputList')
  const found: Array<{ name: string; url: string }> = []

  for (const raw of inputs ?? []) {
    const input = raw as Record<string, unknown>
    const kind = String(input.inputKind ?? '')
    if (!BROWSER_SOURCE_KINDS.includes(kind as (typeof BROWSER_SOURCE_KINDS)[number])) continue

    const name = String(input.inputName ?? '')
    try {
      const settings = await connection.call('GetInputSettings', { inputName: name })
      found.push({ name, url: String((settings.inputSettings as Record<string, unknown>)?.url ?? '') })
    } catch (err) {
      found.push({ name, url: `<unreadable: ${errorMessage(err)}>` })
    }
  }

  return found
}
