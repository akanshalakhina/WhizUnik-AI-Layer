import { config } from '../src/config';
import { openWritableDb } from '../src/db/database';
import { getClientAiSettings, updateClientAiSettings } from '../src/services/ai-usage.service';
import type { SettingsPatch } from '../src/services/ai-usage.service';
import { ROLES } from '../src/types';
import type { Role } from '../src/types';

/**
 * Operator command for PDF Task 15 ("configure monthly limit, permitted roles, enable the feature flag").
 * These settings control cost and access, so they are changed here (by whoever deploys / supports WhizUnik) and NOT
 * through the client-facing API: a client must not be able to raise its own limits or switch itself on.
 *
 *   npm run ai:configure -- --list
 *   npm run ai:configure -- --client 1 --enable --roles management,sales,finance --monthly-cost 5000 \
 *                           --monthly-requests 3000 --daily-user 40
 *   npm run ai:configure -- --client 1 --disable
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function num(name: string, min: number, max: number, integer = false): number | undefined {
  const raw = arg(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    console.error(`--${name} must be ${integer ? 'a whole number' : 'a number'} between ${min} and ${max}`);
    process.exit(1);
  }
  return n;
}

const db = openWritableDb(config.databasePath);

if (flag('list') || !arg('client')) {
  const rows = db.prepare('SELECT id FROM clients ORDER BY id').all() as { id: number }[];
  for (const { id } of rows) {
    const s = getClientAiSettings(db, id)!;
    console.log(
      `client ${s.clientId} · ${s.name} · AI ${s.aiEnabled ? 'ENABLED' : 'disabled'} · roles: ${s.permittedRoles.join(',') || '—'} · monthly ₹${s.monthlyCostLimitInr} / ${s.monthlyRequestLimit} requests · daily ${s.dailyUserLimit}/user`,
    );
  }
  if (!rows.length) console.log('No clients in the database.');
  if (!flag('list')) console.log('\nUsage: npm run ai:configure -- --client <id> [--enable|--disable] [--roles a,b] [--monthly-cost N] [--monthly-requests N] [--daily-user N]');
  db.close();
  process.exit(0);
}

const clientId = Number(arg('client'));
if (!getClientAiSettings(db, clientId)) {
  console.error(`No client with id ${arg('client')}`);
  process.exit(1);
}

const patch: SettingsPatch = {};
if (flag('enable') && flag('disable')) {
  console.error('Use either --enable or --disable, not both');
  process.exit(1);
}
if (flag('enable')) patch.aiEnabled = true;
if (flag('disable')) patch.aiEnabled = false;
const roles = arg('roles');
if (roles !== undefined) {
  const list = roles.split(',').map((r) => r.trim()).filter(Boolean);
  const bad = list.filter((r) => !(ROLES as readonly string[]).includes(r));
  if (bad.length) {
    console.error(`Unknown role(s): ${bad.join(', ')}. Valid roles: ${ROLES.join(', ')}`);
    process.exit(1);
  }
  patch.permittedRoles = [...new Set<Role>(['management', ...(list as Role[])])]; // management can always use AI
}
patch.monthlyCostLimitInr = num('monthly-cost', 0, 10_000_000);
patch.monthlyRequestLimit = num('monthly-requests', 0, 1_000_000, true);
patch.dailyUserLimit = num('daily-user', 0, 10_000, true);
for (const k of Object.keys(patch) as (keyof SettingsPatch)[]) if (patch[k] === undefined) delete patch[k];

if (Object.keys(patch).length === 0) {
  console.error('Nothing to change. Pass at least one of --enable/--disable, --roles, --monthly-cost, --monthly-requests, --daily-user');
  process.exit(1);
}

const s = updateClientAiSettings(db, clientId, patch);
console.log(
  `Updated client ${s.clientId} · ${s.name}: AI ${s.aiEnabled ? 'ENABLED' : 'disabled'} · roles ${s.permittedRoles.join(',')} · monthly ₹${s.monthlyCostLimitInr} / ${s.monthlyRequestLimit} requests · daily ${s.dailyUserLimit}/user`,
);
db.close();
