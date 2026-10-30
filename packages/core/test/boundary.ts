import { dirname, relative, resolve } from 'node:path';

export interface SourceFile {
  path: string;
  source: string;
}

export interface BoundaryViolation {
  path: string;
  specifier: string;
}

// Static and side-effect imports, re-exports, dynamic import() and require().
// A match inside a comment or string is reported too: a false alarm is safer than a miss.
const SPECIFIER_PATTERNS = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const packageName = (specifier: string): string => {
  const [first = '', second = ''] = specifier.split('/');
  return specifier.startsWith('@') ? `${first}/${second}` : first;
};

const extractSpecifiers = (source: string): string[] =>
  SPECIFIER_PATTERNS.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1] ?? ''),
  );

const isAllowed = (
  file: SourceFile,
  specifier: string,
  root: string,
  allowedPackages: readonly string[],
): boolean => {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const target = relative(root, resolve(dirname(file.path), specifier));
    return !target.startsWith('..') && !target.startsWith('/');
  }
  return allowedPackages.includes(packageName(specifier));
};

export const findBoundaryViolations = (
  files: readonly SourceFile[],
  root: string,
  allowedPackages: readonly string[],
): BoundaryViolation[] =>
  files.flatMap((file) =>
    extractSpecifiers(file.source)
      .filter((specifier) => !isAllowed(file, specifier, root, allowedPackages))
      .map((specifier) => ({ path: file.path, specifier })),
  );
