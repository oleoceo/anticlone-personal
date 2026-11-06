import type { Pool } from 'pg';

type State = 'AVAILABLE' | 'NOT_INSTALLED' | 'DATABASE_ERROR';

// Schema availability is fixed at startup. Restart after applying optional migrations.
// Only a successful catalog lookup can establish NOT_INSTALLED; query failures cannot.
export class OptionalSchema {
  state: State;
  private retryAfter = 0;
  private failures = 0;

  constructor(private name: string, installed: boolean,
    private report: (line: string) => void = line => process.stderr.write(line + '\n'),
    private now: () => number = Date.now,
    private onState?: (name: string, failed: boolean, code?: string) => void) {
    this.state = installed ? 'AVAILABLE' : 'NOT_INSTALLED';
    if (!installed) this.report(`${name} NOT_INSTALLED; restart after migration`);
  }

  async run(operation: string, action: () => Promise<unknown>): Promise<boolean> {
    if (this.state === 'NOT_INSTALLED' || this.now() < this.retryAfter) return false;
    const failures = this.failures;
    try {
      await action();
      if (failures !== this.failures) return false;
      if (this.state === 'DATABASE_ERROR') this.report(`${this.name} AVAILABLE; database operation recovered`);
      this.onState?.(`${this.name}_${operation}`,false);
      this.state = 'AVAILABLE';
      return true;
    } catch (error) {
      this.failures++;

      this.state = 'DATABASE_ERROR';
      this.retryAfter = this.now() + 60_000;
      // Never log SQL, messages, connection strings, hosts or browser data.
      const code = (error as {code?: unknown} | null)?.code;
      const safeCode = typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN';
      this.onState?.(`${this.name}_${operation}`,true,safeCode);
      this.report(`${this.name} ${operation} DATABASE_ERROR code=${safeCode}; retry after 60000ms`);
      return false;
    }
  }
}

export async function optionalSchemas(pool: Pick<Pool, 'query'>, onState?: (name: string, failed: boolean, code?: string) => void) {
  // to_regclass respects the same search_path as the operational queries, without touching missing tables.
  const result = await pool.query(`SELECT
    to_regclass('health_settings_history') IS NOT NULL AND to_regclass('health_operational_keys') IS NOT NULL AND to_regclass('health_episodes') IS NOT NULL AND to_regclass('health_delivery') IS NOT NULL AND to_regclass('health_history') IS NOT NULL AND to_regclass('installation_health_settings') IS NOT NULL AND to_regclass('installation_last_signal') IS NOT NULL AS health,
    to_regclass('installations') IS NOT NULL AND to_regclass('installation_signals') IS NOT NULL AS installation,
    to_regclass('degradation_events') IS NOT NULL AND to_regclass('degradation_audit') IS NOT NULL AS degradation,
    EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('degradation_audit') AND attname='evidence' AND NOT attisdropped)
    AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('degradation_events') AND attname='origin' AND NOT attisdropped)
    AND to_regclass('degradation_collection_gaps') IS NOT NULL AS canary_degradation`);
  return {
    health: new OptionalSchema('health', result.rows[0].health === true, undefined, undefined, onState),
    installation: new OptionalSchema('installation', result.rows[0].installation === true, undefined, undefined, onState),
    degradation: new OptionalSchema('degradation', result.rows[0].degradation === true, undefined, undefined, onState),
    canaryDegradation: new OptionalSchema('canary_temporal', result.rows[0].canary_degradation === true, undefined, undefined, onState)
  };
}
