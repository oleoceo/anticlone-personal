import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

test('protected page migration preserves legacy identity and enforces URL ownership', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root = new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema = `pages_${randomUUID().replaceAll('-', '')}`;
  await root.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({connectionString:process.env.TEST_DATABASE_URL, options:`-c search_path=${schema}`});
  try {
    for (const file of ['003_projects', '025_installation_signals']) await db.query(await readFile(`infra/${file}.sql`, 'utf8'));
    const installation = randomUUID();
    await db.query("INSERT INTO projects VALUES ('health','Health','https://example.test'),('finance','Finance','https://other.test')");
    await db.query("INSERT INTO installations(project_id,id,origin) VALUES ('health',$1,'https://example.test')", [installation]);
    const migration = await readFile('infra/037_protected_pages.sql', 'utf8');
    await db.query(migration); await db.query(migration);
    const rows = await db.query('SELECT project_id,installation_id,enabled FROM protected_pages ORDER BY project_id');
    assert.equal(rows.rowCount, 2);
    assert.equal(rows.rows[1].installation_id, installation);
    assert.equal(rows.rows[0].enabled, false);
    await db.query("UPDATE projects SET origin='https://example.test' WHERE id='finance'");
    const page = randomUUID();
    await db.query("INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES ($1,'finance',$2,'Finance')", [page,randomUUID()]);
    await db.query("INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES ($1,'https://example.test','/financas')", [page]);
    await assert.rejects(db.query("INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES ($1,'https://example.test','/')", [page]), {code:'23505'});
    await assert.rejects(db.query("INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES ($1,'missing',$2,'Invalid')", [randomUUID(),randomUUID()]), {code:'23503'});
    assert.equal((await db.query('SELECT id FROM installations WHERE project_id=$1',['health'])).rows[0].id, installation);
  } finally {
    await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end();
  }
});
