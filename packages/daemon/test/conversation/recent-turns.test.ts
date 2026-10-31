import { describe, expect, it } from 'vitest';
import { createRecentTurns, recordingNotices } from '../../src/conversation/recent-turns.ts';

// PRD R-16 AC3: the interpreter sees the last 10 turns, none older than 30 minutes.
describe('recent turns', () => {
  it('keeps only the last 10 turns, oldest first', () => {
    const turns = createRecentTurns({ now: () => new Date('2026-10-31T10:00:00Z') });
    for (let i = 1; i <= 12; i++) turns.add(`message ${i}`, `reply ${i}`);

    const recent = turns.recent();

    expect(recent).toHaveLength(10);
    expect(recent[0]).toEqual({ principal: 'message 3', reply: 'reply 3' });
    expect(recent[9]).toEqual({ principal: 'message 12', reply: 'reply 12' });
  });

  it('drops turns older than 30 minutes', () => {
    let clock = new Date('2026-10-31T10:00:00Z');
    const turns = createRecentTurns({ now: () => clock });
    turns.add('old', 'old reply');
    clock = new Date('2026-10-31T10:20:00Z');
    turns.add('new', 'new reply');
    clock = new Date('2026-10-31T10:30:01Z');

    expect(turns.recent()).toEqual([{ principal: 'new', reply: 'new reply' }]);
  });

  it('records a message sent unasked as a turn with no principal part', async () => {
    const turns = createRecentTurns({ now: () => new Date('2026-10-31T10:00:00Z') });
    const sent: string[] = [];
    const notify = recordingNotices(turns, async (message) => {
      sent.push(message.text);
    });

    await notify({ text: 'Todavía no he podido leer el ticket.' });

    expect(sent).toEqual(['Todavía no he podido leer el ticket.']);
    expect(turns.recent()).toEqual([
      { principal: null, reply: 'Todavía no he podido leer el ticket.' },
    ]);
  });
});
