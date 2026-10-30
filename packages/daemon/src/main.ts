// Daemon entry point. M1 opens the SQLite store and applies the migrations; matter cycles,
// the scheduler and the front doors arrive in later milestones.
import { applyMigrations, openDatabase } from './store/database.ts';

console.info('anomander daemon started');

const dbPath = process.env.ANOMANDER_DB_PATH ?? './data/anomander.db';

const openStore = () => {
  try {
    const db = openDatabase(dbPath);
    const applied = applyMigrations(db);
    console.info(`anomander store ready at ${dbPath} (${applied} migrations applied)`);
    return db;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`anomander daemon failed to open the store at ${dbPath}: ${reason}`);
    process.exit(1);
  }
};

const db = openStore();

const keepAlive = setInterval(() => {}, 2 ** 30);

const stop = (signal: NodeJS.Signals): void => {
  console.info(`anomander daemon stopping (${signal})`);
  clearInterval(keepAlive);
  db.close();
};

process.once('SIGTERM', stop);
process.once('SIGINT', stop);
