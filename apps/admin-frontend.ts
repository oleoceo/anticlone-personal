import {readFile} from 'node:fs/promises';
import type {ServerResponse} from 'node:http';

const root = '/admin/ui/novo';
const project = '[a-zA-Z0-9_-]{1,64}';
const page = '[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}';
const incident = '[1-9][0-9]{0,18}';
const projectArea = '(?:/nova-lp|/incidentes(?:/' + incident + '(?:/redirecionar|/substituir-cta)?)?|/lps/' + page +
  '(?:/instalacao|/conversoes(?:/estimativa|/vinculos)?)?)?';
const screens = new RegExp('^' + root + '(?:/visao-geral|/configuracoes(?:/notificacoes|/integracoes|/operacoes)?|/proteger-oferta|/incidentes|/projetos(?:/' + project + projectArea + ')?)?/?$');
const asset = /^\/admin\/ui\/novo\/(assets\/[a-zA-Z0-9_-]+\.(js|css))$/;

export function serveAdminFrontend(url: string, site: string | undefined, res: ServerResponse): boolean {
  const path = url.split('?')[0];
  if (path !== root && !path.startsWith(root + '/')) return false;

  const match = asset.exec(path);
  if (match && site !== 'same-origin') {
    res.writeHead(403).end();
    return true;
  }
  if (!match && !screens.test(path)) {
    res.writeHead(404).end();
    return true;
  }

  const file = match?.[1] ?? 'index.html';
  const type = !match ? 'text/html' : match[2] === 'js' ? 'text/javascript' : 'text/css';
  void readFile(new URL('./admin-frontend/' + file, import.meta.url)).then(
    body => res.writeHead(200, {'Content-Type': type + '; charset=utf-8'}).end(body),
    (error: NodeJS.ErrnoException) => res.writeHead(error.code === 'ENOENT' ? 404 : 503).end(),
  );
  return true;
}
