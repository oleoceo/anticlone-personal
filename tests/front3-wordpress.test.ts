import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {execFileSync,spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {Pool} from 'pg';
import {chromium} from 'playwright';
import {managePages} from '../apps/protected-pages.js';

test('Front3: real WordPress installation via mu-plugin; original preserved and copied markup observed',{timeout:240000,skip:process.env.HTTPS_GATE_TEST!=='1'?'Docker WordPress required in full CI':false},async()=>{
 assert.ok(process.env.TEST_DATABASE_URL);
 const id=randomUUID().replaceAll('-',''),network='front3-wp-'+id,mysql=network+'-db',wp=network+'-site',schema='front3_wp_'+id;
 const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:120000}).trim();
 const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});await root.query(`CREATE SCHEMA ${schema}`);const options=`-c search_path=${schema}`,db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
 let gateway:ChildProcess|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 const reserve=createServer().listen(0,'127.0.0.1');await once(reserve,'listening');const address=reserve.address();assert.ok(address&&typeof address!=='string');const port=address.port;await new Promise<void>(r=>reserve.close(()=>r()));
 const api='http://127.0.0.1:'+port;
 const csp="script-src 'self' "+api+"; img-src 'self' "+api+" data:; style-src 'self' 'unsafe-inline'";
 let copied='';const copyServer=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html','content-security-policy':csp}).end(copied)).listen(0,'127.0.0.1');await once(copyServer,'listening');const ca=copyServer.address();assert.ok(ca&&typeof ca!=='string');
 try{
  for(const file of (await readdir('infra')).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort())await db.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));
  docker('network','create',network);
  docker('run','-d','--name',mysql,'--network',network,'--network-alias','db','--tmpfs','/var/lib/mysql','-e','MARIADB_DATABASE=wordpress','-e','MARIADB_USER=lab','-e','MARIADB_PASSWORD=synthetic-only','-e','MARIADB_ROOT_PASSWORD=synthetic-root','mariadb:11.4');
  docker('run','-d','--name',wp,'--network',network,'--publish','127.0.0.1::80','-e','WORDPRESS_DB_HOST=db','-e','WORDPRESS_DB_USER=lab','-e','WORDPRESS_DB_PASSWORD=synthetic-only','-e','WORDPRESS_DB_NAME=wordpress','wordpress:php8.3-apache');
  const binding=docker('port',wp,'80/tcp');assert.match(binding,/^127\.0\.0\.1:\d+$/);const original='http://'+binding;
  let ready=false;for(let n=0;n<120;n++){try{const response=await fetch(original+'/wp-admin/install.php');if(response.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}assert.ok(ready,'WordPress installer ready');
  const installed=docker('exec',wp,'php','-r',"define('WP_INSTALLING',true); require '/var/www/html/wp-load.php'; require_once ABSPATH.'wp-admin/includes/upgrade.php'; wp_install('Controlled WordPress','lab-owner','owner@example.test',false,'','Synthetic-only-strong-password-123!'); update_option('siteurl',"+JSON.stringify(original)+"); update_option('home',"+JSON.stringify(original)+"); if(!is_blog_installed()){exit(1);} echo 'FRONT3_WORDPRESS_INSTALLED';");assert.ok(installed.includes('FRONT3_WORDPRESS_INSTALLED'));
  // A real WordPress hook, rather than HTML labelled as WordPress.
  const plugin=`<?php add_action('send_headers',function(){header("Content-Security-Policy: ${csp}");}); add_action('wp_footer',function(){echo '<a href="#native-checkout">Native WordPress checkout</a><script async src="${api}/runtime.js"></script><script async src="${api}/fallback.js"></script><img src="${api}/canary/html.gif"><style>.wp-canary{background-image:url(${api}/canary/css.gif)}</style><div class="wp-canary">Passive</div>';});`;
  execFileSync('docker',['exec','-i',wp,'sh','-c','mkdir -p /var/www/html/wp-content/mu-plugins && cat > /var/www/html/wp-content/mu-plugins/anticlone-lab.php'],{input:plugin,stdio:['pipe','pipe','pipe']});
  await db.query("INSERT INTO projects(id,name,origin) VALUES('wordpress','Controlled WordPress',$1)",[original]);
  await managePages(db,{action:'create',project:'wordpress',name:'WordPress LP',url:original+'/'});
  gateway=spawn(process.execPath,['dist/apps/server.js'],{env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,PGOPTIONS:options,PROJECT_ID:'wordpress',PORT:String(port),ALLOWED_ORIGIN:original,SMTP_PORT:'1'},stdio:'ignore'});
  ready=false;for(let n=0;n<100;n++){try{if((await fetch(api+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  browser=await chromium.launch();const page=await browser.newPage();await page.route('**/*',route=>{const hostname=new URL(route.request().url()).hostname;return ['127.0.0.1','localhost'].includes(hostname)?route.continue():route.abort();});await page.goto(original,{waitUntil:'networkidle'});assert.equal(new URL(page.url()).origin,original);assert.ok((await page.content()).includes('Native WordPress checkout'),'WordPress footer hook rendered: '+(await page.title()));await page.getByRole('link',{name:'Native WordPress checkout',exact:true}).click();assert.ok(page.url().endsWith('#native-checkout'));assert.equal((await db.query('SELECT count(*)::int n FROM incidents')).rows[0].n,0);
  const wordpressResponse=await fetch(original);assert.ok(wordpressResponse.headers.get('content-security-policy')?.includes(api));copied=await wordpressResponse.text();assert.ok(copied.includes('runtime.js'));await page.goto('http://localhost:'+ca.port,{waitUntil:'networkidle'});
  const sources=(await db.query('SELECT source FROM observations')).rows.map(r=>r.source);assert.ok(sources.includes('core'));assert.ok(sources.includes('fallback'));assert.equal((await db.query('SELECT count(*)::int n FROM incidents')).rows[0].n,1);
  assert.equal((await db.query("SELECT count(DISTINCT source)::int n FROM canary_observations WHERE host='localhost'")).rows[0].n,2);
  console.log('FRONT3_WORDPRESS '+docker('exec',wp,'php','-r',"require '/var/www/html/wp-includes/version.php';echo $wp_version;")+'; original intact; copy Core/Fallback/2 canaries; no sales claim');
 }finally{
  await browser?.close();if(gateway&&gateway.exitCode===null&&gateway.signalCode===null){gateway.kill('SIGTERM');await once(gateway,'exit');}
  await new Promise<void>(r=>copyServer.close(()=>r()));
  for(const name of [wp,mysql]){try{docker('rm','-fv',name);}catch{/* only uniquely named disposable test containers */}}
  try{docker('network','rm',network);}catch{/* setup may have failed */}
  await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();
 }
});
