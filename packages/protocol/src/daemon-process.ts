// What the daemon tells whoever started it (a shell, Docker or the desktop app's supervisor)
// when it stops by itself: the exit code says why, so the supervisor need not read the log.

export const exitCodes = {
  /** Any other failure: bad configuration, a store that cannot be opened, lost polling. */
  failed: 1,
  /** Another daemon already runs on the same database (DK-2 AC1). Starting again cannot help. */
  alreadyRunning: 3,
  /** Telegram answered `409 Conflict`: another process reads the same bot (DK-2 AC2). */
  botInUse: 4,
} as const;

export type ExitCode = (typeof exitCodes)[keyof typeof exitCodes];
