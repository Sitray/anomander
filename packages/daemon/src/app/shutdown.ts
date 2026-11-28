// How a stop waits for what still runs, shared by the daemon (`app.ts`) and the setup guide
// (`setup-guide-mode.ts`, B86), so both give up after the same time.

/** T14: how long a shutdown waits for the turns that run before it closes the store. */
export const SHUTDOWN_DEADLINE_MS = 5_000;

/** Whether `work` settled within `ms`. */
export const settlesWithin = async (work: Promise<unknown>, ms: number): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
};
