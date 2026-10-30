// Daemon entry point. M0 only proves the process starts and stops cleanly;
// matter cycles, the scheduler and the front doors arrive in later milestones.
console.info('anomander daemon started');

const keepAlive = setInterval(() => {}, 2 ** 30);

const stop = (signal: NodeJS.Signals): void => {
  console.info(`anomander daemon stopping (${signal})`);
  clearInterval(keepAlive);
};

process.once('SIGTERM', stop);
process.once('SIGINT', stop);
