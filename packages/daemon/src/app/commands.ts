import { ROUTE_KINDS, type RouteKind } from '@anomander/protocol';
import type { Door } from '../connections/session.ts';

/** `/start`, `/start@bot` or `/start anything`, as Telegram sends a command. */
export const isStart = (text: string) => /^\/start(?:@\w+)?(?:\s|$)/.test(text.trim());

/** The task of `/mcp <tarea>` or `/mcp@bot <tarea>`, empty without one; `undefined` otherwise. */
export const connectionCommand = (text: string): string | undefined => {
  const command = /^\/mcp(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return command === null ? undefined : (command[1] ?? '').trim();
};

/** R-29: `/exportar` or `/exportar@bot`, with anything after it. */
export const isExport = (text: string) => /^\/exportar(?:@\w+)?(?:\s|$)/.test(text.trim());

/** The front door a message came through: the local channel names its messages `desktop:…`. */
export const doorOf = (channelRef: string): Door =>
  channelRef.startsWith('desktop:') ? 'app' : 'telegram';

/**
 * DK-13 AC1: a look and a task on the computer need the app; connections serve both doors.
 * DK-20: on Windows the app has neither yet, so it offers only connections, as Telegram does.
 */
export const routesOf = (door: Door): readonly RouteKind[] =>
  door === 'app' && process.platform !== 'win32' ? ROUTE_KINDS : ['connect'];
