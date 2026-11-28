// Stages the daemon a release app carries (B11): `apps/desktop/src-tauri/resources/daemon/`, which
// `tauri.release.conf.json` ships as the app's `daemon/` resource folder.
//
//   node scripts/stage-daemon.mjs [darwin-arm64 | win32-x64]   (default: this machine's)
//
// The folder holds:
//   bin/node (bin/node.exe)   Node at NODE.version, downloaded from nodejs.org, its SHA-256 pinned
//   packages/{core,protocol,daemon}, apps/telegram
//                             the sources the daemon runs, laid out as in this repository, so the
//                             paths relative to `import.meta.dirname` (migrations, scripts) hold
//   node_modules/             the production dependencies of `pnpm-lock.yaml`, as real folders
//   stage.json                the target and Node's version
//
// No symbolic link: Tauri copies a resource folder file by file and the NSIS installer cannot make
// one. pnpm installs with its hoisted linker (real folders), and each workspace package is reached
// through a small JavaScript package in `node_modules` that re-exports its `src/index.ts`: Node
// strips the types of a `.ts` file only outside `node_modules`.
//
// Run it again at will: it rebuilds the folder from scratch, beside it, and swaps it in at the end.
// Imported instead of run (scripts/test/stage-daemon.test.ts), it stages nothing: it only exports
// the helpers below.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'apps/desktop/src-tauri/resources/daemon');
const PARTIAL = `${OUT}.partial`;
const CACHE = join(ROOT, 'node_modules/.cache/anomander-node');

/**
 * The Node every release carries; its major is `.node-version`'s. To move it, take the new
 * version's hashes from https://nodejs.org/dist/v<version>/SHASUMS256.txt.
 */
export const NODE = {
  version: '24.22.3',
  archives: {
    'darwin-arm64': {
      file: 'node-v24.22.3-darwin-arm64.tar.gz',
      sha256: 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd',
      binary: 'bin/node',
    },
    'win32-x64': {
      file: 'node-v24.22.3-win-x64.zip',
      sha256: 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f',
      binary: 'node.exe',
    },
  },
};

/** The workspace packages the daemon runs, and what of each it needs besides `package.json`. */
const PACKAGES = {
  'packages/core': ['src'],
  'packages/protocol': ['src'],
  'packages/daemon': [
    'src',
    'migrations',
    'scripts/import-ledger.ts',
    'scripts/login.ts',
    'scripts/logout.ts',
    'scripts/mcp-oauth.ts',
  ],
  'apps/telegram': ['src'],
};

/** Files of the dependencies the daemon never loads: types, source maps, TypeScript sources
 * (Node will not run those from `node_modules`), and pnpm's own bookkeeping. */
const STRIPPED_FILE = /\.(d\.[cm]?ts|[cm]?ts|map)$/;
const STRIPPED_NAME = /^(\.bin|\.modules\.yaml|\.pnpm.*)$/;

const fail = (message) => {
  console.error(`stage-daemon: ${message}`);
  process.exit(1);
};

const run = (command, args, options = {}) => {
  const ran = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (ran.status !== 0) fail(`${command} ${args.join(' ')} ended with ${ran.status ?? ran.signal}`);
};

export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Each path under `dir`, depth first, children before their folder. */
export function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    yield path;
  }
}

/** The tracked files of `paths`, from git: what a clean checkout of the tag has, nothing else. */
const tracked = (paths) => {
  const listed = spawnSync('git', ['ls-files', '-z', '--', ...paths], { cwd: ROOT });
  if (listed.status !== 0) fail('git ls-files failed');
  return listed.stdout.toString().split('\0').filter(Boolean);
};

const copySources = (stage) => {
  const roots = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
  for (const [pkg, parts] of Object.entries(PACKAGES)) {
    roots.push(`${pkg}/package.json`, ...parts.map((part) => `${pkg}/${part}`));
  }
  for (const file of tracked(roots)) {
    if (!existsSync(join(ROOT, file))) continue; // deleted in the working tree
    mkdirSync(dirname(join(stage, file)), { recursive: true });
    copyFileSync(join(ROOT, file), join(stage, file));
  }
};

/** pnpm, for `target`'s platform, with real folders instead of links. */
const install = (stage, target) => {
  const [os, cpu] = target.split('-');
  const workspace = join(stage, 'pnpm-workspace.yaml');
  writeFileSync(
    workspace,
    `${readFileSync(workspace, 'utf8')}\n# stage-daemon.mjs\nnodeLinker: hoisted\nsupportedArchitectures:\n  os: [${os}]\n  cpu: [${cpu}]\n`,
  );
  run('pnpm', ['install', '--frozen-lockfile', '--prod', '--ignore-scripts', '--prefer-offline'], {
    cwd: stage,
  });
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) rmSync(join(stage, file));
};

/** Replaces each link pnpm made to a workspace package with a package that re-exports it. */
export const shimWorkspacePackages = (stage) => {
  const byDir = new Map(
    Object.keys(PACKAGES).map((pkg) => [
      join(stage, pkg),
      JSON.parse(readFileSync(join(stage, pkg, 'package.json'), 'utf8')),
    ]),
  );
  for (const path of walk(stage)) {
    if (!lstatSync(path).isSymbolicLink()) continue;
    const target = resolve(dirname(path), readlinkSync(path));
    const manifest = byDir.get(target);
    if (manifest === undefined) fail(`unexpected link ${relative(stage, path)} -> ${target}`);
    rmSync(path);
    mkdirSync(path);
    const exports = {};
    for (const [key, file] of Object.entries(manifest.exports ?? {})) {
      if (!existsSync(join(target, file))) continue; // test support, not staged
      const shim = `./${key === '.' ? 'index' : key.slice(2)}.js`;
      const from = relative(path, join(target, file)).split(sep).join(posix.sep);
      writeFileSync(join(path, shim), `export * from '${from}';\n`);
      exports[key] = shim;
    }
    const shimmed = { name: manifest.name, private: true, type: 'module', exports };
    writeFileSync(join(path, 'package.json'), `${JSON.stringify(shimmed, null, 2)}\n`);
  }
};

/** Drops what the daemon never loads from the dependencies, and the other platforms' addons. */
export const strip = (stage, target) => {
  const modules = join(stage, 'node_modules');
  for (const path of walk(modules)) {
    const name = path.slice(path.lastIndexOf(sep) + 1);
    if (STRIPPED_NAME.test(name) || (STRIPPED_FILE.test(name) && lstatSync(path).isFile())) {
      rmSync(path, { recursive: true, force: true });
    }
  }
  // better-sqlite3 ships a prebuilt addon for every platform, and the C sources to build one.
  for (const sqlite of [...walk(modules)].filter((path) => path.endsWith(`${sep}better-sqlite3`))) {
    for (const part of ['deps', 'src', 'binding.gyp']) {
      rmSync(join(sqlite, part), { recursive: true, force: true });
    }
    for (const addon of readdirSync(join(sqlite, 'prebuilds'))) {
      if (addon !== `${target}.node`) rmSync(join(sqlite, 'prebuilds', addon));
    }
  }
};

/**
 * The path of Node's `archive` in `cache`: the cached file when its hash still matches, else one
 * downloaded from nodejs.org into it. It fails unless the file has the pinned SHA-256.
 */
export const cachedArchive = async (archive, cache = CACHE, download = fetch) => {
  const cached = join(cache, archive.file);
  if (!existsSync(cached) || sha256(cached) !== archive.sha256) {
    const url = `https://nodejs.org/dist/v${NODE.version}/${archive.file}`;
    console.info(`stage-daemon: downloading ${url}`);
    const response = await download(url);
    if (!response.ok) fail(`${url}: ${response.status}`);
    mkdirSync(cache, { recursive: true });
    writeFileSync(cached, Buffer.from(await response.arrayBuffer()));
  }
  const got = sha256(cached);
  if (got !== archive.sha256) fail(`${archive.file} has SHA-256 ${got}, not ${archive.sha256}`);
  return cached;
};

/** Node's binary, from the cache when its hash still matches, else from nodejs.org. */
const stageNode = async (stage, target) => {
  const archive = NODE.archives[target];
  const cached = await cachedArchive(archive);
  const top = archive.file.replace(/\.(tar\.gz|zip)$/, '');
  const extracted = join(stage, '.node');
  mkdirSync(extracted);
  // bsdtar reads both archives, on macOS and on Windows alike. On Windows the name is absolute:
  // under Git Bash `tar` is GNU tar, which cannot read a .zip.
  const tar =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  run(tar, ['-xf', cached, '-C', extracted, `${top}/${archive.binary}`, `${top}/LICENSE`]);
  const bin = join(stage, 'bin');
  mkdirSync(bin);
  const node = join(bin, posix.basename(archive.binary));
  renameSync(join(extracted, top, archive.binary), node);
  renameSync(join(extracted, top, 'LICENSE'), join(bin, 'LICENSE'));
  rmSync(extracted, { recursive: true });
  chmodSync(node, 0o755);
  return node;
};

/** On the target itself, the staged Node runs what the daemon needs at its start. */
const check = (stage, node) => {
  const probe = [
    "import { createRequire } from 'node:module';",
    "const require = createRequire(process.cwd() + '/');",
    "const Database = require('better-sqlite3');",
    "new Database(':memory:').prepare('SELECT 1').get();",
    "const web = require('pi-web-access/package.json');",
    "await import('@anomander/core'); await import('@anomander/protocol');",
    "await import('./src/store/database.ts');",
    "console.info('node', process.version, 'pi-web-access', web.version);",
  ].join('\n');
  run(node, ['--input-type=module', '-e', probe], {
    cwd: join(stage, 'packages/daemon'),
    shell: false,
  });
};

/** Fails when any link is left under `stage`: the app's resource folder must hold none. */
export const refuseLinks = (stage) => {
  for (const path of walk(stage)) {
    if (lstatSync(path).isSymbolicLink()) fail(`a link is left: ${relative(stage, path)}`);
  }
};

const stage = async () => {
  const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
  if (!(target in NODE.archives)) {
    fail(`no release for ${target}; one of: ${Object.keys(NODE.archives).join(', ')}`);
  }
  const major = readFileSync(join(ROOT, '.node-version'), 'utf8').trim();
  if (NODE.version.split('.')[0] !== major)
    fail(`Node ${NODE.version} is not .node-version's ${major}`);

  rmSync(PARTIAL, { recursive: true, force: true });
  mkdirSync(PARTIAL, { recursive: true });
  copySources(PARTIAL);
  install(PARTIAL, target);
  strip(PARTIAL, target);
  shimWorkspacePackages(PARTIAL);
  const node = await stageNode(PARTIAL, target);
  refuseLinks(PARTIAL);
  writeFileSync(
    join(PARTIAL, 'stage.json'),
    `${JSON.stringify({ target, node: NODE.version }, null, 2)}\n`,
  );
  if (target === `${process.platform}-${process.arch}`) check(PARTIAL, node);
  rmSync(OUT, { recursive: true, force: true });
  renameSync(PARTIAL, OUT);
  console.info(`stage-daemon: ${relative(ROOT, OUT)} is ready for ${target}`);
};

// Run as `node scripts/stage-daemon.mjs`, not imported: Node gives the main module's real path.
const script = process.argv[1];
if (script !== undefined && existsSync(script)) {
  if (realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))) await stage();
}
