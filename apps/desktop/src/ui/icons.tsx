// The window's few icons, drawn on one 16-unit grid with one stroke, so they read as a set.
// They are decoration for a labelled control: hidden from assistive technology.
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

export const GearIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="2.1" />
    <path d="M8 1.6v1.6M8 12.8v1.6M14.4 8h-1.6M3.2 8H1.6M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1M12.5 12.5l-1.1-1.1M4.6 4.6 3.5 3.5" />
    <circle cx="8" cy="8" r="4.6" />
  </Icon>
);

export const PaperclipIcon = () => (
  <Icon>
    <path d="M13.2 7.4 8 12.6a3.2 3.2 0 0 1-4.5-4.5l5.6-5.6a2.1 2.1 0 0 1 3 3L6.5 11.1a1.05 1.05 0 0 1-1.5-1.5l4.9-4.9" />
  </Icon>
);

export const SendIcon = () => (
  <Icon>
    <path d="M8 13V3.4M3.8 7.4 8 3.2l4.2 4.2" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon>
    <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
  </Icon>
);

export const RetryIcon = () => (
  <Icon>
    <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.6v2.6h-2.6" />
  </Icon>
);

export const ExternalIcon = () => (
  <Icon>
    <path d="M9.5 2.8h3.7v3.7M13.2 2.8 7.6 8.4M11.6 9.4v3a.9.9 0 0 1-.9.9H3.6a.9.9 0 0 1-.9-.9V5.3a.9.9 0 0 1 .9-.9h3" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon>
    <path d="m3.4 8.4 3 3 6.2-6.6" />
  </Icon>
);

export const BackIcon = () => (
  <Icon>
    <path d="M10 3.2 5.2 8l4.8 4.8" />
  </Icon>
);
