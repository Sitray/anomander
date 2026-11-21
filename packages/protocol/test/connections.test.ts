import { describe, expect, it } from 'vitest';
import { OAUTH_CONNECTIONS } from '../src/connections.ts';

// DK-11 AC12: the remote presets are data the shell saves as written.
describe('the remote ready-made connections', () => {
  it('are reached over https, each by a name of its own, with no tool marked read-only', () => {
    const names = OAUTH_CONNECTIONS.map((preset) => preset.name);
    expect(new Set(names).size).toBe(names.length);
    for (const preset of OAUTH_CONNECTIONS) {
      expect(new URL(preset.url).protocol, preset.name).toBe('https:');
      expect(preset).not.toHaveProperty('readOnly');
    }
  });
});
