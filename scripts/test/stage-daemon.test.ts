// B77: the helpers of scripts/stage-daemon.mjs that decide what a release app carries: the pinned
// hash of Node's archive, no link left in the resource folder, and only the target's addon.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cachedArchive,
  NODE,
  refuseLinks,
  shimWorkspacePackages,
  strip,
} from '../stage-daemon.mjs';

let scratch: string;
let errors: string[];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'stage-daemon-'));
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((message: string) => {
    errors.push(message);
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  // `fail` ends the script with exit 1; here it ends the call instead.
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});

const write = (path: string, text = '') => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A directory link, as pnpm makes: a junction on Windows, which needs no privilege. */
const link = (target: string, path: string) => {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, 'junction');
};

describe("Node's archive (checksum)", () => {
  const bytes = Buffer.from('the pinned archive');
  const archive = {
    file: 'node-test.tar.gz',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const serves = (body: Buffer) =>
    vi.fn(async () => new Response(new Uint8Array(body), { status: 200 }));

  it('takes the cached archive when its hash matches, without downloading', async () => {
    write(join(scratch, archive.file), bytes.toString());
    const download = serves(Buffer.from('never read'));

    expect(await cachedArchive(archive, scratch, download)).toBe(join(scratch, archive.file));
    expect(download).not.toHaveBeenCalled();
  });

  it('downloads it again over a cached file that no longer matches', async () => {
    write(join(scratch, archive.file), 'a truncated download');
    const download = serves(bytes);

    expect(await cachedArchive(archive, scratch, download)).toBe(join(scratch, archive.file));
    expect(download).toHaveBeenCalledExactlyOnceWith(
      `https://nodejs.org/dist/v${NODE.version}/${archive.file}`,
    );
    expect(readFileSync(join(scratch, archive.file))).toEqual(bytes);
  });

  it('refuses a download whose hash is not the pinned one', async () => {
    const tampered = Buffer.from('another archive');
    const got = createHash('sha256').update(tampered).digest('hex');

    await expect(cachedArchive(archive, scratch, serves(tampered))).rejects.toThrow('exit 1');
    expect(errors).toEqual([
      `stage-daemon: ${archive.file} has SHA-256 ${got}, not ${archive.sha256}`,
    ]);
  });
});

describe('links (symlink refusal)', () => {
  it('fails on a link left anywhere in the stage, and passes a stage without one', () => {
    write(join(scratch, 'packages/daemon/src/main.ts'));
    write(join(scratch, 'node_modules/dep/index.js'));
    expect(() => refuseLinks(scratch)).not.toThrow();

    link(join(scratch, 'packages/daemon'), join(scratch, 'node_modules/nested/daemon'));

    expect(() => refuseLinks(scratch)).toThrow('exit 1');
    expect(errors).toEqual([
      `stage-daemon: a link is left: ${join('node_modules', 'nested', 'daemon')}`,
    ]);
  });

  /** The four workspace packages the stage carries, each exporting its `src/index.ts`. */
  const workspace = () => {
    for (const [dir, name] of [
      ['packages/core', '@anomander/core'],
      ['packages/protocol', '@anomander/protocol'],
      ['packages/daemon', '@anomander/daemon'],
      ['apps/telegram', '@anomander/telegram'],
    ] as const) {
      const exports = { '.': './src/index.ts', './testing': './test/support.ts' };
      write(join(scratch, dir, 'package.json'), JSON.stringify({ name, exports }));
      write(join(scratch, dir, 'src/index.ts'));
    }
  };

  it('replaces a link to a workspace package with a package that re-exports what was staged', () => {
    workspace();
    const core = join(scratch, 'node_modules/@anomander/core');
    link('../../packages/core', core);

    shimWorkspacePackages(scratch);

    expect(lstatSync(core).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(core, 'index.js'), 'utf8')).toBe(
      "export * from '../../../packages/core/src/index.ts';\n",
    );
    // `./testing` points at a file the stage does not carry, so it is not exported.
    expect(JSON.parse(readFileSync(join(core, 'package.json'), 'utf8'))).toEqual({
      name: '@anomander/core',
      private: true,
      type: 'module',
      exports: { '.': './index.js' },
    });
    expect(() => refuseLinks(scratch)).not.toThrow();
  });

  it('fails on a link to anything but a workspace package', () => {
    workspace();
    write(join(scratch, 'elsewhere/index.js'));
    link(join(scratch, 'elsewhere'), join(scratch, 'node_modules/stray'));

    expect(() => shimWorkspacePackages(scratch)).toThrow('exit 1');
    expect(errors).toEqual([
      `stage-daemon: unexpected link ${join('node_modules', 'stray')} -> ${join(scratch, 'elsewhere')}`,
    ]);
  });
});

describe('the dependencies (prebuild pruning)', () => {
  it("keeps only the target's better-sqlite3 addon and what the daemon loads", () => {
    const modules = join(scratch, 'node_modules');
    const sqlite = join(modules, 'better-sqlite3');
    for (const addon of ['darwin-arm64.node', 'win32-x64.node', 'linux-x64.node']) {
      write(join(sqlite, 'prebuilds', addon));
    }
    write(join(sqlite, 'deps/sqlite3/sqlite3.c'));
    write(join(sqlite, 'src/better_sqlite3.cpp'));
    write(join(sqlite, 'binding.gyp'));
    write(join(sqlite, 'lib/index.js'));
    write(join(modules, 'dep/index.js'));
    write(join(modules, 'dep/index.d.ts'));
    write(join(modules, 'dep/index.js.map'));
    write(join(modules, 'dep/src/index.ts'));
    write(join(modules, '.bin/dep'));
    write(join(modules, '.modules.yaml'));

    strip(scratch, 'win32-x64');

    expect(readdirSync(join(sqlite, 'prebuilds'))).toEqual(['win32-x64.node']);
    expect(readdirSync(sqlite).sort()).toEqual(['lib', 'prebuilds']);
    expect(readdirSync(join(modules, 'dep'), { recursive: true }).sort()).toEqual([
      'index.js',
      'src',
    ]);
    expect(existsSync(join(modules, '.bin'))).toBe(false);
    expect(existsSync(join(modules, '.modules.yaml'))).toBe(false);
  });
});

describe('when it stages', () => {
  const script = join(import.meta.dirname, '..', 'stage-daemon.mjs');
  const node = (...args: string[]) => spawnSync(process.execPath, args, { encoding: 'utf8' });

  it('runs when started directly, and says so for a target it has no release for', () => {
    const run = node(script, 'no-such-target');

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no release for no-such-target');
  });

  it('runs when started through a link to it', () => {
    const link = join(scratch, 'stage-daemon.mjs');
    symlinkSync(script, link);

    const run = node(link, 'no-such-target');

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no release for no-such-target');
  });

  it('stages nothing and prints nothing when imported', () => {
    const run = node('--input-type=module', '-e', `await import(${JSON.stringify(script)});`);

    expect(run.status).toBe(0);
    expect(run.stdout + run.stderr).toBe('');
  });
});
