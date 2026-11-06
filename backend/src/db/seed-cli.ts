import fs from 'node:fs';
import { config } from '../config';
import { openWritableDb } from './database';
import { seedDemoData } from './seed';

/** `npm run seed` — wipes the dev database file and re-seeds the demo data. */
if (config.env === 'production') {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}

for (const suffix of ['', '-wal', '-shm']) {
  const f = config.databasePath + suffix;
  if (fs.existsSync(f)) fs.rmSync(f);
}
const db = openWritableDb(config.databasePath);
const result = seedDemoData(db, { password: config.seedPassword, bcryptRounds: config.bcryptRounds, aiDefaults: config.ai.defaults });
console.log(`Seeded ${result.clients.length} demo clients into ${config.databasePath} (today = ${result.today}).`);
console.log('Demo logins: <role>@aarav.demo and <role>@bharat.demo, roles:', 'management, sales, procurement, warehouse, finance, checker');
console.log('Password: the value of SEED_PASSWORD (see .env.example).');
db.close();
