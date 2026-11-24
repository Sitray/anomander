import type { ChatButton, ChatStoredMessage } from '@anomander/protocol';
import type Database from 'better-sqlite3';

// DK-16 (docs/desktop-prd.md): the conversation with the principal, from either door, kept in the
// local database (`conversation`, migration `0009`), so the app shows it again and the text
// interpreter picks up its recent turns after a restart (R-16 AC3). No image is kept, nor a text
// pasted for a login (R-17 AC7). It is erased on "Borrar conversación", on a confirmed forget and
// after 90 days. Nothing here logs a message's words.

/** S7: the retention job erases the messages older than this. */
export const CONVERSATION_RETENTION_DAYS = 90;

/** One message as it is stored; the database gives it its id. */
export type ConversationMessage = Omit<ChatStoredMessage, 'id'>;

interface Row {
  id: number;
  sender: ChatStoredMessage['from'];
  door: ChatStoredMessage['door'];
  text: string;
  buttons_json: string | null;
  channel_ref: string | null;
  sent_at: string;
}

const fromRow = (row: Row): ChatStoredMessage => ({
  id: row.id,
  from: row.sender,
  door: row.door,
  text: row.text,
  buttons: row.buttons_json === null ? [] : (JSON.parse(row.buttons_json) as ChatButton[]),
  channelRef: row.channel_ref,
  at: row.sent_at,
});

const COLUMNS = 'id, sender, door, text, buttons_json, channel_ref, sent_at';

/**
 * Stores `messages` in order, in one transaction, so a principal's message is always followed by
 * the reply it got. Returns their ids.
 */
export const recordMessages = (
  db: Database.Database,
  messages: readonly ConversationMessage[],
): number[] => {
  const insert = db.prepare(
    `INSERT INTO conversation (sender, door, text, buttons_json, channel_ref, sent_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  return db.transaction(() =>
    messages.map(
      (message) =>
        insert.run(
          message.from,
          message.door,
          message.text,
          message.buttons.length === 0 ? null : JSON.stringify(message.buttons),
          message.channelRef,
          message.at,
        ).lastInsertRowid as number,
    ),
  )();
};

/** A reply was delivered as `channelRef`: a press on one of its buttons still resolves (DK-16). */
export const deliveredAs = (db: Database.Database, id: number, channelRef: string): void => {
  db.prepare('UPDATE conversation SET channel_ref = ? WHERE id = ?').run(channelRef, id);
};

/** S4: the latest `limit` messages, oldest first. */
export const storedConversation = (db: Database.Database, limit: number): ChatStoredMessage[] =>
  db
    .prepare<[number], Row>(`SELECT ${COLUMNS} FROM conversation ORDER BY id DESC LIMIT ?`)
    .all(limit)
    .reverse()
    .map(fromRow);

/** S3: the messages sent at `since` or later, oldest first. */
export const conversationSince = (db: Database.Database, since: string): ChatStoredMessage[] =>
  db
    .prepare<[string], Row>(`SELECT ${COLUMNS} FROM conversation WHERE sent_at >= ? ORDER BY id`)
    .all(since)
    .map(fromRow);

/**
 * S5, S6: erases every message. Then the WAL is checkpointed and truncated, as a forgotten
 * memory's is (R-23 AC7): with `secure_delete` on, the freed pages hold zeros. Returns how many
 * were erased.
 */
export const forgetConversation = (db: Database.Database): number => {
  const { changes } = db.prepare('DELETE FROM conversation').run();
  if (changes > 0) db.pragma('wal_checkpoint(TRUNCATE)');
  return changes;
};

/** S7: the retention job erases the messages sent before `before`, as `forgetConversation` does. */
export const forgetConversationBefore = (db: Database.Database, before: string): number => {
  const { changes } = db.prepare('DELETE FROM conversation WHERE sent_at < ?').run(before);
  if (changes > 0) db.pragma('wal_checkpoint(TRUNCATE)');
  return changes;
};
