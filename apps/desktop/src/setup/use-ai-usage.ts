// DK-21: today's AI calls and the daily limit (R-12), asked of the daemon over a connection of
// its own each time it opens, for the setup screen. `null` until they came, or when they did not.
import { useEffect, useState } from 'react';
import { createChatClient } from '../chat/chat-client.ts';
import type { LocalChannel } from '../shell.ts';

export interface AiUsage {
  calls: number;
  limit: number;
}

export const useAiUsage = (channel: LocalChannel | null): AiUsage | null => {
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const url = channel?.url ?? null;
  const token = channel?.token ?? null;

  useEffect(() => {
    if (url === null || token === null) {
      setUsage(null);
      return;
    }
    let gone = false;
    const client = createChatClient({
      onConnection: (state) => {
        if (state !== 'open') return;
        void client.requestAiUsage().then((read) => {
          if (!gone) setUsage(read);
        });
      },
      // It sends nothing but its own request, which never settles as an outcome.
      onOutcome: () => {},
    });
    client.setChannel({ url, token });
    return () => {
      gone = true;
      client.dispose();
    };
  }, [url, token]);

  return usage;
};
