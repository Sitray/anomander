// DK-23 AC4: "Probar" asks the daemon to call the saved model once, on a connection of its own to
// the local channel, opened for that one request and closed after it. Only the outcome's code word
// is read from the answer: nothing else the daemon sent reaches the window. The token lives only
// in this call, as in the chat client (DK-3 AC3).
import { LOCAL_CHANNEL_PROTOCOL, PROBE_OUTCOMES, type ProbeOutcome } from '@anomander/protocol';
import type { ChatSocket } from '../chat/chat-client.ts';
import type { LocalChannel } from '../shell.ts';

/** `lost`: the connection closed before the answer, or never opened. */
export type ProbeResult = ProbeOutcome | 'lost';

const REQUEST_ID = 'probe';

const outcomeOf = (data: unknown): ProbeOutcome | undefined => {
  if (typeof data !== 'string') return undefined;
  try {
    const event = JSON.parse(data) as { type?: unknown; inReplyTo?: unknown; outcome?: unknown };
    if (event?.inReplyTo !== REQUEST_ID) return undefined;
    // Anything other than a known outcome, such as a failure reply, is a probe that failed.
    return event.type === 'probe' && PROBE_OUTCOMES.some((known) => known === event.outcome)
      ? (event.outcome as ProbeOutcome)
      : 'failed';
  } catch {
    return undefined;
  }
};

export const probeModel = (
  channel: LocalChannel,
  createSocket: (url: string, protocols: string[]) => ChatSocket = (url, protocols) =>
    new WebSocket(url, protocols),
): Promise<ProbeResult> =>
  new Promise((resolve) => {
    const socket = createSocket(channel.url, [LOCAL_CHANNEL_PROTOCOL, channel.token]);
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
      socket.close();
    };
    socket.onopen = () => socket.send(JSON.stringify({ type: 'probe_model', id: REQUEST_ID }));
    socket.onmessage = (message) => {
      const outcome = outcomeOf(message.data);
      if (outcome !== undefined) finish(outcome);
    };
    socket.onclose = () => finish('lost');
    socket.onerror = () => finish('lost');
  });
