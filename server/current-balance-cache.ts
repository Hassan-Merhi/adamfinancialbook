import { query } from './db.js';

export type CachedAggregatedEffect = {
  type: string;
  target_id: string | null;
  from_business: string | null;
  to_business: string | null;
  delta: number;
};

type CachedSnapshot = {
  auditVersion: string;
  rows: CachedAggregatedEffect[];
};

let cached: CachedSnapshot | null = null;
let inFlight: Promise<CachedSnapshot> | null = null;

async function auditVersion(): Promise<string> {
  const rows = await query<{ version: string }>(
    'SELECT COALESCE(MAX(id), 0)::text AS version FROM audit',
  );
  return rows[0]?.version ?? '0';
}

async function rebuild(expectedVersion: string): Promise<CachedSnapshot> {
  const rows = await query<CachedAggregatedEffect>(
    `SELECT type, target_id, from_business, to_business,
            SUM(delta)::double precision AS delta
       FROM effects
      WHERE active = true
      GROUP BY type, target_id, from_business, to_business`,
  );
  const after = await auditVersion();
  // Financial effect writes and their required audit record commit together.
  // If the version changed while we were aggregating, discard the raced result
  // and calculate once more from the new canonical state.
  if (after !== expectedVersion) return rebuild(after);
  return { auditVersion: after, rows };
}

export async function getCurrentBalanceEffects(): Promise<CachedAggregatedEffect[]> {
  const version = await auditVersion();
  if (cached?.auditVersion === version) return cached.rows;
  if (inFlight) {
    const snapshot = await inFlight;
    if (snapshot.auditVersion === version) return snapshot.rows;
  }

  const pending = rebuild(version);
  inFlight = pending;
  try {
    const snapshot = await pending;
    cached = snapshot;
    return snapshot.rows;
  } finally {
    if (inFlight === pending) inFlight = null;
  }
}

export async function warmCurrentBalanceEffects(): Promise<void> {
  await getCurrentBalanceEffects();
}

export function clearCurrentBalanceEffectsForTests(): void {
  cached = null;
  inFlight = null;
}
