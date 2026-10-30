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
// A match inside a string is reported too: a false alarm is safer than a miss.
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

// Removes // and /* */ comments while keeping string and template literals intact, so a
// quote or semicolon inside a comment cannot hide the import around it.
const stripComments = (source: string): string => {
  let output = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? '';
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      output += ' ';
    } else if (char === "'" || char === '"' || char === '`') {
      let end = index + 1;
      while (end < source.length && source[end] !== char) {
        end += source[end] === '\\' ? 2 : 1;
      }
      output += source.slice(index, end + 1);
      index = end + 1;
    } else {
      output += char;
      index += 1;
    }
  }
  return output;
};

const extractSpecifiers = (source: string): string[] => {
  const code = stripComments(source);
  return SPECIFIER_PATTERNS.flatMap((pattern) =>
    [...code.matchAll(pattern)].map((match) => match[1] ?? ''),
  );
};

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
