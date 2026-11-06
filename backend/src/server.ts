import { assertProductionSafe, config } from './config';
import { createApp } from './app';
import { openReadOnlyDb, openWritableDb } from './db/database';
import { seedDemoData } from './db/seed';

function main() {
  assertProductionSafe(config);

  const db = openWritableDb(config.databasePath);
  const empty = (db.prepare('SELECT COUNT(*) AS n FROM clients').get() as { n: number }).n === 0;
  if (empty) {
    if (config.demoMode) {
      const r = seedDemoData(db, { password: config.seedPassword, bcryptRounds: config.bcryptRounds, aiDefaults: config.ai.defaults });
      console.info(`[db] Empty database: seeded demo data for ${r.clients.length} clients.`);
    } else {
      console.warn('[db] The database has no clients. Create clients and users before use.');
    }
  }
  // The AI data tools get a separate READ-ONLY connection.
  const roDb = openReadOnlyDb(config.databasePath);

  const { app, assistant } = createApp({ config, db, roDb });

  // Never print the API key; only whether one is configured.
  const aiState = !config.ai.enabled
    ? 'disabled (AI_ENABLED=false)'
    : config.ai.provider === 'openai'
      ? assistant.provider.isConfigured()
        ? `OpenAI (fast: ${config.ai.modelFast}, strong: ${config.ai.modelStrong})`
        : 'OpenAI selected but OPENAI_API_KEY is missing — AI requests will return a clear error; the rest of the platform is unaffected'
      : 'local rules engine (no external provider)';
  console.info(`[ai] provider: ${aiState}`);
  if (config.env === 'production' && config.ai.provider === 'local') {
    console.warn('[ai] WARNING: AI_PROVIDER=local in production. The PDF specifies a hosted AI API; the offline engine only restates data and is meant for development and as a fallback.');
  }
  if (config.jwtSecret.startsWith('dev-only')) console.warn('[auth] WARNING: using the development JWT secret. Set JWT_SECRET before any shared deployment.');

  const server = app.listen(config.port, () => {
    console.info(`[http] WhizUnik API listening on http://localhost:${config.port} (${config.env})`);
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      roDb.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
