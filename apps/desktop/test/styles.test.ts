import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// S5 (L8): what the stylesheet must keep, read as text: jsdom computes no layout.
const css = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8');

/** The declarations of the first rule whose selector list is exactly `selector`. */
const rule = (selector: string): string => {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule ${selector}`);
  return css.slice(start, css.indexOf('}', start));
};

describe('the stylesheet', () => {
  it('spends no colour outside the tokens, and no pixel in the task block', () => {
    expect(css).not.toContain('#e5484d');
    for (const selector of ['.target-preview', '.target-mark', '.task-bar']) {
      const declarations = rule(selector);
      // Hairlines (1px, 2px) are the stylesheet's own idiom; anything larger is a spacing token.
      expect(declarations, selector).not.toMatch(/\b([3-9]|\d{2,})px/);
      expect(declarations, selector).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(declarations, selector).not.toMatch(/rgba?\(/);
    }
  });

  it('gives a link a target of at least 24 pixels without moving the text', () => {
    expect(rule('.link')).toContain('position: relative');
    const hit = rule('.link::before');
    expect(hit).toContain('position: absolute');
    expect(hit).toMatch(/height: 1\.5rem|min-height: 1\.5rem/);
  });

  it('lets a command block be selected and copied', () => {
    const block = rule('.code-block');
    expect(block).toContain('user-select: text');
    expect(block).toContain('var(--mono)');
  });
});
