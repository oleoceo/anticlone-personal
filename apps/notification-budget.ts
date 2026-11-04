import type { Pool, PoolClient } from 'pg';

// All reservation paths lock this row before locking individual deliveries.
const blockedUntil = new WeakMap<Pool, number>();
export function budgetMayBeAvailable(pool: Pool): boolean {
  return Date.now() >= (blockedUntil.get(pool) ?? 0);
}
export async function lockBudget(client: PoolClient, pool: Pool): Promise<boolean> {
  const control = await client.query('SELECT singleton FROM notification_budget_lock WHERE singleton=true FOR UPDATE');
  if (control.rowCount !== 1) throw new Error('Notification budget control is missing');
  const result = await client.query(`SELECT count(*)::int AS count,
    EXTRACT(EPOCH FROM (min(reserved_at) + interval '60 minutes' - clock_timestamp())) * 1000 AS wait_ms
    FROM notification_attempt_budget WHERE reserved_at > clock_timestamp() - interval '60 minutes'`);
  if (result.rows[0].count >= 10) {
    blockedUntil.set(pool, Date.now() + Math.max(1000, Number(result.rows[0].wait_ms) + 100));
    return false;
  }
  return true;
}
export async function recordBudget(client: PoolClient): Promise<void> {
  await client.query("DELETE FROM notification_attempt_budget WHERE reserved_at <= clock_timestamp() - interval '60 minutes'");
  await client.query('INSERT INTO notification_attempt_budget DEFAULT VALUES');
}
