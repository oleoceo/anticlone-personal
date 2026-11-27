import {restrictedRuntimeRoles} from './restricted-runtime-roles.js';
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {createHmac, randomUUID, scryptSync} from 'node:crypto';
import {once} from 'node:events';
import {mkdir, mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {createServer, request} from 'node:http';
import {createServer as createTlsServer} from 'node:https';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {test, type TestContext} from 'node:test';
import {TOTP, Secret} from 'otpauth';
import {Pool} from 'pg';
import {chromium, type Page} from 'playwright';
const namedDistribution = process.env.RUNTIME_COMPACT_ALIASES === 'true';
const distributionPrefix = namedDistribution ? '/assets/' : '/r/v2/';
const decisionSuffix = namedDistribution ? /\/api\/config\.[0-9a-f]{20}$/ : /\/g$/;
import {createAdminServer} from '../apps/admin-auth.js';
import {join} from 'node:path';
import {commerceAdmin, commerceSigningInput, commerceWebhook, provisionCommerceSender, receiveCommerce} from '../apps/commerce.js';
import {observe} from '../apps/detection.js';
import {managePages} from '../apps/protected-pages.js';
import {recordObservedFact} from '../apps/observed-metrics.js';
import {registerProject} from '../apps/project-registration.js';

const ui = '/admin/ui/novo';
const password = 'frontend lab only';
const endpoint = 'https://runtime.frontend.test';
const action = (page: Page, name: string) => page.getByRole('button', {name, exact: true});

async function fixture(test: TestContext, browserArgs?: string[]) {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root = new Pool({connectionString: process.env.TEST_DATABASE_URL});
  const schema = 'frontend_' + randomUUID().replaceAll('-', '');
  await root.query('CREATE SCHEMA ' + schema);
  const db = new Pool({connectionString: process.env.TEST_DATABASE_URL, options: '-c search_path=' + schema});
  const restricted:{roles?:Awaited<ReturnType<typeof restrictedRuntimeRoles>>; db?:Pool; gateway?:Pool}={};
  test.after(async () => {
    await restricted.db?.end();
    await restricted.gateway?.end();
    await db.end();
    try { await root.query('DROP SCHEMA ' + schema + ' CASCADE'); await restricted.roles?.drop(root); }
    finally { await root.end(); }
  });
  for (const name of (await readdir('infra')).filter(name => /^\d{3}_.*\.sql$/.test(name)).sort()) {
    await db.query((await readFile('infra/' + name, 'utf8')).replace(/^\uFEFF/, ''));
  }


  restricted.roles=await restrictedRuntimeRoles(db,schema,process.env.TEST_DATABASE_URL);
  restricted.db=new Pool({connectionString:restricted.roles.admin,options:'-c search_path='+schema});
  restricted.gateway=new Pool({connectionString:restricted.roles.publicGateway,options:'-c search_path='+schema});
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
  const server = createAdminServer(record, secret, restricted.db, () => clock).listen(0, '127.0.0.1');
  await once(server, 'listening');
  test.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({args: browserArgs});
  test.after(() => browser.close());

  return {
    db, gatewayDb:restricted.gateway, schema, origin, browser, server,
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
    await offer(page, 'Oferta Aurora', 'offer.frontend.test');

    if (width < 760) {
      await page.getByLabel('Nome da página').focus();
      await page.setViewportSize({width, height: 380});
      assert.equal(await page.locator('.bottom-nav').isHidden(), true);
    }
    await page.getByLabel('Nome da página').fill('Página inicial');
    await page.getByLabel('URL oficial da página').fill('http://offer.frontend.test/em-uso');
    await action(page, 'Continuar').click();
    await page.getByRole('status').filter({hasText: 'Informe a URL oficial da página'}).waitFor();
    const longUrl = 'offer.frontend.test/' + 'a'.repeat(2028);
    await page.getByLabel('URL oficial da página').fill(longUrl);
    await action(page, 'Continuar').click();
    await page.getByRole('status').filter({hasText: 'Informe a URL oficial da página'}).waitFor();
    await firstPage(page, 'Página inicial', 'offer.frontend.test/em-uso');
    assert.equal(await page.getByText('https://offer.frontend.test', {exact: true}).count(), 1);
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
    const code = (name: string) => page.getByRole('region', {name, exact: true}).locator('pre code');
    const scripts = await code('HEAD').innerText();
    assert.match(scripts, /src="js\/app\.[a-f0-9]{20}\.js"/);
    assert.match(scripts, /src="js\/events\.[a-f0-9]{20}\.js"/);
    assert.ok((await code('JavaScript · Bootstrap').innerText()).includes('https://runtime.frontend.test' + distributionPrefix));
    assert.match(await code('BODY').innerText(), namedDistribution ? /\/img\/pixel\.[0-9a-f]{20}\.gif/ : /\/m\.gif/);
    assert.match(await code('CSS · Canário').innerText(), namedDistribution ? /\/img\/style\.[0-9a-f]{20}\.gif/ : /\/n\.gif/);
    await page.getByLabel('Tecnologia do site').selectOption('React/Vite');
    await page.getByText(/pasta public/).waitFor();
    await page.getByLabel('Tecnologia do site').selectOption('WordPress');
    await page.getByText(/Insira os blocos HEAD e BODY/).waitFor();
    assert.equal(await code('HEAD').innerText(), scripts);
    await page.getByLabel('Tecnologia do site').selectOption('HTML');
    assert.equal(await page.getByRole('link', {name:'Abrir página oficial em nova aba'}).getAttribute('href'),
      'https://offer.frontend.test/inicio');
    const diagnose = page.getByRole('link', {name:'Ir para o diagnóstico'});
    await diagnose.focus();
    await diagnose.press('Enter');
    assert.equal(new URL(page.url()).hash, '#install-check');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'install-check');
    await page.goBack();
    assert.equal(page.url(), installation);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByText('Diagnóstico avançado e histórico de revisões', {exact: true}).click();
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

    await page.getByText('Verificador isolado sem configuração.', {exact:false}).waitFor();
    assert.equal(await action(page, 'Verificar instalação').count(), 0);
    const pageId=new URL(installation).pathname.split('/').at(-2);
    const rejection=await page.evaluate(async ({project,pageId})=>{
      const {csrf}=await fetch('/admin/ui/bootstrap').then(response=>response.json());
      const response=await fetch('/admin/ui/distribution',{method:'POST',
        headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},
        body:JSON.stringify({action:'verify',project,page:pageId})});
      return {status:response.status,body:await response.json()};
    },{project,pageId});
    assert.deepEqual(rejection,{status:400,body:{code:'ISOLATED_VERIFIER_UNAVAILABLE'}});

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
  await page.getByText('Retomar cadastro anterior', {exact: true}).waitFor();
  await page.getByRole('alert').waitFor();
  assert.equal(writes.length, 1);
  const recovered = (await lab.db.query('SELECT id FROM projects WHERE id <> $1', [earlier.id])).rows[0].id as string;
  assert.equal(recovered, writes[0].key);
  page.once('dialog', dialog => void dialog.accept());
  assert.equal((await page.reload())?.status(), 200);
  await page.getByText('Retomar cadastro anterior', {exact: true}).click();
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
  await page.getByText('Retomar cadastro anterior', {exact: true}).click();
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
  await page.getByRole('heading', {name: 'Identificar oferta'}).waitFor();
  await page.getByText('Retomar cadastro anterior', {exact: true}).click();
  await action(page, 'Consultar cadastro').click();
  await page.getByText('O cadastro ainda não aparece', {exact: false}).waitFor();
  assert.equal(await action(page, 'Usar oferta localizada').count(), 0);

  await page.getByText('Outra tentativa', {exact: true}).waitFor();
  await page.getByText('https://pending.frontend.test', {exact: true}).waitFor();
  assert.equal(await page.getByLabel('Nome da oferta').inputValue(), '');
  assert.equal(keys.length, 1);

  await page.getByLabel('Nome da oferta').fill('Outra tentativa');
  await page.getByLabel('Origem oficial').fill('https://pending.frontend.test');
  await action(page, 'Continuar').click();
  await firstPage(page, 'Página pendente', 'https://pending.frontend.test/oferta');
  await action(page, 'Cadastrar oferta e página').click();
  await page.getByRole('heading', {name: 'Instalar a proteção'}).waitFor();
  assert.equal(typeof keys[0], 'string');
  assert.deepEqual(keys, [keys[0], keys[0]]);
  assert.deepEqual((await lab.db.query('SELECT id FROM projects WHERE id <> $1', [homonym])).rows, [{id: keys[0]}]);
  assert.deepEqual((await lab.db.query('SELECT project_id FROM project_registration_audit WHERE project_id <> $1', [homonym])).rows,
    [{project_id: keys[0]}]);
  assert.equal((await lab.db.query('SELECT count(*)::int AS count FROM protected_pages')).rows[0].count, 1);
});

test('a legacy checkpoint with forgotten project data opens a usable offer form', {timeout: 60_000}, async t => {
  const lab = await fixture(t);
  const page = await lab.browser.newPage();
  await page.goto(lab.origin + ui + '/projetos');
  assert.equal(await login(page, lab.code()), 204);
  const oldIntent = randomUUID();
  await page.evaluate(intent => sessionStorage.setItem('anticlone:register:new',
    JSON.stringify({phase: 'project-write', intent, digest: 'a'.repeat(64)})), oldIntent);
  await page.getByRole('link', {name: 'Proteger oferta', exact: true}).first().click();
  await page.getByRole('heading', {name: 'Identificar oferta'}).waitFor();
  assert.equal(await action(page, 'Consultar cadastro').isVisible(), false);
  await page.getByLabel('Nome da oferta').fill('Oferta corrigida');
  await page.getByLabel('Origem oficial').fill('nova.frontend.test');
  await action(page, 'Continuar').click();
  await firstPage(page, 'Página corrigida', 'https://nova.frontend.test/oferta');
  await action(page, 'Cadastrar oferta e página').click();
  await page.getByText('Confirme que deseja iniciar outra oferta', {exact: false}).waitFor();
  assert.equal((await lab.db.query('SELECT count(*)::int n FROM projects')).rows[0].n, 0);
  await page.getByLabel('Se os dados forem diferentes', {exact: false}).check();
  await action(page, 'Cadastrar oferta e página').click();
  await page.getByRole('heading', {name: 'Instalar a proteção'}).waitFor();
  const rows = (await lab.db.query('SELECT id, name, origin FROM projects')).rows;
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].id, oldIntent);
  assert.equal(rows[0].origin, 'https://nova.frontend.test');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('anticlone:register:new')), null);
});

test('a rejected first request leaves the offer form ready to submit again', {timeout: 60_000}, async t => {
  const lab = await fixture(t);
  const page = await lab.browser.newPage();
  await page.goto(lab.origin + ui + '/projetos');
  assert.equal(await login(page, lab.code()), 204);
  await offer(page, 'Oferta com sessão renovada', 'https://session.frontend.test');
  await firstPage(page, 'Página da oferta', 'https://session.frontend.test/oferta');
  await page.route('**/admin/ui/project-create', route => route.continue({
    headers: {...route.request().headers(), 'x-csrf-token': ''},
  }), {times: 1});
  const rejection = page.waitForResponse(response => response.url().endsWith('/project-create'));
  await action(page, 'Cadastrar oferta e página').click();
  assert.equal((await rejection).status(), 403);
  await page.getByRole('alert').filter({hasText: 'não foi autorizada'}).waitFor();
  assert.equal(await page.getByText('Retomar cadastro anterior', {exact: true}).count(), 0);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('anticlone:register:new')), null);
  assert.equal((await lab.db.query('SELECT count(*)::int n FROM projects')).rows[0].n, 0);
  await action(page, 'Cadastrar oferta e página').click();
  await page.getByRole('heading', {name: 'Instalar a proteção'}).waitFor();
  assert.equal((await lab.db.query('SELECT count(*)::int n FROM projects')).rows[0].n, 1);
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
  assert.equal(session.expires, -1);

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
  await modern.getByLabel('Nome da oferta').fill('Rascunho da oferta');
  lab.advance(8 * 60 * 60_000);
  const stillActive = await fetch(lab.origin + '/admin/ui/projects', {headers: {
    'sec-fetch-site': 'same-origin', cookie: 'admin_session=' + session.value,
  }});
  assert.equal(stillActive.status, 200);
  const bootstrap = modern.waitForResponse(response => response.url().endsWith('/admin/ui/bootstrap'));
  await modern.bringToFront();
  await modern.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal((await (await bootstrap).json()).authenticated, true);
  assert.equal(await modern.getByLabel('Nome da oferta').inputValue(), 'Rascunho da oferta');
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

test('private web session remains active after 15 minutes and still supports revocation', {timeout: 60_000}, async t => {
  const lab = await fixture(t);
  const context = await lab.browser.newContext();
  const page = await context.newPage();
  await page.goto(lab.origin + ui + '/visao-geral');
  assert.equal(await login(page, lab.code()), 204);
  const overview = page.getByRole('heading', {name: 'Visão Geral', exact: true});
  await overview.waitFor();
  const session = (await context.cookies()).find(cookie => cookie.name === 'admin_session');
  assert.ok(session?.httpOnly);
  assert.equal(session.sameSite, 'Strict');
  assert.equal(session.expires, -1, 'browser-session cookie without a fixed Max-Age');

  lab.advance(8 * 60 * 60_000);
  await page.reload();
  await overview.waitFor();
  await action(page, 'Sair da sessão').click();
  await action(page, 'Sair').click();
  await page.getByRole('heading', {name: 'Entre no seu espaço'}).waitFor();
  assert.equal((await fetch(lab.origin + '/admin/ui/projects', {headers: {
    'sec-fetch-site': 'same-origin', cookie: 'admin_session=' + session.value,
  }})).status, 401);

  const bearer = await fetch(lab.origin + '/admin/login', {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({password, code: lab.code()})});
  assert.equal(bearer.status, 200);
  const {token, expiresIn} = await bearer.json();
  assert.equal(expiresIn, 900);
  lab.advance(900_000);
  assert.equal((await fetch(lab.origin + '/admin/session', {headers: {authorization: 'Bearer ' + token}})).status, 401);
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
      return receiveCommerce(lab.gatewayDb, account.id, raw, timestamp, signature, checkoutEnv);
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
      if (focus) await page.getByRole('heading', {name: focus, exact: true}).evaluate(element => {
        window.scrollBy(0, element.getBoundingClientRect().top - 15);
      });
      else await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({path: join(folder, name + '.png'), animations: 'disabled', fullPage: width < 760 && ['02-investigacao', '06-estimativa'].includes(name)});
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
    const alert = page.locator('section').filter({has: page.getByRole('heading', {name: 'Alerta por e-mail'})});
    await alert.getByText('Aguardando envio', {exact: true}).waitFor();
    await alert.getByText('Tentativas de envio · 0', {exact: true}).waitFor();
    assert.equal(await alert.getByRole('link', {name: 'Ver configurações de SMTP'}).getAttribute('href'),
      ui + '/configuracoes/notificacoes');
    await page.getByLabel('Página protegida').selectOption(lp.page);
    await page.getByLabel('Nova situação').selectOption('investigating');
    await page.getByLabel('Justificativa').fill('Revisão administrativa no ambiente de teste');
    await action(page, 'Revisar mudança').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Não verificado → Em investigação').waitFor();
    await page.getByText('Histórico de recibos da LP', {exact: true}).click();
    await action(page, 'Consultar histórico').click();
    await page.getByText('Nenhum recibo no recorte.').waitFor();
    await page.getByText('Situação da investigação · Em investigação', {exact:true}).waitFor();
    await page.getByText('Indeterminado · evidência insuficiente', {exact:true}).waitFor();
    await capture('02-investigacao');
    await page.getByRole('link', {name: 'Redirecionar página', exact: true}).click();
    await page.getByRole('heading', {name: 'Redirecionar página', exact: true}).waitFor();
    await page.getByText('Configuração anterior da LP', {exact:true}).click();
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
    const summary = page.getByRole('region', {name:'Estado e escopo da proteção'});
    await summary.getByText('Autorização corresponde à aprovação consultada.', {exact:false}).waitFor();
    await summary.getByText(observedDomain + '/evidencia · revisão 1', {exact:true}).waitFor();
    await capture('03-redirecionamento', 'Estado e escopo da proteção');

    await page.getByLabel('Destino da página').fill(original + '/rascunho');
    await action(page, 'Suspender autorização').click();
    await action(page, 'Confirmar').click();
    await summary.getByText('Autorização suspensa.', {exact:true}).waitFor();
    await action(page, '← Voltar para investigação').click();
    await action(page, 'Cancelar').click();
    assert.equal(await page.getByLabel('Destino da página').inputValue(), original + '/rascunho');
    await action(page, '← Voltar para investigação').click();
    await action(page, 'Descartar e sair').click();
    await page.getByRole('link', {name: 'Substituir checkout/CTA', exact: true}).click();
    await page.getByRole('heading', {name: 'Substituir checkout/CTA', exact: true}).waitFor();
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
    await action(page, 'Revisar destinos e mapeamentos no inventário').click();
    assert.equal(await page.getByRole('region', {name:'Pontos de conversão'}).evaluate(element => document.activeElement === element), true);
    await page.getByText('Âncora mapeada a destino aprovado', {exact:true}).waitFor();
    await page.getByText('Destino aprovado · ' + original + '/seguro', {exact:true}).waitFor();
    await capture('04-inventario-cta', 'Pontos de conversão');
    await capture('09-checkout-destinos', 'CTAs e destinos da LP');
    await page.getByLabel('principal · versão 1', {exact:true}).check();
    await action(page, 'Revisar aprovação').click();
    await page.getByRole('dialog', {name:'Aprovar versões na LP'}).waitFor();
    await action(page, 'Confirmar').click();
    await page.getByText('Aprovação registrada.', {exact:false}).waitFor();
    await page.getByLabel('Origem HTTPS observada').fill(observedDomain);
    await page.getByLabel('Caminho exato da cópia').fill('/evidencia');
    await action(page, 'Revisar autorização').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Autorização registrada. Revisão 3.').waitFor();
    assert.equal((await lab.db.query('SELECT count(*)::int AS n FROM page_entry_policy_bindings')).rows[0].n, 1);
    assert.equal((await lab.db.query('SELECT count(*)::int AS n FROM page_cta_policy_bindings')).rows[0].n, 1);
    await summary.getByText('Redirecionamento v1, principal v1 · aprovação', {exact:false}).waitFor();
    await capture('05-substituicao-cta', 'Estado e escopo da proteção');
    await action(page, '← Voltar para investigação').click();
    await action(page, '← Voltar para Incidentes').click();
    assert.equal(page.url(), incidentsUrl);
    assert.equal(await page.getByLabel('Buscar domínio').inputValue(), 'observado');
    assert.equal(await page.getByLabel('Período').inputValue(), '7');

    const base = lab.origin + ui + '/projetos/' + project.id + '/lps/' + lp.page + '/conversoes';
    assert.equal((await page.goto(base + '?dias=1'))?.status(), 200);
    await page.getByRole('link', {name:'Configurar estimativa'}).click();
    await page.getByLabel('Ticket médio', {exact:true}).fill('100,00');
    await page.getByLabel('Conversão estimada (%)').fill('5');
    await action(page, 'Revisar e salvar').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Estimativa configurada. Versão 1', {exact:false}).waitFor();
    const estimate = page.getByRole('region', {name:'Resultado da estimativa'});
    await estimate.getByText('1 × 5,00% × R$ 100,00', {exact:true}).waitFor();
    await estimate.getByText('Estimativa, não vendas confirmadas', {exact:true}).waitFor();
    await estimate.getByText('R$ 5,00', {exact:true}).waitFor();
    await estimate.getByText('Versão 1', {exact:false}).waitFor();
    assert.equal(await estimate.getByText('Receita recuperada comprovada').count(), 0);
    await capture('06-estimativa', 'Moeda, ticket e conversão');
    await action(page, '← Voltar para Conversões').click();
    await page.getByText('R$ 5,00', {exact:true}).waitFor();
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
    await page.getByText('1 venda · R$ 89,00', {exact:true}).waitFor();
    await page.getByText('R$ 5,00', {exact:true}).waitFor();
    await capture('07-conversoes');

    const incidentId = (await lab.db.query('SELECT id FROM incidents WHERE project_id=$1',[project.id])).rows[0].id;
    const wrongPage = lab.origin + ui + '/projetos/' + project.id + '/incidentes/' + incidentId + '/substituir-cta?lp=' + other.page;
    assert.equal((await page.goto(wrongPage))?.status(), 200);
    await page.getByRole('heading', {name:'Substituir checkout/CTA',exact:true}).waitFor();
    await page.getByLabel('Superfície de CTA').fill('principal');
    await page.getByLabel('Habilitar nesta versão').check();
    await action(page, 'Revisar publicação').click();
    await page.getByRole('alert').filter({hasText:'A superfície está vinculada a outra LP.'}).waitFor();
    assert.equal((await lab.db.query('SELECT count(*)::int AS n FROM cta_policy_versions')).rows[0].n, 1);
    assert.deepEqual(errors, []);
  });
}

for (const width of [1440, 390]) {
  test('overview, SMTP, commercial catalog and lifecycle at ' + width + ' px', {timeout: 100_000}, async t => {
    const lab = await fixture(t);
    const original = 'https://curso.frontend.test';
    const project = await registerProject(lab.db, {name: 'Curso Horizonte', origin: original});
    const lp = await managePages(lab.db, {project: project.id, action: 'create', name: 'Oferta principal', url: original + '/oferta'}) as {page: string};
    await observe(lab.db, project.id, original, 'https://sinal.frontend.test');
    await recordObservedFact(lab.db, project.id, {page: lp.page, event: randomUUID(), session: 'ca'.repeat(16),
      action: 'CTA_CLICK_OBSERVED', traffic: 'DIRECT_UNKNOWN', version: null, evidence: 'BROWSER_UNVERIFIED'});
    await lab.db.query("INSERT INTO estimate_assumptions(project_id,version,ticket_minor,conversion_basis_points,currency) VALUES($1,1,12000,500,'BRL')", [project.id]);
    await recordObservedFact(lab.db, project.id, {page: lp.page, event: randomUUID(), session: 'ca'.repeat(16),
      action: 'SESSION_OBSERVED', traffic: 'DIRECT_UNKNOWN', version: null, evidence: 'BROWSER_UNVERIFIED'});
    const checkoutEnv = process.env.COMMERCE_ENCRYPTION_KEY;
    process.env.COMMERCE_ENCRYPTION_KEY = 'cd'.repeat(32);
    t.after(() => {
      if (checkoutEnv === undefined) delete process.env.COMMERCE_ENCRYPTION_KEY;
      else process.env.COMMERCE_ENCRYPTION_KEY = checkoutEnv;
    });
    const context = await lab.browser.newContext({viewport: {width, height: width < 760 ? 844 : 1000}, hasTouch: width < 760, isMobile: width < 760});
    const page = await context.newPage();
    const errors: string[] = [];
    const foreign: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {if (!request.url().startsWith(lab.origin + '/')) foreign.push(request.url());});
    const captureRoot = process.env.TEST_FRONTEND_C_CAPTURES;
    async function capture(name: string, heading?: string) {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (!captureRoot) return;
      const folder = join(captureRoot, width < 760 ? 'mobile' : 'desktop');
      await mkdir(folder, {recursive: true});
      if (heading) await page.getByRole('heading', {name:heading, exact:true}).evaluate(node =>
        window.scrollBy(0, node.getBoundingClientRect().top - 20));
      else await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({path: join(folder, name + '.png'), animations: 'disabled'});
    }

    assert.equal((await page.goto(lab.origin + ui + '/visao-geral'))?.status(), 200);
    assert.equal(await login(page, lab.code()), 204);
    await page.getByRole('heading', {name:'Visão Geral'}).waitFor();
    await page.getByText('R$ 6,00', {exact:true}).waitFor();
    await page.getByText('Estimativa por projeto', {exact:true}).click();
    const finance = page.getByRole('region', {name:'Detalhamento das estimativas'});
    await finance.getByText('R$ 120,00 · 5% · v1', {exact:true}).waitFor();
    await finance.getByText('Estimativa R$ 6,00', {exact:true}).waitFor();
    await page.getByText('Saúde, instalações e investigações', {exact:true}).click();
    await page.getByRole('link', {name:'sinal.frontend.test'}).waitFor();
    await page.getByText('1 LP habilitada e ativa no cadastro', {exact:false}).waitFor();
    await page.getByText('1 possível cópia detectada', {exact:true}).waitFor();
    await page.getByLabel('Período').selectOption('1');
    await page.getByRole('combobox', {name:/^Projeto/}).selectOption(project.id);
    await page.getByLabel('LP para diagnóstico').selectOption(lp.page);
    await page.getByText('Pronta para publicar', {exact:true}).waitFor();
    await page.getByText('0 alertas no recorte de revisão', {exact:true}).waitFor();
    await capture('01-visao-geral');
    await page.getByRole('combobox', {name:'Métrica', exact:true}).selectOption('CTA_CLICK_OBSERVED');
    await page.getByLabel('Origem declarada').selectOption('DIRECT_UNKNOWN');
    const chart = page.getByRole('img', {name:/Cliques nos CTAs por dia em UTC/});
    assert.equal(await chart.locator('circle[data-count="1"]').count(), 1);
    await capture('13-grafico', 'Atividade observada');
    await action(page, 'Tabela').click();
    await page.getByRole('region', {name:'Atividade observada'}).getByRole('table').getByRole('cell', {name: '1', exact: true}).waitFor();
    assert.equal(await finance.count(), 0);
    await page.getByRole('region', {name:'Configuração da estimativa'}).getByText('R$ 120,00', {exact:true}).waitFor();
    const traffic = page.getByRole('region', {name:'Origem do tráfego'});
    assert.equal(await traffic.getByRole('meter', {name:'Direto ou desconhecido'}).getAttribute('value'), '1');
    for (const viewport of [360, 768, 1024, 1920]) {
      await page.setViewportSize({width: viewport, height: 844});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'reflow at ' + viewport);
    }
    await page.setViewportSize({width, height: width < 760 ? 844 : 1000});
    await capture('10-atividade', 'Atividade observada');
    await capture('02-instalacoes-alertas', 'Instalações e alertas');
    await page.getByRole('link', {name:'Administrar oferta'}).click();
    await action(page, 'Pausar projeto').click();
    await action(page, 'Confirmar').click();
    await action(page, 'Reativar projeto').click();
    await action(page, 'Confirmar').click();
    await action(page, 'Pausar projeto').waitFor();
    await page.getByText('Arquivar projeto', {exact:true}).click();
    await page.getByLabel('Justificativa', {exact:true}).fill('Arquivar projeto de laboratório');
    await action(page, 'Revisar mudança de estado').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Exclusão lógica do projeto', {exact:true}).click();
    await action(page, 'Consultar impacto').click();
    await action(page, 'Confirmar').click();
    const confirmProject = project.id + ':' + project.name;
    await page.getByLabel('Confirmação exata').fill(confirmProject);
    await page.getByRole('button', {name:'Revisar exclusão', exact:true}).locator('..').getByLabel('Justificativa').fill('Exclusão reversível de teste');
    await action(page, 'Revisar exclusão').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Excluído', {exact:true}).waitFor();
    await page.getByText('Consultar bloqueios da purga física', {exact:true}).click();
    await page.getByText('project_lifecycle_audit', {exact:false}).first().waitFor();
    const restore = page.locator('details').filter({has: page.getByText('Restaurar projeto', {exact:true})});
    if (!await restore.getByLabel('Justificativa').isVisible()) await restore.getByText('Restaurar projeto', {exact:true}).click();
    await restore.getByLabel('Justificativa').fill('Restaurar cadastro de laboratório');
    await action(page, 'Revisar mudança de estado').click();
    await action(page, 'Confirmar').click();
    await action(page, 'Reativar projeto').waitFor();
    assert.deepEqual((await lab.db.query('SELECT lifecycle_state,deleted_at FROM projects WHERE id=$1',[project.id])).rows,
      [{lifecycle_state:'PAUSED',deleted_at:null}]);
    await action(page, 'Consultar histórico de cadastro').click();
    await page.getByText('Registros de cadastro', {exact:true}).waitFor();
    await capture('03-gestao-projeto', 'Gestão do projeto');
    await page.getByRole('link', {name:'Abrir página', exact:true}).click();
    await action(page, 'Pausar LP').click();
    await action(page, 'Confirmar').click();
    await action(page, 'Reativar LP').click();
    await action(page, 'Confirmar').click();
    await page.getByLabel('Nova URL autorizada').fill(original + '/variacao');
    await action(page, 'Revisar nova URL').click();
    await action(page, 'Confirmar').click();
    await page.getByRole('button', {name:'Remover URL', exact:true}).first().waitFor();
    await page.getByRole('status').filter({hasText:/^URL autorizada para a LP\.$/}).waitFor();
    assert.equal(await page.getByText('undefined · alteração registrada.', {exact:true}).count(), 0);
    await capture('04-gestao-lp', 'Gestão da LP');
    await page.getByRole('listitem').filter({hasText:original + '/variacao Remover URL'}).getByRole('button', {name:'Remover URL'}).click();
    await action(page, 'Confirmar').click();
    await action(page, 'Remover URL').first().waitFor({state:'hidden'});
    await page.getByRole('status').filter({hasText:/^URL removida da LP\.$/}).waitFor();
    assert.equal(await page.getByText('undefined · alteração registrada.', {exact:true}).count(), 0);
    await page.getByText('Exclusão da LP', {exact:true}).click();
    await action(page, 'Consultar impacto').click();
    await action(page, 'Confirmar').click();
    await page.getByLabel('Confirmação exata').fill('DELETE PAGE ' + project.id + '/' + lp.page + '/Oferta principal');
    await page.getByLabel('Justificativa', {exact:true}).fill('Encerrar LP sintética de laboratório');
    await action(page, 'Revisar exclusão').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Excluído', {exact:true}).waitFor();
    assert.ok((await lab.db.query('SELECT deleted_at FROM protected_pages WHERE id=$1',[lp.page])).rows[0].deleted_at);

    await page.getByRole('link', {name:'Configurações',exact:true}).click();
    await page.getByRole('combobox', {name:/^Provedor/}).selectOption('smtp');
    await page.getByLabel('Host SMTP').fill('smtp.frontend.test');
    await page.getByLabel('Porta').fill('465');
    await page.getByRole('combobox', {name:/^TLS/}).selectOption('implicit');
    await page.getByLabel('Remetente').fill('origem@frontend.test');
    await page.getByLabel('Destinatário').fill('destino@frontend.test');
    await action(page, 'Revisar configuração SMTP').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Configuração SMTP salva.', {exact:true}).waitFor();
    await page.getByText('Ambiente privado sem SMTP configurado', {exact:true}).waitFor();
    assert.equal(await action(page, 'Ativar alertas').isDisabled(), true);
    await capture('05-notificacoes', 'Notificações e SMTP');
    await page.getByLabel('Projeto dos alertas').selectOption(project.id);
    const alert = (await lab.db.query('SELECT id::text FROM alert_outbox')).rows[0].id;
    await page.getByText(/^CLONE · /).click();
    await capture('06-revisao-alertas', 'Alertas em revisão');
    await page.getByLabel('Ação de revisão').selectOption('CANCEL');
    await page.getByLabel('Digite CLONE:' + alert).fill('CLONE:' + alert);
    await page.getByLabel('Justificativa').fill('Cancelar tentativa sintética em revisão');
    await action(page, 'Revisar ação de alerta').click();
    await page.getByText('Um envio já admitido pelo transporte ainda pode concluir.').waitFor();
    await action(page, 'Confirmar').click();
    await page.getByText('Nenhum alerta em revisão no recorte retornado.').waitFor();
    assert.ok((await lab.db.query('SELECT expired_at FROM alert_outbox WHERE id=$1',[alert])).rows[0].expired_at);

    await page.getByRole('link', {name:'Integrações', exact:true}).click();
    await page.getByText('Criar ou versionar modelo', {exact:true}).click();
    const editor = page.getByRole('combobox', {name:'Editor do modelo', exact:true});
    await editor.selectOption('json');
    await page.getByLabel('Configuração do modelo (JSON)').waitFor();
    await editor.selectOption('guided');
    await page.getByLabel('Identificador do modelo').fill('Modelo-Horizonte');
    await page.getByLabel('Caminho · Produto', {exact:true}).fill('product');
    await page.getByLabel('Amostra sintética (JSON)').fill(JSON.stringify({
      event:'e1', order:'o1', amount:'19.99', currency:'BRL', status:'paid', occurred:new Date().toISOString(), product:'p1',
    }));
    assert.equal(await page.getByLabel('Modelo para editar').isDisabled(), true);
    assert.equal(await editor.isDisabled(), true);
    await action(page, 'Testar modelo').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Resultado sanitizado', {exact:true}).waitFor();
    await action(page, 'Revisar aprovação do modelo').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Modelo-Horizonte', {exact:true}).waitFor();
    await capture('07-modelos', 'Integrações comerciais');
    await page.getByText('Cadastrar conta', {exact:true}).click();
    await page.getByLabel('Identificador da conta').fill('Checkout-Horizonte');
    await page.getByLabel('Modelo aprovado').selectOption({label:'Modelo-Horizonte · v1'});
    await action(page, 'Revisar conta de checkout').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Checkout-Horizonte · Em teste', {exact:true}).waitFor();
    await page.getByText('Webhook e manutenção', {exact:true}).click();
    assert.equal(await action(page, 'Ativar conta').isDisabled(), true);
    await page.getByText(/\/commerce-webhook\//).waitFor();
    await capture('08-contas-webhooks', 'Contas e webhooks');
    await action(page, 'Desativar conta').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Checkout-Horizonte · Inativa', {exact:true}).waitFor();
    const modelRow = (await lab.db.query('SELECT id, name, config FROM commerce_models WHERE version=1')).rows[0];
    const account = (await lab.db.query('SELECT id FROM commerce_connections')).rows[0].id as string;
    const sample = {event:'e2', order:'o2', amount:'19.99', currency:'BRL', status:'paid', occurred:new Date().toISOString(), product:'p2'};
    await commerceAdmin(lab.db, {action:'model', id:modelRow.id, name:modelRow.name, config:modelRow.config, sample,
      expected_version:1, reviewed:true});
    await action(page, 'Atualizar catálogo').click();
    await page.getByText('Migração de formato', {exact:true}).click();
    async function prepareMigration() {
      await page.getByLabel('Nova versão do modelo').selectOption('2');
      await page.getByLabel('Amostra do formato atual (JSON)').fill(JSON.stringify(sample));
      await page.getByLabel('Amostra do novo formato (JSON)').fill(JSON.stringify(sample));
      await action(page, 'Revisar preparação').click();
      await action(page, 'Confirmar').click();
      await page.getByText('Aguarda teste autenticado para esta versão.', {exact:false}).waitFor();
      assert.equal(await action(page, 'Confirmar migração').isDisabled(), true);
    }
    await prepareMigration();
    await action(page, 'Cancelar migração').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Migração cancelada.', {exact:true}).waitFor();
    await prepareMigration();
    const key = await provisionCommerceSender(lab.db, account, process.env);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const raw = Buffer.from(JSON.stringify(sample));
    const format = {version:2,test:true};
    const signature = createHmac('sha256', Buffer.from(key, 'hex')).update(commerceSigningInput(timestamp, raw, format)).digest('hex');
    const handle = commerceWebhook(lab.gatewayDb);
    const receiver = createServer((req, res) => { if (!handle(req, res)) res.writeHead(404).end(); }).listen(0, '127.0.0.1');
    await once(receiver, 'listening');
    t.after(() => new Promise<void>(resolve => { receiver.close(() => resolve()); receiver.closeAllConnections(); }));
    const webhook = await fetch('http://127.0.0.1:' + (receiver.address() as AddressInfo).port + '/commerce-webhook/' + account, {
      method: 'POST', body: raw, headers: {'Content-Type': 'application/json', 'X-Checkout-Timestamp': timestamp,
        'X-Checkout-Signature': signature, 'X-Checkout-Model-Version': String(format.version), 'X-Checkout-Test': '1'},
    });
    assert.equal(webhook.status, 200);
    assert.equal((await webhook.json()).recorded, false);
    await action(page, 'Atualizar catálogo').click();
    await action(page, 'Confirmar migração').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Migração confirmada.', {exact:true}).waitFor();
    assert.equal((await lab.db.query('SELECT model_version FROM commerce_connections WHERE id=$1',[account])).rows[0].model_version, 2);
    await capture('11-migracao-formato');

    assert.equal((await page.goto(lab.origin + ui + '/projetos/' + project.id + '/checkouts'))?.status(), 200);
    await page.getByText('Vincular checkout', {exact:true}).click();
    await page.getByLabel('Conta de checkout').selectOption(account);
    await page.getByLabel('Produto', {exact:true}).fill('checkout-sem-lp');
    await page.getByLabel('URL do checkout').fill(original + '/checkout');
    await page.getByLabel('Preço de referência').fill('19,99');
    await page.getByLabel('Moeda do checkout').selectOption('BRL');
    await action(page, 'Revisar vínculo comercial').click();
    await action(page, 'Confirmar').click();
    await page.getByText('Vínculo salvo. Versão 1.', {exact:true}).waitFor();
    assert.deepEqual((await lab.db.query('SELECT page_id,product FROM commerce_bindings WHERE project_id=$1',[project.id])).rows,
      [{page_id:null, product:'checkout-sem-lp'}]);
    await page.getByText('Vendas do receptor HMAC legado', {exact:true}).click();
    await page.getByText('Nenhuma venda registrada neste receptor.', {exact:true}).waitFor();
    await capture('12-checkout-projeto');
    await page.getByRole('navigation',{name:'Navegação principal'}).filter({visible:true}).getByRole('link',{name:'Configurações'}).click();
    await page.getByRole('link', {name:'Saúde e operações', exact:true}).click();
    await page.getByRole('heading', {name:'Saúde do ambiente'}).waitFor();
    await page.getByText('Gateway local sem sonda',{exact:true}).waitFor();
    await page.getByText('Respondendo',{exact:true}).waitFor();
    await page.getByRole('combobox',{name:'Projeto',exact:true}).selectOption(project.id);
    await page.getByText('Habilite a coleta da origem principal',{exact:false}).waitFor();
    await page.getByText('Histórico de saúde',{exact:true}).click();
    await page.getByText('Sem ocorrências registradas para este projeto.',{exact:true}).waitFor();
    await page.getByText('Procedimento de backup e restauração',{exact:true}).click();
    await page.getByText('docs/POSTGRES-RECOVERY.md', {exact: true}).waitFor();
    await capture('09-operacoes');
    assert.deepEqual(errors, []);
    assert.deepEqual(foreign, []);
  });
}

test('React provisions an original LP and copy, then real gateway applies scoped redirect and independent CTAs',
  {timeout: 90_000}, async t => {
    const shutdown: {gateway?: () => Promise<void>} = {};
    // Stop the writer before the fixture drops its database schema.
    t.after(() => shutdown.gateway?.());
    const lab = await fixture(t, ['--no-proxy-server', '--host-resolver-rules=MAP *.integration.test 127.0.0.1']);
    const directory = await mkdtemp(join(tmpdir(), 'anticlone-react-dev-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', join(directory, 'key'), '-out', join(directory, 'cert'), '-subj', '/CN=integration.test'], {stdio: 'ignore'});

    const reservation = createServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const backendPort = (reservation.address() as AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));

    const oldProbe = process.env.ADMIN_GATEWAY_HEALTH_PORT;
    process.env.ADMIN_GATEWAY_HEALTH_PORT = String(backendPort);
    t.after(() => {
      if (oldProbe === undefined) delete process.env.ADMIN_GATEWAY_HEALTH_PORT;
      else process.env.ADMIN_GATEWAY_HEALTH_PORT = oldProbe;
    });

    let head = '', bodyCode = '';
    const files = new Map<string, {code: string; type: string}>();
    const tls = createTlsServer({key: await readFile(join(directory, 'key')), cert: await readFile(join(directory, 'cert'))}, (req, res) => {
      const host = req.headers.host?.split(':')[0];
      if (host === 'gateway.integration.test') {
        const upstream = request({hostname: '127.0.0.1', port: backendPort, path: req.url, method: req.method,
          headers: req.headers}, result => { res.writeHead(result.statusCode ?? 502, result.headers); result.pipe(res); });
        upstream.on('error', () => res.writeHead(502).end());
        req.pipe(upstream);
        return;
      }
      if (!['original.integration.test', 'copia.integration.test'].includes(host ?? '') || req.method !== 'GET') {
        res.writeHead(404).end();
        return;
      }
      const file = files.get(req.url ?? '');
      if (file) { res.writeHead(200, {'content-type': file.type}).end(file.code); return; }
      const body = req.url === '/lp' ? `<!doctype html><head>${head}</head><body>
        <main data-anticlone-surface="landing">
          <h1>${host === 'original.integration.test' ? 'LP original' : 'Cópia controlada'}</h1>
          <a data-anticlone-point="checkout01" href="/checkout-nativo">Comprar</a>
          <a data-anticlone-point="contato01" href="/contato-nativo">Contato</a>
        </main>${bodyCode}</body>` : '<h1>Destino controlado</h1>';
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8'}).end(body);
    }).listen(0, '127.0.0.1');
    await once(tls, 'listening');
    t.after(() => new Promise<void>(resolve => { tls.close(() => resolve()); tls.closeAllConnections(); }));
    const sitePort = (tls.address() as AddressInfo).port;
    const original = 'https://original.integration.test:' + sitePort;
    const copy = 'https://copia.integration.test:' + sitePort;
    const gatewayOrigin = 'https://gateway.integration.test:' + sitePort;
    const candidates = [{marker: 'checkout01', native: '/checkout-nativo', target: '/checkout-aprovado'},
      {marker: 'contato01', native: '/contato-nativo', target: '/contato-aprovado'}];
    const captureSite = createServer((req, res) => {
      const file = files.get(req.url ?? '');
      if (file) { res.writeHead(200, {'content-type': file.type}).end(file.code); return; }
      res.writeHead(200, {'content-type': 'text/html'}).end(
      '<!doctype html><head>' + head + '</head><body><main data-anticlone-surface="landing">' + candidates.map(point =>
        '<a data-anticlone-point="' + point.marker + '" href="' + copy + point.native + '">' + point.marker + '</a>').join('') + '</main>' + bodyCode + '</body>');
    }).listen(0, '127.0.0.1');
    await once(captureSite, 'listening');
    t.after(() => new Promise<void>(resolve => { captureSite.close(() => resolve()); captureSite.closeAllConnections(); }));
    const captureOrigin = 'http://127.0.0.1:' + (captureSite.address() as AddressInfo).port;
    process.env.RUNTIME_PUBLIC_ORIGIN = gatewayOrigin;
    const gateway = spawn(process.execPath, ['dist/apps/server.js'], {env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL, PGOPTIONS: '-c search_path=' + lab.schema,
      PORT: String(backendPort), GATEWAY_MODE: 'OPERATIONAL', SMTP_PORT: '1',
    }, stdio: ['ignore', 'ignore', 'pipe']});
    let gatewayOutput = '';
    gateway.stderr.on('data', chunk => { gatewayOutput += String(chunk); });
    const closed = once(gateway, 'exit');
    shutdown.gateway = async () => { gateway.kill(); await closed; };
    async function until(check: () => Promise<boolean>, label: string) {
      for (let attempt = 0; attempt < 80; attempt++) {
        if (await check()) return;
        await delay(100);
      }
      assert.fail(label + '\n' + gatewayOutput);
    }
    await until(async () => {
      const response = await fetch('http://127.0.0.1:' + backendPort + '/healthz').catch(() => undefined);
      return response?.ok === true && (await response.json()).mode === 'OPERATIONAL';
    }, 'gateway Dev em loopback');

    const context = await lab.browser.newContext({viewport: {width: 1440, height: 900}, ignoreHTTPSErrors: true});
    const allowed = new Set([lab.origin, original, copy, gatewayOrigin, captureOrigin]);
    await context.route('**/*', route => allowed.has(new URL(route.request().url()).origin) ? route.continue() : route.abort());
    await context.grantPermissions(['local-network-access'], {origin: copy});
    await context.grantPermissions(['local-network-access'], {origin: original});
    await context.grantPermissions(['local-network-access'], {origin: captureOrigin});
    const panel = await context.newPage();
    const captureRoot = process.env.TEST_FRONTEND_INTEGRATED_CAPTURES;
    async function capture(page: Page, name: string) {
      if (!captureRoot) return;
      await mkdir(captureRoot, {recursive: true});
      await page.screenshot({path: join(captureRoot, name + '.png'), animations: 'disabled'});
      const viewport = page.viewportSize();
      if (viewport) {
        await page.setViewportSize({width:390,height:844});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile reflow: ' + name);
        await page.screenshot({path: join(captureRoot, name + '-mobile.png'), animations: 'disabled'});
        await page.setViewportSize(viewport);
      }
    }
    const confirm = async (button: string, result: string | RegExp) => {
      await action(panel, button).click();
      await action(panel, 'Confirmar').click();
      await panel.getByText(result, {exact: true}).waitFor();
    };
    await panel.goto(lab.origin + ui);
    await capture(panel, '01-login');
    assert.equal(await login(panel, lab.code()), 204);
    await panel.getByRole('heading', {name: 'Meus Projetos'}).waitFor();
    await capture(panel, '02-projetos');
    await offer(panel, 'Oferta Dev integrada', original);
    await capture(panel, '03-cadastro-lp');
    await firstPage(panel, 'Página de vendas', original + '/lp');
    await action(panel, 'Cadastrar oferta e página').click();
    await panel.getByRole('heading', {name: 'Instalar a proteção'}).waitFor();
    const installation = panel.url();
    const ids = (await lab.db.query('SELECT project_id AS project, id AS page FROM protected_pages')).rows[0];
    assert.ok(ids?.project && ids.page);
    await confirm('Publicar endereços de instalação', 'Revisão 1');
    head = await panel.getByRole('region', {name: 'HEAD', exact: true}).locator('pre code').innerText();
    bodyCode = await panel.getByRole('region', {name: 'BODY', exact: true}).locator('pre code').innerText();
    assert.match(head, /<script async="" src="js\/app\.[a-f0-9]{20}\.js">/);
    for (const [name, type] of [['JavaScript · Bootstrap', 'application/javascript'],
      ['JavaScript · Fallback', 'application/javascript'], ['CSS · Canário', 'text/css']]) {
      const block = panel.getByRole('region', {name, exact: true});
      const path = await block.locator('p code').innerText();
      files.set('/' + path, {code: await block.locator('pre code').innerText(), type});
    }
    await capture(panel, '04-instalacao-publicada');

    const visit = await context.newPage();
    const paths = [
      /\/(?:a|app\.[a-f0-9]{20})\.js$/,
      /\/(?:b|common\.[a-f0-9]{20})\.js$/,
      /\/(?:c|events\.[a-f0-9]{20})\.js$/,
      /\/(?:m|pixel\.[a-f0-9]{20})\.gif$/,
      /\/(?:n|style\.[a-f0-9]{20})\.gif$/,
    ];
    const responses = paths.map(path => visit.waitForResponse(response =>
      response.ok() && response.url().startsWith(gatewayOrigin + '/') && path.test(new URL(response.url()).pathname)));
    await visit.goto(original + '/lp');
    await Promise.all(responses);
    await visit.getByRole('heading', {name: 'LP original'}).waitFor();
    await until(async () => (await lab.db.query('SELECT count(*)::int n FROM page_installation_signals')).rows[0].n >= 2,
      'Core e Fallback da LP original');
    assert.equal((await lab.db.query('SELECT count(*)::int n FROM incidents')).rows[0].n, 0);
    await visit.goto(copy + '/lp');
    await visit.getByRole('heading', {name: 'Cópia controlada'}).waitFor();
    await until(async () => (await lab.db.query('SELECT count(*)::int n FROM observation_source_days WHERE host=$1',
      ['copia.integration.test'])).rows[0].n >= 2, 'detecção pelo gateway');
    await visit.reload();
    assert.equal((await lab.db.query('SELECT count(*)::int n FROM incidents')).rows[0].n, 1);
    await capture(visit, '05-copia-controlada');

    await panel.getByRole('navigation', {name: 'Navegação principal'}).filter({visible: true}).getByRole('link', {name: 'Incidentes'}).click();
    // The copied LP has receipts, so it appears under the contextual LP filter.
    await panel.getByRole('link', {name: 'Investigar copia.integration.test'}).click();
    await panel.getByRole('heading', {name: 'copia.integration.test', exact: true}).waitFor();
    await panel.getByLabel('Página protegida').selectOption(ids.page);
    await panel.getByLabel('Nova situação').selectOption('investigating');
    await panel.getByLabel('Justificativa').fill('Cópia controlada do ensaio Dev');
    await confirm('Revisar mudança', 'Situação atualizada.');
    const history = panel.locator('details').filter({has: panel.getByText('Histórico de recibos da LP', {exact: true})});
    await history.getByText('Histórico de recibos da LP', {exact: true}).click();
    await action(panel, 'Consultar histórico').click();
    await history.getByText('gateway', {exact:false}).waitFor();
    await panel.getByText('Evidência de acesso à LP original', {exact: true}).click();
    await panel.getByLabel('Fonte do log').selectOption('owned_access_log');
    await panel.getByLabel('Tipo de recurso').selectOption('HTML');
    await panel.getByLabel('Tenho autorização para usar este log.').check();
    await confirm('Revisar evidência', 'Evidência registrada como declaração administrativa.');
    await action(panel, 'Atualizar recibos').click();
    await history.getByText('administrator_import', {exact:false}).waitFor();
    assert.equal((await lab.db.query("SELECT count(*)::int n FROM investigation_receipts WHERE kind='original_request'")).rows[0].n, 1);
    await capture(panel, '06-investigacao');

    await panel.getByRole('link', {name: 'Redirecionar página', exact: true}).click();
    await panel.getByText('Configuração anterior da LP', {exact:true}).click();
    await panel.getByLabel('Destino da página').fill(original + '/segura');
    await panel.getByRole('combobox', {name:'Direto ou desconhecido', exact:true}).selectOption('100');
    await panel.getByLabel('Habilitar nesta versão').check();
    await confirm('Revisar publicação', 'Política publicada. Versão 1.');
    await panel.getByLabel('Versão de redirecionamento').selectOption('1');
    await confirm('Revisar aprovação', /^Aprovação registrada\./);
    async function authorize(revision: number) {
      await panel.getByLabel('Origem HTTPS observada').fill(copy);
      await panel.getByLabel('Caminho exato da cópia').fill('/lp');
      await confirm('Revisar autorização', 'Autorização registrada. Revisão ' + revision + '.');
    }
    await authorize(1);
    // This is an effect assertion. GS06 separately measures the real deadline.
    const redirected = await context.newPage();
    const browserTime = Date.now();
    await redirected.clock.install({time: browserTime - 60_000});
    await redirected.clock.pauseAt(browserTime);
    await redirected.goto(copy + '/lp');
    await redirected.waitForURL(original + '/segura');
    await redirected.close();

    await action(panel, '← Voltar para investigação').click();
    await panel.getByRole('link', {name: 'Abrir Página de vendas na oferta'}).click();
    await panel.getByRole('link', {name: 'Políticas de proteção'}).click();
    assert.equal((await panel.reload())?.status(), 200);
    await panel.getByText('Configuração anterior da LP', {exact:true}).click();
    await panel.getByRole('combobox', {name:'Direto ou desconhecido', exact:true}).selectOption('0');
    await confirm('Revisar publicação', 'Política publicada. Versão 2.');
    await panel.getByText('Selecionar versão de entrada do projeto', {exact: true}).click();
    await panel.getByLabel('Versão publicada').selectOption('1');
    await confirm('Revisar versão de entrada', 'Versão de entrada selecionada no projeto: v1.');
    assert.equal((await lab.db.query('SELECT version FROM active_protection_policies WHERE project_id=$1', [ids.project])).rows[0].version, 1);
    await panel.getByLabel('Versão de redirecionamento').selectOption('2');
    await confirm('Revisar aprovação', /^Aprovação registrada\./);

    await panel.getByRole('link', {name: 'Substituir CTAs'}).click();
    await panel.getByLabel('Superfície de CTA').fill('landing');
    await panel.getByLabel('Habilitar nesta versão').check();
    await panel.getByRole('combobox', {name:'Direto ou desconhecido', exact:true}).selectOption('100');
    await confirm('Revisar publicação', 'Política publicada. Versão 1.');
    await panel.getByText('Cadastrar destino aprovado', {exact: true}).click();
    for (const point of candidates) {
      await panel.getByLabel('Identificador da oferta').fill(point.marker);
      await panel.getByLabel('URL do destino do CTA').fill(original + point.target);
      await confirm('Revisar destino', 'Destino cadastrado.');
    }
    await panel.getByText('Importar captura existente', {exact: true}).click();
    await panel.getByText('Capturar página local de teste', {exact:true}).click();
    await panel.getByLabel('URL da página local').fill(copy + '/lp');
    await action(panel, 'Abrir página local').click();
    await panel.getByText('Informe uma URL de laboratório válida no caminho indicado.', {exact:true}).waitFor();
    await panel.getByLabel('URL da página local').fill(captureOrigin + '/lp');
    await action(panel, 'Abrir página local').click();
    await panel.frameLocator('iframe[title="Página local para captura de CTA"]').getByRole('link', {name:'checkout01'}).waitFor();
    panel.once('dialog', dialog => { void dialog.accept(); });
    await action(panel, 'Capturar superfície').click();
    await panel.getByText('2 candidato(s) carregado(s).', {exact:false}).waitFor();
    assert.equal((await lab.db.query('SELECT count(*)::int n FROM cta_captures')).rows[0].n, 0);
    await confirm('Revisar captura', 'Captura importada.');
    for (const point of candidates) {
      const card = panel.getByRole('article').filter({has: panel.getByRole('heading', {name: point.marker, exact: true})});
      await card.getByLabel('Destino aprovado para ' + point.marker).selectOption({label: point.marker + ' · ' + original + point.target});
      await card.getByRole('button', {name: 'Revisar mapeamento'}).click();
      await action(panel, 'Confirmar').click();
      await panel.getByText('Mapeamento salvo.', {exact: true}).waitFor();
    }
    await panel.getByLabel('landing · versão 1').check();
    await confirm('Revisar aprovação', /^Aprovação registrada\./);
    await authorize(2);
    await capture(panel, '07-politica-cta');
    for (const point of candidates) {
      const decision = visit.waitForResponse(response => response.url().startsWith(gatewayOrigin + distributionPrefix) && decisionSuffix.test(response.url()));
      await visit.goto(copy + '/lp');
      assert.equal((await (await decision).json()).action, 'REPLACE_CONVERSION');
      const cta = visit.locator('[data-anticlone-point="' + point.marker + '"]');
      await cta.click();
      await visit.waitForURL(original + point.target);
    }
    assert.equal((await lab.db.query('SELECT count(*)::int n FROM cta_mappings')).rows[0].n, 2);
    const editedPoint=candidates[0];
    const editedTarget=original+'/checkout-editado';
    await panel.getByLabel('Identificador da oferta').fill(editedPoint.marker);
    await panel.getByLabel('URL do destino do CTA').fill(editedTarget);
    await confirm('Revisar destino', 'Destino cadastrado.');
    const editedCard=panel.getByRole('article').filter({has:panel.getByRole('heading',{name:editedPoint.marker,exact:true})});
    await editedCard.getByRole('button',{name:'Editar destino do CTA'}).click();
    await editedCard.getByLabel('Destino aprovado para '+editedPoint.marker).selectOption({label:editedPoint.marker+' · '+editedTarget});
    await editedCard.getByRole('button',{name:'Revisar mapeamento'}).click();
    await action(panel,'Confirmar').click();
    await panel.getByText('Mapeamento salvo.',{exact:true}).waitFor();
    await confirm('Revisar aprovação', /^Aprovação registrada\./);
    await authorize(3);
    for (const point of candidates) {
      const decision=visit.waitForResponse(response=>response.url().startsWith(gatewayOrigin+distributionPrefix) && decisionSuffix.test(response.url()));
      await visit.goto(copy+'/lp');
      assert.equal((await (await decision).json()).action,'REPLACE_CONVERSION');
      await visit.locator('[data-anticlone-point="'+point.marker+'"]').click();
      await visit.waitForURL(point===editedPoint ? editedTarget : original+point.target);
    }

    await action(panel, 'Suspender autorização').click();
    await action(panel, 'Confirmar').click();
    await panel.getByRole('status').getByText('Autorização suspensa.', {exact: true}).waitFor();
    await visit.goto(copy + '/lp');
    await visit.getByRole('link', {name: 'Comprar'}).click();
    await visit.waitForURL(copy + '/checkout-nativo');

    await panel.goto(installation);
    await panel.getByText('Revisão 1', {exact: true}).waitFor();
    await panel.getByText('Configurar coleta da origem principal', {exact: true}).click();
    await confirm('Habilitar coleta', 'Coleta do projeto habilitada.');
    await panel.getByRole('navigation', {name: 'Navegação principal'}).filter({visible: true}).getByRole('link', {name: 'Configurações'}).click();
    await panel.getByRole('link', {name: 'Saúde e operações', exact: true}).click();
    await panel.getByText('Gateway local respondeu', {exact: true}).waitFor();
    await panel.getByText('Perfil do gateway · Operacional · ações exigem autorização por LP',{exact:true}).waitFor();
    await panel.getByLabel('Projeto', {exact: true}).selectOption(ids.project);
    await panel.getByLabel('Acompanhar inatividade de sinais').check();
    await panel.getByLabel('Habilitar alertas operacionais').check();
    await panel.getByLabel('Intervalo de inatividade em segundos').fill('60');
    await confirm('Revisar configuração de saúde', 'Configuração de saúde salva.');
    assert.equal((await lab.db.query('SELECT inactivity_seconds FROM installation_health_settings')).rows[0].inactivity_seconds, 60);
    await capture(panel, '08-saude-ligada');
  });
