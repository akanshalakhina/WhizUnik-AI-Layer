import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

export type AiProviderName = 'openai' | 'local';

export interface ModelPrice {
  inputInrPerM: number;
  outputInrPerM: number;
}

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  corsOrigins: string[];
  jwtSecret: string;
  jwtExpiresIn: string;
  databasePath: string;
  demoMode: boolean;
  seedPassword: string;
  bcryptRounds: number;
  rateLimitEnabled: boolean;
  ai: {
    enabled: boolean;
    provider: AiProviderName;
    openaiApiKey: string;
    openaiBaseUrl: string;
    modelFast: string;
    modelStrong: string;
    timeoutMs: number;
    maxQuestionChars: number;
    maxRecordsPerTool: number;
    maxOutputTokens: number;
    pricing: Record<string, ModelPrice>;
    summaryCacheMinutes: number;
    defaults: {
      monthlyCostLimitInr: number;
      monthlyRequestLimit: number;
      dailyUserLimit: number;
    };
  };
}

type Env = Record<string, string | undefined>;

function num(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number (got "${raw}")`);
  return n;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/**
 * Build the configuration from an environment map. Tests pass their own map so
 * nothing depends on the developer's real `.env`.
 */
export function loadConfig(env: Env = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV as AppConfig['env']) || 'development';
  const isProd = nodeEnv === 'production';

  const modelFast = env.AI_MODEL_FAST || 'gpt-4o-mini';
  const modelStrong = env.AI_MODEL_STRONG || 'gpt-4o';

  const pricing: Record<string, ModelPrice> = {
    'local-rules-v1': { inputInrPerM: 0, outputInrPerM: 0 },
    [modelFast]: {
      inputInrPerM: num(env, 'AI_PRICE_FAST_INPUT_INR_PER_M', 13),
      outputInrPerM: num(env, 'AI_PRICE_FAST_OUTPUT_INR_PER_M', 53),
    },
    [modelStrong]: {
      inputInrPerM: num(env, 'AI_PRICE_STRONG_INPUT_INR_PER_M', 220),
      outputInrPerM: num(env, 'AI_PRICE_STRONG_OUTPUT_INR_PER_M', 880),
    },
  };

  // PDF section 3: the AI is a hosted API. The built-in offline engine is only the development default.
  const provider = (env.AI_PROVIDER || (isProd ? 'openai' : 'local')).toLowerCase();
  if (provider !== 'openai' && provider !== 'local') {
    throw new Error(`AI_PROVIDER must be "openai" or "local" (got "${provider}")`);
  }

  return {
    env: nodeEnv,
    port: num(env, 'PORT', 4000),
    corsOrigins: (env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
    jwtSecret: env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
    jwtExpiresIn: env.JWT_EXPIRES_IN || '8h',
    databasePath: path.resolve(env.DATABASE_PATH || './data/whizunik.db'),
    demoMode: bool(env, 'DEMO_MODE', false), // demo data / known passwords only when explicitly requested
    seedPassword: env.SEED_PASSWORD || 'Demo@12345',
    bcryptRounds: num(env, 'BCRYPT_ROUNDS', nodeEnv === 'test' ? 4 : 10),
    rateLimitEnabled: bool(env, 'RATE_LIMIT_ENABLED', nodeEnv !== 'test'),
    ai: {
      enabled: bool(env, 'AI_ENABLED', true),
      provider,
      openaiApiKey: env.OPENAI_API_KEY || '',
      openaiBaseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      modelFast,
      modelStrong,
      timeoutMs: num(env, 'AI_TIMEOUT_MS', 20000),
      maxQuestionChars: num(env, 'AI_MAX_QUESTION_CHARS', 500),
      maxRecordsPerTool: num(env, 'AI_MAX_RECORDS_PER_TOOL', 25),
      maxOutputTokens: num(env, 'AI_MAX_OUTPUT_TOKENS', 1500),
      pricing,
      summaryCacheMinutes: num(env, 'AI_SUMMARY_CACHE_MINUTES', 240),
      defaults: {
        monthlyCostLimitInr: num(env, 'AI_DEFAULT_MONTHLY_COST_LIMIT_INR', 2000),
        monthlyRequestLimit: num(env, 'AI_DEFAULT_MONTHLY_REQUEST_LIMIT', 1500),
        dailyUserLimit: num(env, 'AI_DEFAULT_DAILY_USER_LIMIT', 40),
      },
    },
  };
}

/** Throws on unsafe production settings. Called once at start-up. */
export function assertProductionSafe(cfg: AppConfig): void {
  if (cfg.env !== 'production') return;
  const problems: string[] = [];
  if (cfg.jwtSecret.length < 32 || cfg.jwtSecret.startsWith('dev-only')) {
    problems.push('JWT_SECRET must be a random string of at least 32 characters');
  }
  if (cfg.demoMode) problems.push('DEMO_MODE must be false');
  if (problems.length) throw new Error(`Unsafe production configuration: ${problems.join('; ')}`);
}

export const config: AppConfig = loadConfig();
