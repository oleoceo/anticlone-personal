import assert from 'node:assert/strict';
import {randomUUID, scryptSync} from 'node:crypto';
import {once} from 'node:events';
import {readdir, readFile} from 'node:fs/promises';
import {request} from 'node:http';
import type {AddressInfo} from 'node:net';
import {test, type TestContext} from 'node:test';
import {TOTP, Secret} from 'otpauth';
import {Pool} from 'pg';
import {chromium, type Page} from 'playwright';
import {createAdminServer} from '../apps/admin-auth.js';
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
  test.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
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

test('recovers the real committed project and LP after lost responses without repeating POST', {timeout: 90_000}, async t => {
  const lab = await fixture(t);
  const page = await lab.browser.newPage();
  await page.goto(lab.origin + ui + '/projetos');
  assert.equal(await login(page, lab.code()), 204);
  const earlier = await registerProject(lab.db, {name: 'Oferta Retomada', origin: 'https://resume.frontend.test'});
  await offer(page, 'Oferta Retomada', 'https://resume.frontend.test');
  await firstPage(page, 'Página retomada', 'https://resume.frontend.test/inscricao');
  const writes = {project: 0, page: 0};

  // Close the actual server connection after commit, with the browser's original auth headers.
  lab.server.prependListener('request', (req, res) => {
    if (req.method !== 'POST' || !['/admin/ui/project-create', '/admin/ui/pages'].includes(req.url ?? '')) return;
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    res.end = new Proxy(res.end, {apply(end, response, args) {
      const target = req.url === '/admin/ui/project-create' ? 'project' :
        JSON.parse(body).action === 'create' ? 'page' : undefined;
      if (target && ++writes[target] === 1 && res.statusCode === 200) {
        if (target === 'project' && process.env.TEST_FRONTEND_DROP_BEFORE_HEADERS === '1') return res.destroy();
        // A partial 200 body forces a lost response without triggering transport retry.
        res.write('{', () => res.destroy());
        return res;
      }
      return Reflect.apply(end, response, args);
    }});
  });
  await action(page, 'Cadastrar oferta e página').click();
  await page.getByRole('heading', {name: 'Conferir cadastro'}).waitFor();
  await page.getByRole('alert').waitFor();
  assert.equal(writes.project, 1, 'project POSTs observed by the administrative server');
  assert.equal((await lab.db.query('SELECT count(*)::int AS count FROM projects')).rows[0].count, 2);
  page.once('dialog', dialog => void dialog.accept());
  assert.equal((await page.reload())?.status(), 200);
  await action(page, 'Consultar cadastro').click();
  await page.getByText('Oferta localizada.', {exact: false}).waitFor();
  const recovered = (await lab.db.query('SELECT id FROM projects WHERE id <> $1', [earlier.id])).rows[0].id as string;
  assert.equal(await page.locator('.identifier').innerText(), recovered);
  await action(page, 'Usar oferta localizada').click();
  await firstPage(page, 'Página retomada', 'https://resume.frontend.test/inscricao');
  await action(page, 'Cadastrar página').click();
  await page.getByRole('alert').waitFor();
  await action(page, 'Consultar cadastro').click();
  await action(page, 'Abrir instalação de Página retomada').click();
  await page.getByRole('heading', {name: 'Instalar a proteção'}).waitFor();
  assert.deepEqual(writes, {project: 1, page: 1});
  assert.equal((await lab.db.query('SELECT count(*)::int AS count FROM projects')).rows[0].count, 2);
  assert.deepEqual((await lab.db.query('SELECT project_id FROM protected_pages')).rows, [{project_id: recovered}]);
});

test('an interrupted project write does not attach to a pre-existing homonym or reissue the command', {timeout: 60_000}, async t => {
  const lab = await fixture(t);
  await registerProject(lab.db, {name: 'Outra tentativa', origin: 'https://pending.frontend.test'});
  const page = await lab.browser.newPage();
  await page.goto(lab.origin + ui + '/projetos');
  assert.equal(await login(page, lab.code()), 204);
  await offer(page, 'Outra tentativa', 'https://pending.frontend.test');
  await firstPage(page, 'Página pendente', 'https://pending.frontend.test/oferta');
  let attempted = 0;
  await page.route('**/admin/ui/project-create', async route => { attempted++; await route.abort(); });
  await action(page, 'Cadastrar oferta e página').click();
  await page.getByRole('alert').waitFor();
  await action(page, 'Consultar cadastro').click();
  await page.getByText('Nenhuma oferta nova foi localizada.', {exact: false}).waitFor();
  assert.equal(await action(page, 'Usar oferta localizada').count(), 0);
  assert.equal(await action(page, 'Cadastrar oferta e página').count(), 0);
  assert.equal(attempted, 1);
  assert.equal((await lab.db.query('SELECT count(*)::int AS count FROM projects')).rows[0].count, 1);
  assert.equal((await lab.db.query('SELECT count(*)::int AS count FROM protected_pages')).rows[0].count, 0);
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
