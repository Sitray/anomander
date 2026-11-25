import { describe, expect, it } from 'vitest';
import { isWebAddress, piecesOf } from '../src/chat/links.ts';

// B25 (DK-19 AC2): which addresses of a reply the chat offers to open.
describe('the web addresses of a reply', () => {
  it('a user-name address stays text', () => {
    expect(isWebAddress('https://ana@evil.com/')).toBe(false);
    expect(piecesOf('https://ana@evil.com/x')).toEqual([{ text: 'https://ana@evil.com/x' }]);
  });

  it('leaves out an ellipsis that ends the sentence', () => {
    expect(piecesOf('Mira https://example.com…')).toContainEqual({ url: 'https://example.com' });
  });
});
