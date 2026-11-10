// The window's icons: one 16-unit grid, one 1.5 stroke, round joins. All decorative; the control
// that holds one carries the name.
import type { ReactNode } from 'react';

const Icon = ({ children }: { children: ReactNode }) => (
  <svg
    className="icon"
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
);

export const ArrowUpIcon = () => (
  <Icon>
    <path d="M8 13V3.5M3.75 7.5 8 3.25l4.25 4.25" />
  </Icon>
);

export const PaperclipIcon = () => (
  <Icon>
    <path d="M13.25 7.5 8.1 12.65a3.1 3.1 0 0 1-4.4-4.4l5.5-5.5a2.07 2.07 0 0 1 2.93 2.93L6.7 11.1a1.04 1.04 0 0 1-1.47-1.47L10 4.9" />
  </Icon>
);

export const SlidersIcon = () => (
  <Icon>
    <path d="M2.5 4.75h5M11.5 4.75h2M2.5 11.25h2M8.5 11.25h5" />
    <circle cx="9.5" cy="4.75" r="1.75" />
    <circle cx="6.5" cy="11.25" r="1.75" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
);

export const ChatIcon = () => (
  <Icon>
    <path d="M2.75 4.5A1.75 1.75 0 0 1 4.5 2.75h7a1.75 1.75 0 0 1 1.75 1.75v5a1.75 1.75 0 0 1-1.75 1.75H7.2L4.25 13.5v-2.3A1.75 1.75 0 0 1 2.75 9.5z" />
  </Icon>
);

export const AlertIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 5v3.5M8 10.9v.1" />
  </Icon>
);

export const PointerIcon = () => (
  <Icon>
    <path d="M3.5 2.75l3.6 10 1.5-4.15 4.15-1.5z" />
  </Icon>
);

export const PlugIcon = () => (
  <Icon>
    <path d="M6 2.25v3M10 2.25v3M4.25 5.25h7.5v2.5a3.75 3.75 0 0 1-7.5 0zM8 11.5v2.25" />
  </Icon>
);

export const ScreenIcon = () => (
  <Icon>
    <rect x="2" y="3" width="12" height="8" rx="1.25" />
    <path d="M6 13.75h4M8 11v2.75" />
  </Icon>
);

export const FileIcon = () => (
  <Icon>
    <path d="M9 2.25H5A1.25 1.25 0 0 0 3.75 3.5v9A1.25 1.25 0 0 0 5 13.75h6a1.25 1.25 0 0 0 1.25-1.25v-7zM9 2.25V5.5h3.25" />
  </Icon>
);

/**
 * The app icon's ring and dot, as a status light and as the empty chat's mark: the ring is the
 * daemon, the dot is lit while it runs.
 */
export const Mark = ({ size = 16 }: { size?: number }) => (
  <svg
    className="mark"
    viewBox="0 0 16 16"
    width={size}
    height={size}
    aria-hidden="true"
    focusable="false"
  >
    <circle className="mark-ring" cx="8" cy="8" r="6" fill="none" strokeWidth="2" />
    <circle className="mark-dot" cx="8" cy="8" r="2.5" />
  </svg>
);
