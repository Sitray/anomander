# @anomander/telegram

The Telegram front door: a grammY bot that long-polls Telegram (PRD §14.1) and hands the
principal's texts to the daemon through `onText` (`TextHandler` from `@anomander/protocol`).

## What it decides

- **Who may talk (R-1).** An update is processed only when the chat is `private` and both the
  chat ID and the sender's user ID equal `principalChatId`. Anything else gets no reply, never
  reaches the daemon, and is logged at `warn` with its chat ID and sender ID. This check runs
  first, for every update kind.
- **Which inputs are supported (R-20).** Text goes to the daemon. A PDF gets S-18; a photo or
  `image/*` file over 20 MB gets S-20; voice, video, sticker, location, contact and any other
  message type get S-17. Edited messages are ignored and logged at `info`. Photos and image
  files within the limit are receipts (M3) and are ignored and logged at `info` until then.

## What it never decides

What a text means. Expense, conversation or anything else is the daemon's call; the bot only
sends back the reply it receives and reports its delivery through `reply.onDelivered`.

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
holds briefly when empty), `sendMessage` and `deleteWebhook`; any other method returns
`{ ok: true, result: true }`.

```ts
import { createTelegramBot } from '@anomander/telegram';
import { startFakeTelegramApi, updates } from '@anomander/telegram/fake-telegram-api';

const api = await startFakeTelegramApi();
const bot = createTelegramBot({ token: api.token, apiRoot: api.apiRoot, principalChatId: 42, onText });
const polling = bot.start();

api.push(updates.text({ chatId: 42 }, '23 € cena'));
const [reply] = await api.waitForSent(1); // { chatId, text, messageId, payload }

await bot.stop();
await polling;
await api.close();
```

`updates` builds text, edited, document, photo, voice, video, sticker, location and contact
updates. A `Sender` defaults to a private chat whose sender is the chat itself; pass `fromId` or
`chatType` to build anyone else. Updates are handled in order, so a reply to a later principal
text proves an earlier update was already handled.
