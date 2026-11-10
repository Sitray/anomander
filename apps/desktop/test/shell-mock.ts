import { vi } from 'vitest';
import type { Snapshot, shell } from '../src/shell.ts';

type Shell = typeof shell;

/** Stands in for `src/shell.ts` in every window test: no test ever reaches real Tauri. */
export const shellMock = {
  snapshot: vi.fn<Shell['snapshot']>(),
  saveSetup: vi.fn<Shell['saveSetup']>(),
  startDaemon: vi.fn<Shell['startDaemon']>(),
  stopDaemon: vi.fn<Shell['stopDaemon']>(),
  onSnapshot: vi.fn<Shell['onSnapshot']>(),
};

let handler: ((snapshot: Snapshot) => void) | undefined;

/** Resets the mock so `snapshot()` answers `initial` and `emit` plays the shell's event. */
export const resetShell = (initial: Snapshot): void => {
  handler = undefined;
  for (const mock of Object.values(shellMock)) mock.mockReset();
  shellMock.snapshot.mockResolvedValue(initial);
  shellMock.saveSetup.mockResolvedValue(initial);
  shellMock.startDaemon.mockResolvedValue(undefined);
  shellMock.stopDaemon.mockResolvedValue(undefined);
  shellMock.onSnapshot.mockImplementation(async (listener) => {
    handler = listener;
    return () => {
      if (handler === listener) handler = undefined;
    };
  });
};

/** The shell emits a new snapshot. */
export const emit = (snapshot: Snapshot): void => {
  if (handler === undefined) throw new Error('the window is not listening to the shell');
  handler(snapshot);
};
