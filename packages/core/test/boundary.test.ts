import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBoundaryViolations, type SourceFile } from './boundary.ts';

// R-15 AC2: packages/core imports nothing from packages/daemon, any app, or any provider SDK.
// The rule is an allowlist: relative imports that stay inside core, plus the packages below.
const CORE_ROOT = resolve(import.meta.dirname, '..');
const ALLOWED_PACKAGES = ['zod'];

const listSources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSources(path);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });

describe('core package boundary', () => {
  it('core source imports only modules inside core and allowed packages', () => {
    const files: SourceFile[] = listSources(join(CORE_ROOT, 'src')).map((path) => ({
      path,
      source: readFileSync(path, 'utf8'),
    }));

    expect(findBoundaryViolations(files, CORE_ROOT, ALLOWED_PACKAGES)).toEqual([]);
  });

  it('core package.json depends only on allowed packages', () => {
    const manifest = JSON.parse(readFileSync(join(CORE_ROOT, 'package.json'), 'utf8'));
    const dependencies = Object.keys({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    });

    expect(dependencies.filter((name) => !ALLOWED_PACKAGES.includes(name))).toEqual([]);
  });

  it('flags imports from the daemon, apps, provider SDKs and paths that leave core', () => {
    const file = (name: string, source: string): SourceFile => ({
      path: join(CORE_ROOT, 'src', name),
      source,
    });
    const files = [
      file('ok.ts', "import { z } from 'zod';\nimport { a } from './truth/a.ts';"),
      file('daemon.ts', "import { run } from '@anomander/daemon';"),
      file('app.ts', "export { bot } from '@anomander/telegram';"),
      file('sdk.ts', "import { complete } from '@earendil-works/pi-ai';"),
      file('dynamic.ts', "const db = await import('better-sqlite3');"),
      file('require.ts', "const g = require('grammy');"),
      file('escape.ts', "import { x } from '../../daemon/src/x.ts';"),
      file('side-effect.ts', "import 'node:fs';"),
    ];

    expect(findBoundaryViolations(files, CORE_ROOT, ALLOWED_PACKAGES)).toEqual([
      { path: join(CORE_ROOT, 'src', 'daemon.ts'), specifier: '@anomander/daemon' },
      { path: join(CORE_ROOT, 'src', 'app.ts'), specifier: '@anomander/telegram' },
      { path: join(CORE_ROOT, 'src', 'sdk.ts'), specifier: '@earendil-works/pi-ai' },
      { path: join(CORE_ROOT, 'src', 'dynamic.ts'), specifier: 'better-sqlite3' },
      { path: join(CORE_ROOT, 'src', 'require.ts'), specifier: 'grammy' },
      { path: join(CORE_ROOT, 'src', 'escape.ts'), specifier: '../../daemon/src/x.ts' },
      { path: join(CORE_ROOT, 'src', 'side-effect.ts'), specifier: 'node:fs' },
    ]);
  });
});
