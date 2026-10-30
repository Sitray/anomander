# @anomander/telegram

The Telegram front door: a grammY bot that long-polls Telegram (PRD §14.1) and hands the
principal's texts to the daemon through `onText` (`TextHandler`) and receipts through
`onReceipt` (`ReceiptHandler`), both from `@anomander/protocol`.

## What it decides

- **Who may talk (R-1).** An update is processed only when the chat is `private` and both the
  chat ID and the sender's user ID equal `principalChatId`. Anything else gets no reply, never
  reaches the daemon, and is logged at `warn` with its chat ID and sender ID. This check runs
  first, for every update kind.
- **Which inputs are supported (R-20).** Text goes to `onText`. A photo (its largest size) or an
  `image/*` file of 20 MB or less is a receipt and goes to `onReceipt` (R-3); its caption is the
  principal's declaration (R-3 AC5). A PDF gets S-18; a photo or `image/*` file over 20 MB gets
  S-20; voice, video, sticker, location, contact and any other message type get S-17. Edited
  messages are ignored and logged at `info`.
- **Albums (R-3 AC4).** Telegram sends each photo of an album as its own update, sharing a
  `media_group_id`. The bot collects them for 2 seconds after the first one arrives and hands
  them to `onReceipt` as one receipt (`telegram:album:<media_group_id>`), in arrival order, with
  their captions joined. The PRD says "the daemon collects"; it happens here because grouping
  updates is Telegram transport, and the daemon only ever sees one receipt.

## How a receipt travels

1. `PrincipalReceipt.images[i].load()` downloads the bytes only when the daemon asks: `getFile`,
   then the file URL on the same Bot API server (`<apiRoot>/file/bot<token>/<file_path>`), so
   the fake API serves them in tests.
2. The reply is sent with `reply.buttons` as an inline keyboard in one row; each button's
   `callback_data` is the button's `data` (`decision:<id>:<option index>`, R-17 AC1).
3. `reply.onDelivered` gets the sent message's `channelRef`, so the daemon can store which
   message shows a pending decision (R-17 AC2). Pressing a button is handled in T2.

## What it never decides

What a text or a receipt means. Expense, conversation, a question or anything else is the
daemon's call; the bot only sends back the reply it receives and reports its delivery through
`reply.onDelivered`.

## Invariant

Every bot string comes from `strings` in `@anomander/protocol` (PRD §12). Never write a
user-facing literal here.

## Tests

```sh
pnpm vitest run apps/telegram
pnpm -F @anomander/telegram typecheck
```

`test/bot.test.ts` runs the real bot, with long polling, against the fake Telegram API.

## Fake Telegram API

`@anomander/telegram/fake-telegram-api` (`test-support/fake-telegram-api.ts`) is a local
Bot API server for integration tests. It implements `getMe`, `getUpdates` (honours `offset`,
holds briefly when empty), `sendMessage`, `deleteWebhook`, `getFile` and the file download
URL; any other method returns `{ ok: true, result: true }`. `putFile(fileId, bytes)` decides
what a file ID serves; `pngBytes(red, green, blue)` generates a 1×1 PNG, so tests never need a
real receipt.

```ts
import { createTelegramBot } from '@anomander/telegram';
import { pngBytes, startFakeTelegramApi, updates } from '@anomander/telegram/fake-telegram-api';

const api = await startFakeTelegramApi();
const bot = createTelegramBot({
  token: api.token,
  apiRoot: api.apiRoot,
  principalChatId: 42,
  onText,
  onReceipt,
});
const polling = bot.start();

api.push(updates.text({ chatId: 42 }, '23 € cena'));
const [reply] = await api.waitForSent(1); // { chatId, text, messageId, payload }

api.putFile('receipt', pngBytes(200));
api.push(updates.photo({ chatId: 42 }, { fileId: 'receipt', caption: 'cena' }));

await bot.stop();
await polling;
await api.close();
```

`updates` builds text, edited, document, photo, voice, video, sticker, location and contact
updates. `photo` and `document` take `{ fileId, fileSize, caption, mediaGroupId }`.
`waitForSent` resolves at once when enough messages were already sent. A `Sender` defaults to a private chat whose sender is the chat itself; pass `fromId` or
`chatType` to build anyone else. Updates are handled in order, so a reply to a later principal
text proves an earlier update was already handled.
