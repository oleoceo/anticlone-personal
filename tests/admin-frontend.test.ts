import assert from 'node:assert/strict';
import {createHmac, randomUUID, scryptSync} from 'node:crypto';
import {once} from 'node:events';
import {mkdir, readdir, readFile} from 'node:fs/promises';
import {request} from 'node:http';
import type {AddressInfo} from 'node:net';
import {test, type TestContext} from 'node:test';
import {TOTP, Secret} from 'otpauth';
import {Pool} from 'pg';
import {chromium, type Page} from 'playwright';
import {createAdminServer} from '../apps/admin-auth.js';
import {join} from 'node:path';
import {commerceAdmin, commerceSigningInput, provisionCommerceSender, receiveCommerce} from '../apps/commerce.js';
import {observe} from '../apps/detection.js';
import {managePages} from '../apps/protected-pages.js';
import {recordObservedFact} from '../apps/observed-metrics.js';
import {registerProject} from '../apps/project-registration.js';

const ui = '/admin/ui/novo';
const password = 'frontend lab only';
const endpoint = 'https://runtime.frontend.test';
const action = (page: Page, name: string) => page.getByRole('button', {name, exact: true});

async function fixture(test: TestContext) {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root = new Pool({connectionString: process.env.TEST_DATABASE_URL});
  const schema = 'frontend_' + randomUUID().replaceAll('-', '');
  await root.query('CREATE SCHEMA ' + schema);
  const db = new Pool({connectionString: process.env.TEST_DATABASE_URL, options: '-c search_path=' + schema});
  test.after(async () => {
    await db.end();
    try { await root.query('DROP SCHEMA ' + schema + ' CASCADE'); }
    finally { await root.end(); }
  });
  for (const name of (await readdir('infra')).filter(name => /^\d{3}_.*\.sql$/.test(name)).sort()) {
    await db.query((await readFile('infra/' + name, 'utf8')).replace(/^\uFEFF/, ''));
  }

  await db.query('CREATE TABLE admin_totp_replay (factor_id text PRIMARY KEY, last_counter bigint NOT NULL)');
  await db.query('CREATE TABLE admin_totp_codes (factor_id text NOT NULL, digest text NOT NULL, valid_until bigint NOT NULL, PRIMARY KEY (factor_id,digest))');

  const savedOrigin = process.env.RUNTIME_PUBLIC_ORIGIN;
  const savedVerifier = process.env.INSTALLATION_VERIFIER_IMAGE;
  process.env.RUNTIME_PUBLIC_ORIGIN = endpoint;
  delete process.env.INSTALLATION_VERIFIER_IMAGE;
  test.after(() => {
    if (savedOrigin === undefined) delete process.env.RUNTIME_PUBLIC_ORIGIN;
    else process.env.RUNTIME_PUBLIC_ORIGIN = savedOrigin;
    if (savedVerifier === undefined) delete process.env.INSTALLATION_VERIFIER_IMAGE;
    else process.env.INSTALLATION_VERIFIER_IMAGE = savedVerifier;
  });

  let clock = Date.now();
  const secret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const totp = new TOTP({secret: Secret.fromBase32(secret)});
  const salt = Buffer.alloc(16, 43);
  const record = 'scrypt$' + salt.toString('hex') + '$' + scryptSync(password, salt, 64).toString('hex');
  const server = createAdminServer(record, secret, db, () => clock).listen(0, '127.0.0.1');
  await once(server, 'listening');
  test.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const browser = await chromium.launch();
  test.after(() => browser.close());

  return {
    db, origin, browser, server,
    code: () => totp.generate({timestamp: clock}),
    advance: (milliseconds: number) => { clock += milliseconds; },
  };
}

async function login(page: Page, code: string, legacy = false) {
  await page.getByLabel('Senha administrativa').fill(password);
  await page.getByLabel(legacy ? 'Código TOTP' : 'Código do autenticador').fill(code);
  const response = page.waitForResponse(response => response.url().endsWith('/admin/ui/login'));
  await action(page, 'Entrar').click();
  return (await response).status();
}

async function firstPage(page: Page, name: string, url: string) {
  await page.getByLabel('Nome da página').fill(name);
  await page.getByLabel('URL oficial da página').fill(url);
  await action(page, 'Continuar').click();
  await page.getByLabel('Conferi os dados da oferta e da página.').check();
}

async function offer(page: Page, name: string, origin: string) {
  await page.getByRole('link', {name: 'Proteger oferta'}).click();
  await page.getByLabel('Nome da oferta').fill(name);
  await page.getByLabel('Origem oficial').fill(origin);
  await action(page, 'Continuar').click();
}

for (const width of [1440, 390]) {
  test('new admin project, partial conflict, installation, history and draft guard at ' + width + ' px', {timeout: 90_000}, async t => {
    const lab = await fixture(t);
    const context = await lab.browser.newContext({viewport: {width, height: 820}, hasTouch: width < 760});
    const page = await context.newPage();
    const errors: string[] = [];
    const foreign: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(lab.origin + '/')) foreign.push(request.url()); });
    await lab.db.query("INSERT INTO projects(id,name,origin) VALUES('conflict','Outra oferta','https://conflict.frontend.test')");
    await lab.db.query("INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES($1,'conflict',$2,'Em uso')",
      [randomUUID(), randomUUID()]);
    await lab.db.query("INSERT INTO protected_page_urls(page_id,origin,pathname) SELECT id,'https://offer.frontend.test','/em-uso' FROM protected_pages WHERE project_id='conflict'");

    const shell = await page.goto(lab.origin + ui);
    assert.equal(shell?.status(), 200);
    const csp = (await shell?.allHeaders())?.['content-security-policy'];
    assert.ok(csp?.includes("script-src 'self'; style-src 'self'; connect-src 'self'"));
    assert.equal(await login(page, lab.code()), 204);
    await page.getByRole('heading', {name: 'Meus Projetos'}).waitFor();
    await offer(page, 'Oferta Aurora', 'https://offer.frontend.test');

    if (width < 760) {
      await page.getByLabel('Nome da página').focus();
      await page.setViewportSize({width, height: 380});
      assert.equal(await page.locator('.bottom-nav').isHidden(), true);
    }
    await firstPage(page, 'Página inicial', 'https://offer.frontend.test/em-uso');
    if (width < 760) {
      const submit = action(page, 'Cadastrar oferta e página');
      await submit.scrollIntoViewIfNeeded();
      assert.equal(await submit.evaluate(button => {
        const box = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }), true, 'submission stays tappable above the fixed navigation');
    }

    const conflict = page.waitForResponse(response =>
      response.url().endsWith('/pages') && response.request().postDataJSON()?.action === 'create');
    await action(page, 'Cadastrar oferta e página').click();
    assert.equal((await conflict).status(), 409);
    await page.getByText('Oferta cadastrada. Continue com a primeira página.').waitFor();
    await page.getByRole('alert').filter({hasText: 'conflito'}).waitFor();
    const project = (await lab.db.query("SELECT id FROM projects WHERE name='Oferta Aurora'")).rows[0].id as string;
    assert.equal((await lab.db.query('SELECT count(*)::int AS count FROM protected_pages WHERE project_id=$1', [project])).rows[0].count, 0);
    await action(page, 'Corrigir página').click();
    assert.equal(await page.getByLabel('Nome da página').inputValue(), 'Página inicial');
    assert.equal(await page.getByLabel('URL oficial da página').inputValue(), 'https://offer.frontend.test/em-uso');
    await firstPage(page, 'Página inicial', 'https://offer.frontend.test/inicio');
    await action(page, 'Cadastrar página').click();
    await page.getByRole('heading', {name: 'Instalar a proteção'}).waitFor();
    assert.equal((await lab.db.query("SELECT count(*)::int AS count FROM projects WHERE name='Oferta Aurora'")).rows[0].count, 1);
    assert.equal((await lab.db.query('SELECT count(*)::int AS count FROM runtime_distributions')).rows[0].count, 0);

    const installation = page.url();
    if (width < 760) await page.setViewportSize({width, height: 820});
    await action(page, 'Publicar endereços de instalação').click();
    await page.getByRole('dialog').waitFor();
    await action(page, 'Confirmar').click();
    await page.getByText('Revisão 1', {exact: true}).waitFor();
    assert.match(await page.getByRole('region', {name: 'Trecho HTML'}).locator('code').innerText(), /runtime\.frontend\.test\/r\/v2\//);
    await page.getByText('Recursos, revisões e rotação', {exact: true}).click();
    assert.equal(await page.locator('.resources li').count(), 12);
    await action(page, 'Publicar nova revisão').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Revisão 2', {exact: true}).waitFor();
    assert.equal((await lab.db.query('SELECT count(*)::int AS count FROM runtime_aliases')).rows[0].count, 6);
    await page.getByText('Configurar coleta da origem principal', {exact: true}).click();
    await action(page, 'Habilitar coleta').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Coleta do projeto habilitada.').waitFor();
    assert.equal((await lab.db.query('SELECT enabled FROM installations WHERE project_id=$1', [project])).rows[0].enabled, true);

    const rejection = page.waitForResponse(response =>
      response.url().endsWith('/distribution') && response.request().postDataJSON()?.action === 'verify');
    await action(page, 'Verificar instalação').click();
    await action(page, 'Confirmar').click();
    assert.equal((await rejection).status(), 400, 'environment without isolated verifier reports the real server error');
    await page.getByRole('alert').filter({hasText: 'servidor recusou'}).waitFor();
    await page.getByText('Revisão 2', {exact: true}).waitFor();

    await page.reload();
    await page.getByText('Revisão 2', {exact: true}).waitFor();
    assert.equal(page.url(), installation);
    await action(page, '← Voltar para Página inicial').click();
    await page.getByRole('heading', {name: 'URLs autorizadas'}).waitFor();
    const lp = page.url();
    await page.getByRole('link', {name: 'Instalar e conferir'}).click();
    await page.getByRole('heading', {name: 'Instalar a proteção'}).waitFor();
    await page.goBack();
    await page.getByRole('heading', {name: 'URLs autorizadas'}).waitFor();
    assert.equal(page.url(), lp);
    await page.goForward();
    await page.getByRole('heading', {name: 'Instalar a proteção'}).waitFor();
    assert.equal(page.url(), installation);

    await page.getByRole('navigation', {name: 'Localização'}).getByRole('link', {name: 'Meus Projetos'}).click();
    await page.getByLabel('Buscar projeto').fill('Aurora');
    await page.getByLabel('Estado').selectOption('ACTIVE');
    assert.match(page.url(), /estado=ACTIVE/);
    assert.ok(!page.url().includes('Aurora'));
    await page.getByRole('link', {name: 'Abrir oferta Oferta Aurora'}).click();
    await page.getByRole('heading', {name: 'URLs autorizadas'}).waitFor();
    assert.equal(page.url(), lp);
    await page.goBack();
    assert.equal(await page.getByLabel('Buscar projeto').inputValue(), 'Aurora');
    assert.equal(await page.getByLabel('Estado').inputValue(), 'ACTIVE');

    await page.getByRole('link', {name: 'Proteger oferta'}).click();
    await page.getByLabel('Nome da oferta').fill('Rascunho');
    await page.goBack().catch(() => undefined);
    await page.getByRole('dialog', {name: 'Descartar alterações?'}).waitFor();
    await action(page, 'Cancelar').click();
    assert.equal(await page.getByLabel('Nome da oferta').inputValue(), 'Rascunho');
    await action(page, '← Voltar para Meus Projetos').click();
    await action(page, 'Descartar e sair').click();
    assert.equal(await page.getByLabel('Buscar projeto').inputValue(), 'Aurora');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    assert.deepEqual(foreign, []);
  });
}

type CreationWrite = {target: 'project' | 'page'; status: number; key?: string | string[]};

function interruptCreations(server: Awaited<ReturnType<typeof fixture>>['server'], beforeHeaders: boolean) {
  const writes: CreationWrite[] = [];
  server.prependListener('request', (req, res) => {
    if (req.method !== 'POST' || !['/admin/ui/project-create', '/admin/ui/pages'].includes(req.url ?? '')) return;
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    res.end = new Proxy(res.end, {apply(end, response, args) {
      const target = req.url === '/admin/ui/project-create' ? 'project' :
        JSON.parse(body).action === 'create' ? 'page' : undefined;
      if (target) {
        const first = !writes.some(write => write.target === target);
        writes.push({target, status: res.statusCode, key: req.headers['idempotency-key']});
        if (first && res.statusCode === 200) {
          // The real handler has committed before it prepares the HTTP response.
          if (beforeHeaders) return res.destroy();
          res.write('{', () => res.destroy());
          return res;
        }
      }
      return Reflect.apply(end, response, args);
    }});
  });
  return writes;
}

test('transport replay before headers registers and audits one project, and LP uniqueness prevents a second page', {timeout: 90_000}, async t => {
  const lab = await fixture(t);
  const page = await lab.browser.newPage();
  await page.goto(lab.origin + ui + '/projetos');
  assert.equal(await login(page, lab.code()), 204);
  await offer(page, 'Oferta retransmitida', 'https://transport.frontend.test');
  await firstPage(page, 'Página retransmitida', 'https://transport.frontend.test/oferta');
  const writes = interruptCreations(lab.server, true);
  assert.equal(await page.evaluate(async () => (await fetch('/admin/ui/projects')).status), 200);

  await action(page, 'Cadastrar oferta e página').click();
  await page.getByRole('alert').filter({hasText: 'conflito'}).waitFor();
  await action(page, 'Abrir instalação de Página retransmitida').click();
  await page.getByRole('heading', {name: 'Instalar a proteção'}).waitFor();

  const projectWrites = writes.filter(write => write.target === 'project');
  const key = projectWrites[0].key;
  assert.equal(typeof key, 'string');
  assert.deepEqual(projectWrites.map(write => [write.status, write.key]), [[200, key], [200, key]]);
  assert.deepEqual(writes.filter(write => write.target === 'page').map(write => write.status), [200, 409]);
  assert.deepEqual((await lab.db.query('SELECT id, name, origin FROM projects')).rows,
    [{id: key, name: 'Oferta retransmitida', origin: 'https://transport.frontend.test'}]);
  assert.deepEqual((await lab.db.query('SELECT project_id, action FROM project_registration_audit')).rows,
    [{project_id: key, action: 'CREATE_PROJECT'}]);
  const pages = (await lab.db.query('SELECT id, project_id FROM protected_pages')).rows;
  assert.equal(pages.length, 1);
  assert.equal(pages[0].project_id, key);
  assert.deepEqual((await lab.db.query('SELECT page_id, origin, pathname FROM protected_page_urls')).rows,
    [{page_id: pages[0].id, origin: 'https://transport.frontend.test', pathname: '/oferta'}]);
  assert.ok(page.url().endsWith('/lps/' + pages[0].id + '/instalacao'));
});

test('recovers the committed project and LP by their saved identities after truncated responses', {timeout: 90_000}, async t => {
  const lab = await fixture(t);
  const page = await lab.browser.newPage();
  await page.goto(lab.origin + ui + '/projetos');
  assert.equal(await login(page, lab.code()), 204);
  const earlier = await registerProject(lab.db, {name: 'Oferta Retomada', origin: 'https://resume.frontend.test'});
  await offer(page, 'Oferta Retomada', 'https://resume.frontend.test');
  await firstPage(page, 'Página retomada', 'https://resume.frontend.test/inscricao');
  const writes = interruptCreations(lab.server, false);

  await action(page, 'Cadastrar oferta e página').click();
  await page.getByRole('heading', {name: 'Conferir cadastro'}).waitFor();
  await page.getByRole('alert').waitFor();
  assert.equal(writes.length, 1);
  const recovered = (await lab.db.query('SELECT id FROM projects WHERE id <> $1', [earlier.id])).rows[0].id as string;
  assert.equal(recovered, writes[0].key);
  page.once('dialog', dialog => void dialog.accept());
  assert.equal((await page.reload())?.status(), 200);
  await action(page, 'Consultar cadastro').click();
  await page.getByText('Oferta localizada.', {exact: false}).waitFor();
  assert.equal(await page.locator('.identifier').innerText(), recovered);
  await page.route('**/admin/ui/project-history', route => route.abort());
  await action(page, 'Consultar cadastro').click();
  await page.getByRole('alert').waitFor();
  assert.equal(await action(page, 'Usar oferta localizada').count(), 0);
  await page.unroute('**/admin/ui/project-history');
  await action(page, 'Consultar cadastro').click();
  await action(page, 'Usar oferta localizada').click();
  await firstPage(page, 'Página retomada', 'https://resume.frontend.test/inscricao');
  await action(page, 'Cadastrar página').click();
  await page.getByRole('alert').waitFor();
  await action(page, 'Consultar cadastro').click();
  await action(page, 'Abrir instalação de Página retomada').click();
  await page.getByRole('heading', {name: 'Instalar a proteção'}).waitFor();
  assert.deepEqual(writes.map(write => write.target), ['project', 'page']);
  assert.equal((await lab.db.query('SELECT count(*)::int AS count FROM projects')).rows[0].count, 2);
  assert.deepEqual((await lab.db.query('SELECT project_id FROM protected_pages')).rows, [{project_id: recovered}]);
});

test('a project request lost before commit can be deliberately retried with the original key after reload', {timeout: 60_000}, async t => {
  const lab = await fixture(t);
  const {id: homonym} = await registerProject(lab.db, {name: 'Outra tentativa', origin: 'https://pending.frontend.test'});
  const page = await lab.browser.newPage();
  await page.goto(lab.origin + ui + '/projetos');
  assert.equal(await login(page, lab.code()), 204);
  await offer(page, 'Outra tentativa', 'https://pending.frontend.test');
  await firstPage(page, 'Página pendente', 'https://pending.frontend.test/oferta');
  const keys: string[] = [];
  await page.route('**/admin/ui/project-create', async route => {
    keys.push(route.request().headers()['idempotency-key']);
    if (keys.length === 1) await route.abort();
    else await route.continue();
  });
  await action(page, 'Cadastrar oferta e página').click();
  await page.getByRole('alert').waitFor();
  page.once('dialog', dialog => void dialog.accept());
  assert.equal((await page.reload())?.status(), 200);
  await action(page, 'Consultar cadastro').click();
  await page.getByText('O cadastro ainda não aparece', {exact: false}).waitFor();
  assert.equal(await action(page, 'Usar oferta localizada').count(), 0);

  await page.getByLabel('Nome da oferta').fill('Dados diferentes');
  await page.getByLabel('Origem oficial').fill('https://pending.frontend.test');
  await action(page, 'Reenviar cadastro da oferta').click();
  await page.getByText('Informe o mesmo nome e a mesma origem do primeiro envio.').waitFor();
  assert.equal(keys.length, 1);

  await page.getByLabel('Nome da oferta').fill('Outra tentativa');
  await action(page, 'Reenviar cadastro da oferta').click();
  await page.getByRole('heading', {name: 'Informar página'}).waitFor();
  assert.equal(typeof keys[0], 'string');
  assert.deepEqual(keys, [keys[0], keys[0]]);
  assert.deepEqual((await lab.db.query('SELECT id FROM projects WHERE id <> $1', [homonym])).rows, [{id: keys[0]}]);
  assert.deepEqual((await lab.db.query('SELECT project_id FROM project_registration_audit WHERE project_id <> $1', [homonym])).rows,
    [{project_id: keys[0]}]);
  assert.equal((await lab.db.query('SELECT count(*)::int AS count FROM protected_pages')).rows[0].count, 0);
});

test('project registration key handles concurrent replay, changed payload, legacy calls and audit rollback', {timeout: 60_000}, async t => {
  const lab = await fixture(t);
  const context = await lab.browser.newContext();
  const page = await context.newPage();
  await page.goto(lab.origin + ui);
  assert.equal(await login(page, lab.code()), 204);
  await page.getByRole('heading', {name: 'Meus Projetos'}).waitFor();

  const session = (await context.cookies()).find(cookie => cookie.name === 'admin_session');
  assert.ok(session);
  const csrf = await page.evaluate(async () => (await (await fetch('/admin/ui/bootstrap')).json()).csrf as string);
  const post = (name: string, origin: string, key?: string, extra: Record<string, string> = {}) =>
    fetch(lab.origin + '/admin/ui/project-create', {
      method: 'POST', body: JSON.stringify({name, origin}),
      headers: {
        origin: lab.origin, 'sec-fetch-site': 'same-origin', cookie: 'admin_session=' + session.value,
        'content-type': 'application/json', 'x-csrf-token': csrf, ...(key ? {'idempotency-key': key} : {}), ...extra,
      },
    });

  const key = randomUUID();
  const origin = 'https://concurrent.frontend.test';
  const replies = await Promise.all(Array.from({length: 8}, (_, index) =>
    index % 2 ? post('  Oferta concorrente  ', 'https://CONCURRENT.frontend.test:443/', key.toUpperCase())
      : post('Oferta concorrente', origin, key)));
  for (const reply of replies) {
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), {id: key, name: 'Oferta concorrente', origin});
  }
  assert.equal((await post('Outro nome', origin, key)).status, 409);
  assert.equal((await post('Oferta concorrente', 'https://other.frontend.test', key)).status, 409);
  assert.equal((await post('Oferta concorrente', origin, 'invalid')).status, 400);
  assert.equal((await post('Oferta concorrente', origin, key, {'x-csrf-token': 'wrong'})).status, 403);
  assert.deepEqual((await lab.db.query('SELECT id, name, origin FROM projects')).rows,
    [{id: key, name: 'Oferta concorrente', origin}]);
  assert.equal((await lab.db.query('SELECT count(*)::int AS count FROM project_registration_audit WHERE project_id=$1', [key])).rows[0].count, 1);

  const raceKey = randomUUID();
  const competing = await Promise.all([post('Oferta Alfa', origin, raceKey), post('Oferta Beta', origin, raceKey)]);
  assert.deepEqual(competing.map(reply => reply.status).sort(), [200, 409]);
  const winner = await competing.find(reply => reply.ok)!.json();
  assert.deepEqual((await lab.db.query('SELECT name, origin FROM project_registration_audit WHERE project_id=$1', [raceKey])).rows,
    [{name: winner.name, origin}]);

  const legacy = await post('Oferta concorrente', origin);
  assert.equal(legacy.status, 200);
  const legacyId: string = (await legacy.json()).id;
  assert.notEqual(legacyId, key);
  assert.equal((await lab.db.query('SELECT count(*)::int AS count FROM project_registration_audit WHERE project_id=$1', [legacyId])).rows[0].count, 1);

  const historicalKey = randomUUID();
  await lab.db.query('INSERT INTO project_registration_audit(project_id,name,origin) VALUES($1,$2,$3)',
    [historicalKey, 'Oferta histórica', origin]);
  assert.equal((await post('Oferta histórica', origin, historicalKey)).status, 409);
  assert.equal((await lab.db.query('SELECT count(*)::int AS count FROM projects WHERE id=$1', [historicalKey])).rows[0].count, 0);
  assert.equal((await lab.db.query('SELECT count(*)::int AS count FROM project_registration_audit WHERE project_id=$1', [historicalKey])).rows[0].count, 1);

  await lab.db.query("ALTER TABLE project_registration_audit ADD CHECK (name <> 'Bloqueio sintético')");
  const rollbackKey = randomUUID();
  assert.equal((await post('Bloqueio sintético', origin, rollbackKey)).status, 503);
  assert.equal((await lab.db.query('SELECT count(*)::int AS count FROM projects WHERE id=$1', [rollbackKey])).rows[0].count, 0);
  assert.equal((await lab.db.query('SELECT count(*)::int AS count FROM project_registration_audit WHERE project_id=$1', [rollbackKey])).rows[0].count, 0);
  assert.equal((await post('Cadastro após rollback', origin, rollbackKey)).status, 200);
});


test('new and legacy consoles share the same MFA, session lifetime and private route boundary', {timeout: 90_000}, async t => {
  const lab = await fixture(t);
  const context = await lab.browser.newContext();
  const modern = await context.newPage();
  const legacy = await context.newPage();
  await modern.goto(lab.origin + ui + '/projetos');
  assert.equal(await login(modern, lab.code() === '000000' ? '111111' : '000000'), 401);
  await modern.getByRole('alert').waitFor();
  await legacy.goto(lab.origin + '/admin/ui/');
  assert.equal(await login(legacy, lab.code(), true), 204);
  await legacy.getByText('Configuração incompleta', {exact: true}).waitFor();
  await modern.reload();
  await modern.getByRole('heading', {name: 'Meus Projetos'}).waitFor();
  const session = (await context.cookies()).find(cookie => cookie.name === 'admin_session');
  assert.ok(session?.httpOnly);
  assert.equal(session.sameSite, 'Strict');
  assert.equal(session.path, '/admin/ui/');
  assert.ok(session.expires > Date.now() / 1000 + 850);

  const block = await fetch(lab.origin + ui, {headers: {origin: 'https://outside.test', 'sec-fetch-site': 'cross-site'}});
  assert.equal(block.status, 403);
  assert.equal(await new Promise<number | undefined>((resolve, reject) => {
    const connection = request(lab.origin + ui, {headers: {host: 'localhost:3001'}}, response => {
      response.resume();
      resolve(response.statusCode);
    });
    connection.on('error', reject);
    connection.end();
  }), 403);
  assert.equal((await fetch(lab.origin + ui + '/assets/%2e%2e%2fapp.js')).status, 404);
  assert.equal((await fetch(lab.origin + '/admin/ui/projects')).status, 403);
  assert.equal((await fetch(lab.origin + '/admin/ui/project-create', {
    method: 'POST',
    headers: {origin: lab.origin, 'sec-fetch-site': 'same-origin', cookie: 'admin_session=' + session.value, 'content-type': 'application/json'},
    body: JSON.stringify({name: 'Recusado', origin: 'https://rejected.frontend.test'}),
  })).status, 403);

  await modern.getByRole('link', {name: 'Proteger oferta'}).click();
  await modern.getByLabel('Nome da oferta').fill('Rascunho na expiração');
  lab.advance(15 * 60_000 - 1);
  const stillActive = await fetch(lab.origin + '/admin/ui/projects', {headers: {
    'sec-fetch-site': 'same-origin', cookie: 'admin_session=' + session.value,
  }});
  assert.equal(stillActive.status, 200);
  lab.advance(1);
  await modern.bringToFront();
  await modern.evaluate(() => window.dispatchEvent(new Event('focus')));
  await modern.getByText('Sua sessão terminou. Entre novamente para continuar.').waitFor();
  await legacy.reload();
  await legacy.getByLabel('Código TOTP').waitFor();
  assert.equal(await login(modern, lab.code()), 204);
  assert.equal(await modern.getByLabel('Nome da oferta').inputValue(), 'Rascunho na expiração');
  await legacy.reload();
  await legacy.getByText('Configuração incompleta', {exact: true}).waitFor();

  lab.advance(30_000);
  const anotherContext = await lab.browser.newContext();
  const anotherLegacy = await anotherContext.newPage();
  await anotherLegacy.goto(lab.origin + '/admin/ui/');
  assert.equal(await login(anotherLegacy, lab.code(), true), 204);
  await anotherLegacy.getByText('Configuração incompleta', {exact: true}).waitFor();
  await modern.bringToFront();
  await modern.evaluate(() => window.dispatchEvent(new Event('focus')));
  await modern.getByText('Sua sessão terminou. Entre novamente para continuar.').waitFor();

  lab.advance(30_000);
  assert.equal(await login(modern, lab.code()), 204);
  await action(modern, 'Sair da sessão').waitFor();
  let hold!: (release: () => void) => void;
  const earlyRead = new Promise<() => void>(resolve => { hold = resolve; });
  let holdNextBootstrap = true;
  lab.server.prependListener('request', (req, res) => {
    if (!holdNextBootstrap || req.url !== '/admin/ui/bootstrap') return;
    holdNextBootstrap = false;
    res.setHeader('X-Test-Stale-Bootstrap', '1');
    res.end = new Proxy(res.end, {apply(end, response, args) {
      hold(() => { Reflect.apply(end, response, args); });
      return res;
    }});
  });
  const staleResponse = modern.waitForResponse(response => response.url().endsWith('/admin/ui/bootstrap') &&
    (response.headers()['x-test-stale-bootstrap'] === '1'));
  await modern.bringToFront();
  await modern.evaluate(() => window.dispatchEvent(new Event('focus')));
  const release = await earlyRead;
  try {
    await action(modern, 'Sair da sessão').click();
    await action(modern, 'Sair').click();
    await modern.getByRole('heading', {name: 'Entre no seu espaço'}).waitFor();
  } finally { release(); }
  assert.deepEqual((await (await staleResponse).json()).authenticated, true);
  assert.equal(await modern.getByRole('heading', {name: 'Entre no seu espaço'}).count(), 1);
  await legacy.reload();
  await legacy.getByLabel('Código TOTP').waitFor();
  assert.equal((await context.cookies()).some(cookie => cookie.name === 'admin_session'), false);
});

for (const width of [1440, 390]) {
  test('incident to PAGE_REDIRECT, REPLACE_CONVERSION, estimate and scoped commerce at ' + width + ' px',
    {timeout: 120_000}, async t => {
    const lab = await fixture(t);
    const original = 'https://oferta.frontend.test';
    const observedDomain = 'https://observado.frontend.test';
    const project = await registerProject(lab.db, {name: 'Aurora Cursos', origin: original});
    const lp = await managePages(lab.db, {action: 'create', project: project.id, name: 'Página de vendas', url: original + '/oferta'}) as {page: string};
    const other = await managePages(lab.db, {action: 'create', project: project.id, name: 'Página complementar', url: 'https://complementar.frontend.test/oferta'}) as {page: string};
    assert.equal(await observe(lab.db, project.id, original, observedDomain), 'observed');
    await recordObservedFact(lab.db, project.id, {page: lp.page, event: randomUUID(), session: 'ca'.repeat(16),
      action: 'CTA_CLICK_OBSERVED', traffic: 'DIRECT_UNKNOWN', version: null, evidence: 'BROWSER_UNVERIFIED'});
    const config = {auth:'HMAC_SHA256_TIMESTAMP', fields:{event:'event',order:'order',amount:'amount',currency:'currency',
      status:'status',occurred:'occurred',product:'product'}, statuses:{paid:'PAID'}, money:{unit:'DECIMAL',exponent:2}};
    const model = await commerceAdmin(lab.db, {action:'model', expected_version:0, name:'Custom-teste', reviewed:true, config,
      sample:{event:'e1',order:'order1',amount:'19.99',currency:'BRL',status:'paid',occurred:new Date().toISOString(),product:'produto1'}}) as {id: string; version: number};
    const checkoutEnv = {COMMERCE_ENCRYPTION_KEY:'cd'.repeat(32)};
    const account = await commerceAdmin(lab.db, {action:'connection', model:model.id, model_version:model.version, account:'Checkout-Aurora'},
      checkoutEnv) as {id: string};
    const senderKey = await provisionCommerceSender(lab.db, account.id, checkoutEnv);
    const sale = async (product: string, event: string) => {
      const raw = Buffer.from(JSON.stringify({event,order:event,product,amount:'89.00',currency:'BRL',status:'paid',occurred:new Date().toISOString()}));
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', Buffer.from(senderKey, 'hex')).update(commerceSigningInput(timestamp, raw)).digest('hex');
      return receiveCommerce(lab.db, account.id, raw, timestamp, signature, checkoutEnv);
    };
    assert.equal((await sale('outro-produto','test')).recorded, false);
    await commerceAdmin(lab.db, {action:'connection-state', id:account.id, expected_version:1, state:'ACTIVE'}, checkoutEnv);
    await commerceAdmin(lab.db, {action:'binding', expected_version:0, project:project.id, page:other.page, connection:account.id,
      product:'outro-produto', url:original + '/outro-checkout', currency:'BRL', state:'ACTIVE', price_minor:4200});
    assert.equal((await sale('outro-produto','order-other')).bound, true);
    const context = await lab.browser.newContext({viewport: {width, height: width < 760 ? 844 : 1000}, hasTouch: width < 760, isMobile: width < 760});
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const captureRoot = process.env.TEST_FRONTEND_B_CAPTURES;
    async function capture(name: string, focus?: string) {
      if (!captureRoot) return;
      const folder = join(captureRoot, width < 760 ? 'mobile' : 'desktop');
      await mkdir(folder, {recursive: true});
      if (focus && width < 760) await page.getByRole('heading', {name: focus, exact: true}).evaluate(element => {
        window.scrollBy(0, element.getBoundingClientRect().top - 15);
      });
      else await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({path: join(folder, name + '.png'), animations: 'disabled'});
    }

    await page.goto(lab.origin + ui + '/incidentes');
    assert.equal(await login(page, lab.code()), 204);
    await page.getByRole('link', {name: 'Ver incidentes de Aurora Cursos'}).click();
    await page.getByLabel('Buscar domínio').fill('observado');
    await page.getByLabel('Período').selectOption('7');
    const incidentsUrl = page.url();
    await page.getByRole('link', {name: 'Investigar observado.frontend.test'}).waitFor();
    await capture('01-incidentes');
    await page.getByRole('link', {name: 'Investigar observado.frontend.test'}).click();
    await page.getByRole('heading', {name: 'observado.frontend.test', exact:true}).waitFor();
    await page.getByLabel('Página protegida').selectOption(lp.page);
    await page.getByLabel('Nova situação').selectOption('investigating');
    await page.getByLabel('Justificativa').fill('Revisão administrativa no ambiente de teste');
    await action(page, 'Revisar mudança').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Não verificado → Em investigação').waitFor();
    await page.getByText('Histórico de recibos da LP', {exact: true}).click();
    await action(page, 'Consultar histórico').click();
    await page.getByText('Nenhum recibo no recorte.').waitFor();
    await capture('02-investigacao');
    await page.getByRole('link', {name: 'Redirecionar página', exact: true}).click();
    await page.getByRole('heading', {name: 'Redirecionar página', exact: true}).waitFor();
    await page.getByLabel('Destino da página').fill(original + '/segura');
    await page.goBack().catch(() => undefined);
    await page.getByRole('dialog', {name:'Descartar alterações?'}).waitFor();
    await action(page, 'Cancelar').click();
    assert.equal(await page.getByLabel('Destino da página').inputValue(), original + '/segura');
    await page.getByLabel('Tráfego pago atribuído').selectOption('100');
    await page.getByLabel('Habilitar nesta versão').check();
    await action(page, 'Revisar publicação').click();
    await page.getByRole('dialog', {name:'Publicar PAGE_REDIRECT'}).waitFor();
    await action(page, 'Confirmar').click();
    await page.getByText('Política publicada. Versão 1.').waitFor();
    assert.equal((await lab.db.query('SELECT count(*)::int AS total FROM page_entry_policy_bindings')).rows[0].total, 0);
    assert.equal(await action(page, 'Revisar autorização').count(), 0);
    await page.getByLabel('Versão de redirecionamento').selectOption('1');
    await action(page, 'Revisar aprovação').click();
    await page.getByRole('dialog', {name:'Aprovar versões na LP'}).waitFor();
    await lab.db.query('UPDATE protected_pages SET config_generation=config_generation+1 WHERE id=$1', [lp.page]);
    await action(page, 'Confirmar').click();
    await page.getByRole('alert').filter({hasText:'conflito'}).waitFor();
    assert.equal((await lab.db.query('SELECT count(*)::int AS total FROM page_entry_policy_bindings')).rows[0].total, 0);
    const reread = page.waitForResponse(response => response.url().endsWith('/pages') &&
      response.request().postDataJSON()?.action === 'inspect');
    await action(page, 'Atualizar situação').click();
    assert.equal((await reread).status(), 200);
    await action(page, 'Revisar aprovação').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Aprovação registrada.', {exact:false}).waitFor();
    await page.getByLabel('Origem HTTPS observada').fill(observedDomain);
    await page.getByLabel('Caminho exato da cópia').fill('/evidencia');
    await page.getByLabel('Conferi o contexto', {exact: false}).check();
    await action(page, 'Revisar autorização').click();
    await page.getByRole('dialog', {name:'Autorizar contexto', exact:true}).waitFor();
    await page.route('**/admin/ui/operational', async route => {
      const reviewed = route.request().postDataJSON().expectedApprovalId;
      assert.equal(typeof reviewed, 'string');
      const {url_generation, config_generation} = (await lab.db.query(
        'SELECT url_generation,config_generation FROM protected_pages WHERE id=$1', [lp.page])).rows[0];
      await managePages(lab.db, {project:project.id, page:lp.page, action:'approve', entryVersion:1, ctaVersions:[],
        generation:url_generation, configGeneration:config_generation});
      await route.continue();
    }, {times:1});
    const stale = page.waitForResponse(response => response.url().endsWith('/operational') &&
      response.request().postDataJSON()?.action === 'authorize');
    await action(page, 'Confirmar').click();
    assert.equal((await stale).status(), 409);
    await page.getByRole('alert').filter({hasText:'conflito'}).waitFor();
    assert.equal((await lab.db.query('SELECT count(*)::int AS total FROM page_operational_authorizations')).rows[0].total, 0);
    const refreshedApproval = page.waitForResponse(response => response.url().endsWith('/pages') &&
      response.request().postDataJSON()?.action === 'inspect');
    await action(page, 'Atualizar situação').click();
    assert.equal((await refreshedApproval).status(), 200);
    await action(page, 'Revisar autorização').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Autorização registrada. Revisão 1.').waitFor();
    assert.deepEqual((await lab.db.query('SELECT copy_origin,copy_pathname,enabled FROM page_operational_authorizations')).rows,
      [{copy_origin:observedDomain,copy_pathname:'/evidencia',enabled:true}]);
    await capture('03-redirecionamento', 'Autorizar contexto operacional');

    await page.getByLabel('Destino da página').fill(original + '/rascunho');
    await action(page, 'Suspender autorização').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Autorização suspensa.').waitFor();
    await action(page, '← Voltar para investigação').click();
    await action(page, 'Cancelar').click();
    assert.equal(await page.getByLabel('Destino da página').inputValue(), original + '/rascunho');
    await action(page, '← Voltar para investigação').click();
    await action(page, 'Descartar e sair').click();
    await page.getByRole('link', {name: 'Substituir CTA', exact: true}).click();
    await page.getByRole('heading', {name: 'Substituir CTA', exact: true}).waitFor();
    await page.getByLabel('Superfície de CTA').fill('principal');
    await page.getByLabel('Habilitar nesta versão').check();
    await page.getByLabel('Direto ou desconhecido').selectOption('100');
    await action(page, 'Revisar publicação').click();
    await page.getByRole('dialog', {name:'Publicar REPLACE_CONVERSION'}).waitFor();
    await action(page, 'Confirmar').click();
    await page.getByText('Cadastrar destino aprovado', {exact:true}).click();
    await page.getByLabel('Identificador da oferta').fill('aurora');
    await page.getByLabel('URL do destino do CTA').fill(original + '/seguro');
    await action(page, 'Revisar destino').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Destino cadastrado.').waitFor();
    await page.getByText('Importar captura existente', {exact:true}).click();
    const candidates = (amount: number) => [{marker:'compra01',kind:'a',parent:'body',ordinal:1,url:original+'/checkout',
      commercial:{amount,currency:'BRL'}}];
    async function importCapture(amount: number) {
      await page.getByLabel('JSON dos candidatos').fill(JSON.stringify(candidates(amount)));
      await action(page, 'Revisar captura').click();
      await action(page, 'Confirmar').click();
      await page.getByText('Captura importada.', {exact:true}).waitFor();
    }
    await importCapture(6700);
    await page.getByLabel('Destino aprovado para compra01').selectOption({label:'aurora · ' + original + '/seguro'});
    await action(page, 'Revisar mapeamento').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Mapeamento salvo.').waitFor();
    async function approveTerms() {
      await action(page, 'Revisar termos comerciais').click();
      await action(page, 'Confirmar').click();
      await page.getByText('Termos comerciais revisados.', {exact:true}).waitFor();
    }
    await approveTerms();
    await importCapture(8900);
    await page.getByText('Mudança comercial pendente de revisão.').waitFor();
    await approveTerms();
    await capture('04-inventario-cta', 'compra01');
    await page.getByLabel('principal · versão 1', {exact:true}).check();
    await action(page, 'Revisar aprovação').click();
    await page.getByRole('dialog', {name:'Aprovar versões na LP'}).waitFor();
    await action(page, 'Confirmar').click();
    await page.getByText('Aprovação registrada.', {exact:false}).waitFor();
    await page.getByLabel('Origem HTTPS observada').fill(observedDomain);
    await page.getByLabel('Caminho exato da cópia').fill('/evidencia');
    await page.getByLabel('Conferi o contexto', {exact:false}).check();
    await action(page, 'Revisar autorização').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Autorização registrada. Revisão 3.').waitFor();
    assert.equal((await lab.db.query('SELECT count(*)::int AS n FROM page_entry_policy_bindings')).rows[0].n, 1);
    assert.equal((await lab.db.query('SELECT count(*)::int AS n FROM page_cta_policy_bindings')).rows[0].n, 1);
    await capture('05-substituicao-cta', 'Aprovar políticas na LP');
    await action(page, '← Voltar para investigação').click();
    await action(page, '← Voltar para Incidentes').click();
    assert.equal(page.url(), incidentsUrl);
    assert.equal(await page.getByLabel('Buscar domínio').inputValue(), 'observado');
    assert.equal(await page.getByLabel('Período').inputValue(), '7');

    const base = lab.origin + ui + '/projetos/' + project.id + '/lps/' + lp.page + '/conversoes';
    assert.equal((await page.goto(base + '?dias=1'))?.status(), 200);
    await page.getByRole('link', {name:'Configurar estimativa'}).click();
    await page.getByLabel('Ticket médio', {exact:true}).fill('100,00');
    await page.getByLabel('Taxa de conversão (%)').fill('5');
    await action(page, 'Revisar premissas').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Estimativa configurada. Versão 1', {exact:false}).waitFor();
    await capture('06-estimativa', 'Premissas do projeto');
    await action(page, '← Voltar para Conversões').click();
    await page.getByText('BRL 5,00', {exact:true}).waitFor();
    assert.equal(await page.getByLabel('Período').inputValue(), '1');
    await page.getByText('Sem vendas reportadas no período para esta LP.').waitFor();
    await page.getByRole('link', {name:'Vínculos comerciais'}).click();
    await page.getByText('Nenhum checkout vinculado a esta LP no catálogo retornado.').waitFor();
    await page.getByText('Vincular checkout', {exact:true}).click();
    await page.getByLabel('Conta de checkout').selectOption(account.id);
    await page.getByLabel('Produto', {exact:true}).fill('aurora-vendas');
    await page.getByLabel('URL do checkout').fill(original + '/pagamento');
    await page.getByLabel('Preço de referência').fill('89,00');
    await page.getByLabel('Moeda do checkout').selectOption('BRL');
    await action(page, 'Revisar vínculo comercial').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Vínculo salvo. Versão 1.').waitFor();
    await capture('08-vinculos');
    assert.deepEqual((await lab.db.query('SELECT price_minor,product FROM commerce_bindings WHERE page_id=$1',[lp.page])).rows,
      [{price_minor:'8900',product:'aurora-vendas'}]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal((await sale('aurora-vendas','order-current')).bound, true);
    await action(page, '← Voltar para Conversões').click();
    await page.getByText('1 vendas · BRL 89,00', {exact:true}).waitFor();
    await page.getByText('BRL 5,00', {exact:true}).waitFor();
    await capture('07-conversoes');

    const incidentId = (await lab.db.query('SELECT id FROM incidents WHERE project_id=$1',[project.id])).rows[0].id;
    const wrongPage = lab.origin + ui + '/projetos/' + project.id + '/incidentes/' + incidentId + '/substituir-cta?lp=' + other.page;
    assert.equal((await page.goto(wrongPage))?.status(), 200);
    await page.getByRole('heading', {name:'Substituir CTA',exact:true}).waitFor();
    await page.getByLabel('Superfície de CTA').fill('principal');
    await page.getByLabel('Habilitar nesta versão').check();
    await action(page, 'Revisar publicação').click();
    await page.getByRole('alert').filter({hasText:'A superfície está vinculada a outra LP.'}).waitFor();
    assert.equal((await lab.db.query('SELECT count(*)::int AS n FROM cta_policy_versions')).rows[0].n, 1);
    assert.deepEqual(errors, []);
  });
}
