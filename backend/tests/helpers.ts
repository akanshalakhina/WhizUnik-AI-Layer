import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import type { AppConfig } from '../src/config';
import { openReadOnlyDb, openWritableDb } from '../src/db/database';
import { seedDemoData } from '../src/db/seed';
import type { AiProvider } from '../src/services/ai-provider.types';
import type { Db, Role } from '../src/types';

/** 12:00 IST on 2026-11-05 — all seed dates are relative to this instant. */
export const NOW = new Date('2026-11-05T06:30:00.000Z');
export const PASSWORD = 'Test@12345';

export const silentLogger = { error: () => {}, warn: () => {}, info: () => {} };

export interface TestEnv {
  app: ReturnType<typeof createApp>['app'];
  assistant: ReturnType<typeof createApp>['assistant'];
  db: Db;
  roDb: Db;
  config: AppConfig;
  dir: string;
  login(email: string): Promise<string>;
  as(role: Role, client?: 'aarav' | 'bharat'): Promise<string>;
  cleanup(): void;
}

export async function makeEnv(opts: { env?: Record<string, string>; provider?: AiProvider; now?: Date; logger?: typeof silentLogger } = {}): Promise<TestEnv> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whizunik-test-'));
  const file = path.join(dir, 'test.db');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: file,
    JWT_SECRET: 'test-secret-test-secret-test-secret-123456',
    AI_PROVIDER: 'local',
    ...opts.env,
  });
  const db = openWritableDb(file);
  const now = opts.now ?? NOW;
  seedDemoData(db, { now, password: PASSWORD, bcryptRounds: 4 });
  const roDb = openReadOnlyDb(file);
  const { app, assistant } = createApp({ config, db, roDb, provider: opts.provider, now: () => now, logger: opts.logger ?? silentLogger });

  const login = async (email: string) => {
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.token as string;
  };
  return {
    app,
    assistant,
    db,
    roDb,
    config,
    dir,
    login,
    as: (role, client = 'aarav') => login(`${role}@${client}.demo`),
    cleanup() {
      try {
        roDb.close();
        db.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function ask(env: TestEnv, token: string, question: unknown) {
  return request(env.app).post('/api/ai/ask').set('Authorization', `Bearer ${token}`).send({ question });
}
