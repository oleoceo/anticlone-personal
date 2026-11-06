import type { Pool, PoolClient } from 'pg';
import { makeMailer } from './alerts.js';
import { budgetMayBeAvailable, lockBudget, recordBudget } from './notification-budget.js';

// Claims are unauthenticated; inactivity describes only a lack of observed claims.
export async function configureHealth(db: Pool, project: string, enabled: boolean, seconds: number, operationalEnabled: boolean) {
  if (typeof enabled !== 'boolean' || typeof operationalEnabled !== 'boolean' || !Number.isInteger(seconds) || seconds < 60 || seconds > 2592000) throw new TypeError('invalid health configuration');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), 45)',[project]);
    const result = await client.query(`INSERT INTO installation_health_settings(project_id,enabled,inactivity_seconds,operational_enabled)
      SELECT project_id,$2,$3,$4 FROM installations WHERE project_id=$1
      ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled,inactivity_seconds=excluded.inactivity_seconds,operational_enabled=excluded.operational_enabled RETURNING *`, [project,enabled,seconds,operationalEnabled]);
    if (!result.rowCount) throw new TypeError('unknown installation');
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function transition(client: PoolClient, project: string, kind: 'INACTIVE'|'OPERATIONAL', source: string, nature: string, active: boolean, observedAt?: Date) {
  if (active) {
    const opened = await client.query(`INSERT INTO health_episodes(project_id,kind,source,nature,opened_at) VALUES($1,$2,$3,$4,coalesce($5,clock_timestamp()))
      ON CONFLICT(project_id,kind,source) WHERE recovered_at IS NULL AND invalidated_at IS NULL DO NOTHING RETURNING id`, [project,kind,source,nature,observedAt ?? null]);
    if (opened.rowCount) {
      await client.query('INSERT INTO health_delivery(episode_id) VALUES($1)', [opened.rows[0].id]);
      await client.query("INSERT INTO health_history(episode_id,event) VALUES($1,'OPENED')", [opened.rows[0].id]);
    }
  } else {
    const closed = await client.query(`UPDATE health_episodes SET recovered_at=coalesce($4,clock_timestamp())
      WHERE project_id=$1 AND kind=$2 AND source=$3 AND recovered_at IS NULL AND invalidated_at IS NULL RETURNING id`, [project,kind,source,observedAt ?? null]);
    for (const row of closed.rows) {
      await client.query("INSERT INTO health_history(episode_id,event) VALUES($1,'RECOVERED')", [row.id]);
      if (kind === 'INACTIVE') await client.query('UPDATE health_delivery SET expired_at=clock_timestamp() WHERE episode_id=$1 AND sent_at IS NULL AND expired_at IS NULL', [row.id]);
    }
  }
}

// A canary request with a matching, unauthenticated Referer is an activity
// claim only. It does not establish installation integrity or visitor identity.
export async function recordInstallationActivity(db: Pool, project: string, origin: string) {
  await db.query(`UPDATE installation_last_signal l SET last_activity_at=clock_timestamp()
    FROM installations i JOIN projects p ON p.id=i.project_id
    WHERE l.project_id=$1 AND i.project_id=l.project_id AND i.enabled AND i.origin=$2 AND p.origin=i.origin`,[project,origin]);
}

// A known collection gap invalidates any open inactivity diagnosis, not a recovery.
export async function invalidateInactivity(db: Pool, project: string, invalidateEpisodes = true) {
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), 45)',[project]);
    await client.query('UPDATE installation_last_signal SET first_observed_at=NULL WHERE project_id=$1',[project]);
    const affected=await client.query(`UPDATE health_episodes SET invalidated_at=clock_timestamp() WHERE $2 AND project_id=$1
      AND kind='INACTIVE' AND recovered_at IS NULL AND invalidated_at IS NULL RETURNING id`,[project,invalidateEpisodes]);
    for (const row of affected.rows) {
      await client.query('UPDATE health_delivery SET expired_at=clock_timestamp() WHERE episode_id=$1 AND sent_at IS NULL AND expired_at IS NULL',[row.id]);
      await client.query("INSERT INTO health_history(episode_id,event) VALUES($1,'INVALIDATED')",[row.id]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function evaluateInactivity(db: Pool, project: string, isCurrent: () => boolean = () => true) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), 45)',[project]);
    const result = await client.query(`SELECT i.enabled AND i.origin=p.origin AND coalesce(s.enabled,false) AS eligible,
      l.last_observed_at, l.last_activity_at >= clock_timestamp()-interval '5 minutes' AND l.last_activity_at > l.last_observed_at AS recent_activity, EXISTS (SELECT 1 FROM health_episodes e WHERE e.project_id=i.project_id AND e.kind='INACTIVE' AND e.source='installation' AND e.recovered_at IS NULL AND e.invalidated_at IS NULL AND l.last_observed_at > e.opened_at) AS resumed, l.first_observed_at <= l.last_observed_at-interval '1 minute' AS baseline, l.last_observed_at < clock_timestamp()-make_interval(secs=>s.inactivity_seconds) AS inactive
      FROM installations i JOIN projects p ON p.id=i.project_id
      LEFT JOIN installation_health_settings s ON s.project_id=i.project_id
      LEFT JOIN installation_last_signal l ON l.project_id=i.project_id WHERE i.project_id=$1 FOR UPDATE OF i`, [project]);
    const row = result.rows[0];
    // Invalid configuration or no evidence is unknown, never recovery or an incident.
    if (row?.eligible && row.resumed) await transition(client,project,'INACTIVE','installation','NO_RECENT_SIGNAL',false);
    if (row?.eligible && row.last_observed_at && row.baseline && row.inactive && row.recent_activity) await transition(client,project,'INACTIVE','installation','NO_RECENT_SIGNAL',true);
    if (!isCurrent()) { await client.query('ROLLBACK'); return; }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function recordOperationalState(db: Pool, project: string, source: string, nature: string, active: boolean, observedAt?: Date) {
  if (!/^[a-z_]{1,40}$/.test(source) || !/^[A-Z0-9_]{1,40}$/.test(nature)) throw new TypeError('invalid operational state');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), 45)',[project]);
    await transition(client,project,'OPERATIONAL',source,nature,active,observedAt);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

// Keys map retries to the existing episode, including one opened before restart.
export async function reconcileOperationalEpisode(db: Pool, project: string, source: string, key: string, openedAt: Date, recoveredAt?: Date, safeCode?: string) {
  if (!/^[a-z_]{1,40}$/.test(source) || (safeCode !== undefined && !/^[A-Z0-9_]{1,32}$/.test(safeCode))) throw new TypeError('invalid operational source');
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), 45)',[project]);
    let result=await client.query('SELECT episode_id AS id FROM health_operational_keys WHERE observation_key=$1',[key]);
    if (!result.rowCount) {
      result=await client.query("SELECT id FROM health_episodes WHERE project_id=$1 AND kind='OPERATIONAL' AND source=$2 AND recovered_at IS NULL",[project,source]);
      if (!result.rowCount) {
        result=await client.query(`INSERT INTO health_episodes(observation_key,project_id,kind,source,nature,opened_at,safe_code)
          VALUES($1,$2,'OPERATIONAL',$3,'OPERATION_ERROR_UNKNOWN',$4,$5) RETURNING id`,[key,project,source,openedAt,safeCode ?? 'UNKNOWN']);
        await client.query('INSERT INTO health_delivery(episode_id) VALUES($1)',[result.rows[0].id]);
        await client.query("INSERT INTO health_history(episode_id,event) VALUES($1,'OPENED')",[result.rows[0].id]);
      }
      await client.query('INSERT INTO health_operational_keys(observation_key,episode_id) VALUES($1,$2)',[key,result.rows[0].id]);
    }
    if (recoveredAt) {
      const closed=await client.query('UPDATE health_episodes SET recovered_at=$2 WHERE id=$1 AND recovered_at IS NULL RETURNING id',[result.rows[0].id,recoveredAt]);
      if (closed.rowCount) await client.query("INSERT INTO health_history(episode_id,event) VALUES($1,'RECOVERED')",[closed.rows[0].id]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

// Success after restart is the first evidence that an old open source recovered.
export async function recoverOperationalSource(db: Pool, project: string, source: string, observedAt: Date) {
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), 45)',[project]);
    const closed=await client.query(`UPDATE health_episodes SET recovered_at=$3 WHERE project_id=$1 AND kind='OPERATIONAL'
      AND source=$2 AND recovered_at IS NULL AND opened_at<=$3 RETURNING id`,[project,source,observedAt]);
    for (const row of closed.rows) await client.query("INSERT INTO health_history(episode_id,event) VALUES($1,'RECOVERED')",[row.id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function deliverHealth(db: Pool, project: string, port: number, isCurrent: () => boolean = () => true) {
  const client = await db.connect();
  let locked = false;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(hashtext($1), 45) AS locked', [project])).rows[0].locked;
    if (!locked || !budgetMayBeAvailable(db)) return;
    await client.query('BEGIN');
    let item: {episode_id:string;kind:string} | undefined;
    try {
      if (await lockBudget(client,db) && isCurrent()) {
        const result = await client.query(`SELECT d.episode_id,e.kind FROM health_delivery d JOIN health_episodes e ON e.id=d.episode_id
          JOIN installation_health_settings s ON s.project_id=e.project_id
          JOIN installations i ON i.project_id=e.project_id JOIN projects p ON p.id=i.project_id
          WHERE ((e.kind='INACTIVE' AND s.enabled AND i.enabled AND i.origin=p.origin) OR (e.kind='OPERATIONAL' AND s.operational_enabled)) AND e.project_id=$1 AND (e.kind='OPERATIONAL' OR (e.recovered_at IS NULL AND e.invalidated_at IS NULL AND NOT EXISTS (SELECT 1 FROM installation_last_signal l WHERE l.project_id=e.project_id AND l.last_observed_at>e.opened_at))) AND d.sent_at IS NULL AND d.expired_at IS NULL
          AND d.attempts<3 AND d.next_attempt<=clock_timestamp() AND e.opened_at>clock_timestamp()-interval '24 hours'
          ORDER BY d.episode_id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`, [project]);
        item = result.rows[0];
        if (item) {
          await client.query("UPDATE health_delivery SET attempts=attempts+1,next_attempt=clock_timestamp()+make_interval(secs=>60 * (1 << attempts)) WHERE episode_id=$1", [item.episode_id]);
          await client.query("INSERT INTO health_history(episode_id,event) VALUES($1,'ATTEMPT')", [item.episode_id]);
          await recordBudget(client);
        }
      }
      if (!isCurrent()) { await client.query('ROLLBACK'); return; }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    if (!item) return;
    if (!isCurrent()) {
      await client.query('BEGIN');
      try {
        await client.query("UPDATE health_delivery SET attempts=attempts-1,next_attempt=clock_timestamp() WHERE episode_id=$1",[item.episode_id]);
        await client.query("INSERT INTO health_history(episode_id,event) VALUES($1,'DEFERRED')",[item.episode_id]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      return;
    }
    try {
      await makeMailer(port).sendMail({from:'anticlone@example.test',to:'owner@example.test',subject:'AntiClone health observation',text:`Health episode ${item.episode_id}: ${item.kind}. This observation is not proof of tampering.`,messageId:`<anticlone-health-${item.episode_id}@example.test>`});
      await client.query('BEGIN');
      await client.query('UPDATE health_delivery SET sent_at=clock_timestamp() WHERE episode_id=$1', [item.episode_id]);
      await client.query("INSERT INTO health_history(episode_id,event) VALUES($1,'SENT')", [item.episode_id]);
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK');
      await client.query("INSERT INTO health_history(episode_id,event) VALUES($1,'FAILED_UNCERTAIN')", [item.episode_id]);
    }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1), 45)', [project]);
    client.release();
  }
}

export async function maintainHealthHistory(db: Pool, project: string) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), 45)',[project]);
    const expired = await client.query(`UPDATE health_delivery d SET expired_at=clock_timestamp()
      FROM health_episodes e WHERE e.id=d.episode_id AND e.project_id=$1 AND d.sent_at IS NULL AND d.expired_at IS NULL
      AND (e.opened_at<=clock_timestamp()-interval '24 hours' OR d.attempts>=3) RETURNING d.episode_id`,[project]);
    for (const row of expired.rows) await client.query("INSERT INTO health_history(episode_id,event) VALUES($1,'EXPIRED')",[row.episode_id]);
    await client.query("DELETE FROM health_operational_keys k USING health_episodes e WHERE k.episode_id=e.id AND e.project_id=$1 AND k.created_at<clock_timestamp()-interval '30 days'",[project]);
    await client.query("DELETE FROM health_episodes WHERE project_id=$1 AND coalesce(recovered_at,invalidated_at) < clock_timestamp()-interval '30 days'",[project]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
