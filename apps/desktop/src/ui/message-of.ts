/** Tauri rejects a command with the shell's own string; anything else is shown as it reads. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
