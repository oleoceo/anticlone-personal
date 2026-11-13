import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

// Independent NPM fixture: never reads or splices the direct HTTPS profile.
export async function npmProxyFixture(dir:string,upstream='127.0.0.1:3000',port=443,otherServer=''){
  for(const file of ['http-limits.conf','proxy-host.conf','proxy-location.conf']){
    const content=(await readFile('infra/npm/'+file,'utf8')).replaceAll('PUBLIC_GATEWAY_HOST','gateway.test').replaceAll('/run/anticlone/','/run/tls/').replaceAll('anticlone-personal-public:3000',upstream);
    await writeFile(join(dir,file),content);
  }
  const envelope=(await readFile('tests/fixtures/npm-nginx.conf','utf8')).replaceAll('NPM_TEST_PORT',String(port)).replace('NPM_TEST_OTHER_SERVER',otherServer);
  await writeFile(join(dir,'nginx.conf'),envelope);
}
