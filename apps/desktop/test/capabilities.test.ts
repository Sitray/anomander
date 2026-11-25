import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Security L1: each window may call only the app's commands its own script calls. The commands are
// declared in `build.rs` (once declared, Tauri checks every app command against the capabilities),
// and each window's grants live in `capabilities/<window>.json`. Read as text: nothing here runs.
const root = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

/** The capability's permissions, by window label. */
const grants = (file: string, window: string): string[] => {
  const capability = JSON.parse(read(`src-tauri/capabilities/${file}`)) as {
    windows: string[];
    permissions: string[];
  };
  expect(capability.windows).toEqual([window]);
  return capability.permissions;
};
const main = grants('default.json', 'main');
const notch = grants('notch.json', 'notch');

/** `get_snapshot` → `allow-get-snapshot`, as tauri-build names the generated permission. */
const allow = (command: string): string => `allow-${command.replaceAll('_', '-')}`;

/** The names of the commands `invoke('…')` calls, by source file under `src/`. */
const invokes = (): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  for (const entry of readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })) {
    if (!/\.tsx?$/.test(entry)) continue;
    const names = [...read(join('src', entry)).matchAll(/\binvoke(?:<[^>]*>)?\(\s*'([a-z_]+)'/g)];
    if (names.length > 0)
      found.set(
        relative('src', join('src', entry)),
        names.map((m) => m[1] ?? ''),
      );
  }
  return found;
};

/** The quoted names in the Rust list that opens with `start`, up to its closing `]`. */
const rustList = (source: string, start: string): string[] => {
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`no ${start}`);
  const body = source.slice(from + start.length, source.indexOf(']', from + start.length));
  return body
    .split(',')
    .map((name) => name.trim().replaceAll('"', ''))
    .filter(Boolean);
};
const declared = rustList(read('src-tauri/build.rs'), 'COMMANDS: &[&str] = &[');
const handled = rustList(read('src-tauri/src/lib.rs'), 'generate_handler![');

describe('the windows’ command permissions', () => {
  it('declares every command the app handles, so Tauri checks each one by window', () => {
    expect([...declared].sort()).toEqual([...handled].sort());
  });

  it('grants each window every command its script invokes', () => {
    const calls = invokes();
    expect(calls.size).toBeGreaterThan(1);
    for (const [file, names] of calls) {
      const granted = file.startsWith('notch/') ? notch : main;
      for (const name of names) expect(granted, `${file} invokes ${name}`).toContain(allow(name));
    }
  });

  it('lets the notch window open the chat and listen to the shell, nothing else', () => {
    expect([...notch].sort()).toEqual([
      'allow-reveal',
      'core:event:allow-listen',
      'core:event:allow-unlisten',
    ]);
    for (const command of [
      'perform_action',
      'capture_screen',
      'save_setup',
      'answer_login',
      'save_connection',
    ]) {
      expect(notch).not.toContain(allow(command));
    }
  });

  it('grants no app command the code does not declare', () => {
    const known = new Set(declared.map(allow));
    for (const permission of [...main, ...notch].filter((p) => !p.includes(':'))) {
      expect(known, permission).toContain(permission);
    }
  });

  it('lets the main window only open the file dialog (DK-21), and the notch none of it', () => {
    expect(main.filter((p) => p.startsWith('dialog:'))).toEqual(['dialog:allow-open']);
    expect(notch.filter((p) => p.startsWith('dialog:'))).toEqual([]);
  });
});
