import type { ButtonPress, PrincipalText } from '@anomander/protocol';
import { buttons, strings } from '@anomander/protocol';
import type { TelegramLogger, TelegramReply } from '@anomander/telegram';
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  CredentialInfo,
  LoginOptions,
} from '@earendil-works/pi-ai';

// R-27: connecting a model with the principal's subscription from Telegram. Code handles the
// `/login` and `/logout` commands, their buttons and the text a running login waits for, before
// every other route (R-17 AC7); none of it reaches the processor or the recent turns (R-16 AC3).
//
// pi-ai runs each provider's flow (`models.login`) and stores the credential; this module answers
// its prompts and turns its events into §12 strings. What the principal pastes, the links and the
// tokens are never logged: logs carry the provider ID and the outcome only.

/** The part of pi-ai's `Models` a login needs. */
export interface ModelLogin {
  login(
    providerId: string,
    type: 'oauth',
    interaction: AuthInteraction,
    options?: LoginOptions,
  ): Promise<unknown>;
  logout(providerId: string): Promise<void>;
}

export interface TelegramLoginDeps {
  models: ModelLogin;
  /** The stored credentials, for `/logout` (only `list` is used: it exposes no secret). */
  credentials: { list(): Promise<readonly CredentialInfo[]> };
  /** pi-ai's `LoginOptions.getDeviceId`, which Sign in with ChatGPT requires. */
  getDeviceId: () => string;
  /** Sends a message to the principal straight through the bot, never as a recent turn. */
  send: (message: TelegramReply) => Promise<void>;
  /** Deletes the principal's message `telegram:<message_id>` (R-27 AC3). */
  deleteMessage: (channelRef: string) => Promise<void>;
  logger: TelegramLogger;
  /** R-27 AC4: a login not completed in this time is abandoned. Default 10 minutes. */
  timeoutMs?: number;
}

export interface TelegramLogin {
  /** `undefined` when the text is not for a login; then the other routes decide. */
  handleText(message: PrincipalText): Promise<{ reply: TelegramReply | null } | undefined>;
  /** `undefined` when the press is not on a login button. */
  handleButton(press: ButtonPress): Promise<{ reply: TelegramReply | null } | undefined>;
  /** Abandons the running login, if any, without a reply. */
  stop(): void;
}

export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** An account that supports login (R-27 AC1), in the order of the S-60 buttons. */
interface Account {
  providerId: string;
  label: string;
  /** The text sent with the login link (S-61 or S-62); a device-code flow sends S-63 instead. */
  linkText?: () => string;
  /** Answers to prompts that are not for the principal. */
  answers: { select?: string; text?: string };
}

const ACCOUNTS: readonly Account[] = [
  {
    providerId: 'anthropic',
    label: buttons.claude,
    linkText: strings.loginPasteCode,
    // The copy-code method shows a code to paste back; the browser method needs a local browser.
    answers: { select: 'copy_code' },
  },
  {
    providerId: 'openai',
    label: buttons.chatGpt,
    linkText: strings.loginPasteAddress,
    answers: {},
  },
  {
    providerId: 'github-copilot',
    label: buttons.gitHubCopilot,
    // Its first prompt asks for a GitHub Enterprise domain; empty is github.com.
    answers: { text: '' },
  },
];

/** The accounts that support login, for the terminal scripts (R-27 AC7). */
export const LOGIN_ACCOUNTS: readonly { providerId: string; label: string }[] = ACCOUNTS.map(
  ({ providerId, label }) => ({ providerId, label }),
);

const account = (providerId: string | undefined) =>
  ACCOUNTS.find((candidate) => candidate.providerId === providerId);

// Distinct from a decision's `decision:<id>:<option>` (R-17 AC1).
const LOGIN_DATA = 'login:';
const LOGOUT_DATA = 'logout:';

/** `/login`, `/login@bot` or `/login anything`, as Telegram sends a command. */
const command = (text: string): 'login' | 'logout' | undefined => {
  const match = /^\/(login|logout)(?:@\w+)?(?:\s|$)/.exec(text.trim());
  return match?.[1] as 'login' | 'logout' | undefined;
};

interface Session {
  account: Account;
  controller: AbortController;
  /** Set while the flow waits for the principal's next text. */
  waiting: { resolve: (text: string) => void; reject: (error: Error) => void } | undefined;
  /** Set when a newer `/login` or a stop abandoned it: no S-65 then. */
  replaced: boolean;
}

export const createTelegramLogin = (deps: TelegramLoginDeps): TelegramLogin => {
  const { models, credentials, getDeviceId, send, deleteMessage, logger } = deps;
  const timeoutMs = deps.timeoutMs ?? LOGIN_TIMEOUT_MS;
  let current: Session | undefined;

  const sendLogged = (providerId: string, message: TelegramReply) =>
    send(message).catch(() => {
      logger.error('Failed to send a login message', { provider: providerId });
    });

  const abandon = (session: Session | undefined) => {
    if (session === undefined) return;
    session.replaced = true;
    session.controller.abort();
  };

  /** The principal's next text answers the prompt (R-27 AC3), unless the login ends first. */
  const nextText = (session: Session, prompt: AuthPrompt) =>
    new Promise<string>((resolve, reject) => {
      const signals = [session.controller.signal, ...(prompt.signal ? [prompt.signal] : [])];
      const cancel = () => {
        if (session.waiting?.reject === reject) session.waiting = undefined;
        reject(new Error('Login prompt cancelled'));
      };
      if (signals.some((signal) => signal.aborted)) {
        cancel();
        return;
      }
      for (const signal of signals) signal.addEventListener('abort', cancel, { once: true });
      session.waiting = { resolve, reject };
    });

  const interaction = (
    session: Session,
    post: (message: TelegramReply) => Promise<void>,
  ): AuthInteraction => {
    const { answers, linkText } = session.account;
    return {
      signal: session.controller.signal,
      prompt: (prompt) => {
        if (prompt.type === 'select' && answers.select !== undefined) {
          return Promise.resolve(answers.select);
        }
        if (prompt.type === 'text' && answers.text !== undefined) {
          return Promise.resolve(answers.text);
        }
        if (prompt.type === 'manual_code' || prompt.type === 'text') {
          return nextText(session, prompt);
        }
        // No flow offered here asks for a secret or an unexpected choice: the login fails.
        return Promise.reject(new Error(`unexpected ${prompt.type} prompt`));
      },
      notify: (event: AuthEvent) => {
        if (event.type === 'auth_url' && linkText !== undefined) {
          void post({ text: linkText(), buttons: [{ label: buttons.open, url: event.url }] });
        } else if (event.type === 'device_code') {
          void post({
            text: strings.loginDeviceCode(event.userCode),
            buttons: [{ label: buttons.open, url: event.verificationUri }],
          });
        }
      },
    };
  };

  const start = (chosen: Account) => {
    abandon(current);
    const session: Session = {
      account: chosen,
      controller: new AbortController(),
      replaced: false,
      waiting: undefined,
    };
    current = session;
    const provider = chosen.providerId;
    // The link, then the outcome, in the order the flow produced them.
    let outbox: Promise<void> = Promise.resolve();
    const post = (message: TelegramReply) => {
      outbox = outbox.then(() => sendLogged(provider, message));
      return outbox;
    };
    const timer = setTimeout(() => session.controller.abort(), timeoutMs);
    timer.unref?.();
    logger.info('Model login started', { provider });
    models
      .login(provider, 'oauth', interaction(session, post), { getDeviceId })
      .then(
        () => {
          logger.info('Model login succeeded', { provider });
          return post({ text: strings.loginConnected(chosen.label) });
        },
        () => {
          if (session.replaced) {
            logger.info('Model login abandoned', { provider });
            return;
          }
          logger.warn('Model login failed', {
            provider,
            timedOut: session.controller.signal.aborted,
          });
          return post({ text: strings.loginFailed(chosen.label) });
        },
      )
      .finally(() => {
        clearTimeout(timer);
        if (current === session) current = undefined;
      });
  };

  const logoutChoices = async (): Promise<TelegramReply> => {
    const stored = new Set(
      (await credentials.list())
        .filter(({ type }) => type === 'oauth')
        .map(({ providerId }) => providerId),
    );
    const connected = ACCOUNTS.filter(({ providerId }) => stored.has(providerId));
    return connected.length === 0
      ? { text: strings.noAccountConnected() }
      : {
          text: strings.chooseLogoutAccount(),
          buttons: connected.map(({ providerId, label }) => ({
            label,
            data: `${LOGOUT_DATA}${providerId}`,
          })),
        };
  };

  return {
    handleText: async (message) => {
      const asked = command(message.text);
      if (asked === 'login') {
        // R-27 AC4: one login at a time; a new `/login` abandons the running one.
        abandon(current);
        return {
          reply: {
            text: strings.chooseLoginAccount(),
            buttons: ACCOUNTS.map(({ providerId, label }) => ({
              label,
              data: `${LOGIN_DATA}${providerId}`,
            })),
          },
        };
      }
      if (asked === 'logout') return { reply: await logoutChoices() };
      const waiting = current?.waiting;
      if (current === undefined || waiting === undefined) return undefined;
      // R-27 AC3: the pasted code or address goes to the login, and leaves the chat.
      current.waiting = undefined;
      waiting.resolve(message.text);
      await deleteMessage(message.channelRef).catch(() => {
        logger.warn('Could not delete a pasted login message', { channelRef: message.channelRef });
      });
      return { reply: null };
    },
    handleButton: async (press) => {
      if (press.data.startsWith(LOGIN_DATA)) {
        const chosen = account(press.data.slice(LOGIN_DATA.length));
        if (chosen === undefined) return undefined;
        start(chosen);
        return { reply: null };
      }
      if (press.data.startsWith(LOGOUT_DATA)) {
        const chosen = account(press.data.slice(LOGOUT_DATA.length));
        if (chosen === undefined) return undefined;
        await models.logout(chosen.providerId);
        logger.info('Model logout', { provider: chosen.providerId });
        return { reply: { text: strings.loggedOut(chosen.label) } };
      }
      return undefined;
    },
    stop: () => {
      abandon(current);
      current = undefined;
    },
  };
};
