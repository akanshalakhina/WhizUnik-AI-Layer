import { config } from '../src/config';
import { createProvider } from '../src/services/ai-provider';

/**
 * `npm run ai:test-connection` — provider connection test (spec Task 1).
 * Prints whether the configured provider is reachable and the key is valid.
 * The API key itself is never printed.
 */
(async () => {
  const provider = createProvider(config);
  const result = await provider.testConnection();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
})();
