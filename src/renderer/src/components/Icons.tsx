import type { SVGProps } from 'react'

/**
 * Line icons drawn inline.
 *
 * Deliberately not an icon font or emoji: emoji render inconsistently across
 * the platforms broadcast machines actually run, and a control surface should
 * not change shape between Windows and macOS.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 15, children, ...rest }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconDashboard = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1" />
    <rect x="14" y="3" width="7" height="5" rx="1" />
    <rect x="14" y="12" width="7" height="9" rx="1" />
    <rect x="3" y="16" width="7" height="5" rx="1" />
  </Icon>
)

export const IconInstances = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="5" rx="1" />
    <rect x="3" y="15" width="18" height="5" rx="1" />
    <path d="M7 6.5h.01M7 17.5h.01" />
  </Icon>
)

export const IconGrid = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="3" y="3" width="8" height="8" rx="1" />
    <rect x="13" y="3" width="8" height="8" rx="1" />
    <rect x="3" y="13" width="8" height="8" rx="1" />
    <rect x="13" y="13" width="8" height="8" rx="1" />
  </Icon>
)

export const IconWindows = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="2" y="4" width="13" height="10" rx="1.5" />
    <rect x="9" y="10" width="13" height="10" rx="1.5" />
  </Icon>
)

export const IconSync = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M20 11a8 8 0 0 0-14.1-4.6L4 8" />
    <path d="M4 13a8 8 0 0 0 14.1 4.6L20 16" />
    <path d="M4 4v4h4M20 20v-4h-4" />
  </Icon>
)

export const IconLayers = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="m12 3 9 5-9 5-9-5 9-5Z" />
    <path d="m3 13 9 5 9-5" />
  </Icon>
)

export const IconChart = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M3 20h18" />
    <path d="M6 20V10M11 20V4M16 20v-7M21 20v-4" />
  </Icon>
)

export const IconTerminal = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="2.5" y="4" width="19" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </Icon>
)

export const IconSettings = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a1.7 1.7 0 0 0-1.6-1H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 3 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 3a1.7 1.7 0 0 0 1-1.6V1a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 3a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 9v0a1.7 1.7 0 0 0 1.6 1h.4a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </Icon>
)

export const IconPlay = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M6 4.5 19 12 6 19.5V4.5Z" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconStop = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconRecord = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconPause = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" />
    <rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconBroadcast = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="2.5" />
    <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4" />
    <path d="M4.9 4.9a10 10 0 0 0 0 14.2M19.1 19.1a10 10 0 0 0 0-14.2" />
  </Icon>
)

export const IconPlus = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)

export const IconTrash = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    <path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7M10 11v6M14 11v6" />
  </Icon>
)

export const IconCopy = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </Icon>
)

export const IconFolder = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
  </Icon>
)

export const IconRefresh = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9" />
    <path d="M20 4v5h-5" />
  </Icon>
)

export const IconWrench = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M15.5 3.5a5.5 5.5 0 0 0-6.9 7.1L3 16.2 6.8 20l5.6-5.6a5.5 5.5 0 0 0 7.1-6.9l-3.1 3.1-3-.6-.6-3 2.7-3.5Z" />
  </Icon>
)

export const IconEye = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
    <circle cx="12" cy="12" r="2.8" />
  </Icon>
)

export const IconEyeOff = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M3 3l18 18" />
    <path d="M10.6 6.1A9.9 9.9 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.3 4.1M6.4 7.9A16.6 16.6 0 0 0 2 12s3.6 6.5 10 6.5a10 10 0 0 0 3.2-.5" />
    <path d="M9.6 9.9a2.8 2.8 0 0 0 3.9 3.9" />
  </Icon>
)

export const IconVolume = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
  </Icon>
)

export const IconVolumeOff = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" />
    <path d="m16 9.5 5 5M21 9.5l-5 5" />
  </Icon>
)

export const IconChevron = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
)

export const IconClose = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
)

export const IconExternal = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M14 4h6v6M20 4l-8.5 8.5" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Icon>
)

export const IconWarning = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M10.3 3.9 2.5 17.4A2 2 0 0 0 4.2 20.5h15.6a2 2 0 0 0 1.7-3.1L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4.5M12 17h.01" />
  </Icon>
)

export const IconCheck = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="m4 12.5 5 5L20 6.5" />
  </Icon>
)

/**
 * App mark: one program pane and the fleet stacked beside it.
 *
 * The same geometry as `scripts/logo.mjs`, scaled from its 512 grid to 24 so
 * the mark in the title bar and the icon on the taskbar are the same shape.
 * Fills come from theme tokens rather than the icon's literal colours, so it
 * stays legible if the surface it sits on changes.
 */
export const BrandMark = (p: IconProps): JSX.Element => {
  const { size = 22, ...rest } = p
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...rest}>
      <rect x="3" y="4.5" width="10.7" height="15" rx="1.4" fill="var(--accent)" />
      <rect x="15" y="4.5" width="6" height="6.85" rx="1.15" fill="var(--line-strong)" />
      <rect x="15" y="12.65" width="6" height="6.85" rx="1.15" fill="var(--line)" />
    </svg>
  )
}
