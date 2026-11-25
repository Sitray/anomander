import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../src/locale.ts';
import { strings } from '../src/strings.ts';

// DK-20 (B28): a daemon on Windows never sends the principal to "the app on your Mac": a look at
// the screen and a task on the computer are not on Windows yet.
const real = Object.getOwnPropertyDescriptor(process, 'platform');
const runOn = (platform: NodeJS.Platform) =>
  Object.defineProperty(process, 'platform', { ...real, value: platform });

afterEach(() => {
  if (real !== undefined) Object.defineProperty(process, 'platform', real);
  setLocale('es');
});

describe('a look or a task asked where it cannot run', () => {
  it('on Windows, says it is not on Windows yet, in either language', () => {
    runOn('win32');
    expect(strings.routeInApp()).toBe('Eso todavía no puedo hacerlo en Windows.');
    setLocale('en');
    expect(strings.routeInApp()).toBe("I can't do that on Windows yet.");
  });

  it('on macOS, sends the principal to the app on their Mac, as before', () => {
    runOn('darwin');
    expect(strings.routeInApp()).toBe(
      'Eso solo puedo hacerlo desde la app de ANOMANDER en tu Mac.',
    );
    setLocale('en');
    expect(strings.routeInApp()).toBe('I can only do that from the ANOMANDER app on your Mac.');
  });
});
