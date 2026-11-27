#!/usr/bin/env python3
"""Confere equivalência e corrige a flag de publicação na instalação Personal existente."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import signal
import sys

FLAG = "RUNTIME_COMPACT_ALIASES"
MIGRATION = "077_asset_filename_aliases.sql"
SCHEMA_QUERY = """SELECT current_database(), EXISTS (
  SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('runtime_distributions')
  AND conname = 'runtime_distributions_asset_file_contract_check');"""
MANIFEST_JS = """
const fs = require('node:fs'), crypto = require('node:crypto');
const files = {};
function walk(path) {
  for (const name of fs.readdirSync(path)) {
    if (name === 'admin-frontend') continue;
    const file = path + '/' + name;
    if (fs.statSync(file).isDirectory()) walk(file);
    else files[file] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
}
walk('dist/apps');
walk('runtime');
console.log(JSON.stringify(files));
"""


def artifact_differences(left, right):
    return sum(left.get(name) != right.get(name) for name in left.keys() | right.keys())


def serve_bundle(u, port, revision):
    status, _, html = u['call_http']('127.0.0.1', '/admin/ui/novo/', port=port)
    match = re.search(rb'src="(/admin/ui/novo/assets/[^"]+\.js)"', html)
    u['require'](status == 200 and match, f'HTML indisponível na porta {port}.')
    status, _, body = u['call_http']('127.0.0.1', match[1].decode(), port=port,
                                     headers={'Sec-Fetch-Site': 'same-origin'})
    u['require'](status == 200 and revision.encode() in body, f'SHA inesperado na porta {port}.')
    return hashlib.sha256(body.replace(revision.encode(), b'BUILD_COMMIT')).hexdigest()


def inspect_live(u, plan, dev):
    personal = {}
    for name in plan['services']:
        item = u['active_service'](u['ORIGINAL'], name)
        manifest = json.loads(u['docker']('exec', item['Id'], 'node', '-e', MANIFEST_JS,
                                          step=f'Artefatos {name}').stdout)
        print(f'{name}: {artifact_differences(dev, manifest)} arquivos distintos do Dev (backend/runtime).')
        personal[name] = u['container_env'](item)
    return personal


def enable(u, plan, admin, name, context):
    require = u['require']
    switches, paths = context
    live = u['container_env'](admin)
    config = u['effective'](switches, paths, '--no-env-resolution')['services'][name]
    files = config.get('env_file', [])
    require(len(files) == 1 and files[0].get('format') == 'raw', 'Env privado raw do Admin não identificado.')
    target = u['exact_path'](files[0]['path'], u['BASE'] / 'private')
    require(target.is_file() and target.stat().st_uid == 0 and not target.stat().st_mode & 0o077,
            'Arquivo do Admin fora da custódia privada.')
    require(FLAG not in (config.get('environment') or {}), 'A flag tem precedência no Compose.')
    original = target.read_bytes()
    pattern = rb'(?m)^RUNTIME_COMPACT_ALIASES=[^\r\n]*'
    require(len(re.findall(pattern, original)) <= 1, 'Flag duplicada no env privado.')
    line = f'{FLAG}=true'.encode()
    updated = re.sub(pattern, line, original) if re.search(pattern, original) else (
        original + (b'\n' if original and not original.endswith(b'\n') else b'') + line + b'\n')
    expected = {**live, FLAG: 'true'}

    def configured():
        return u['effective'](switches, paths)['services'][name]['environment']

    def recreate():
        u['compose'](switches, paths, 'up', '-d', '--no-deps', '--force-recreate', '--pull', 'never', name,
                     step='Recriação do Admin Personal', timeout=180)

    def check():
        current = u['active_service'](u['ORIGINAL'], name)
        require(current['Image'] == plan['image_id'] and u['container_env'](current) == expected,
                'A recriação mudou a imagem ou outra configuração do Admin.')
        u['check_static_admin'](plan['revision'])

    changed = updated != original
    restarted = False
    try:
        prior_config = configured()
        # Verify the service declaration still reproduces its deployed environment.
        image_env = u['env_map'](json.loads(u['docker']('image', 'inspect', '--format', '{{json .Config.Env}}',
                                                    plan['image_id'], step='Ambiente da imagem').stdout))
        same_without_flag = lambda values: {key: value for key, value in values.items() if key != FLAG}
        require(same_without_flag({**image_env, **prior_config}) == same_without_flag(live),
                'Compose difere do Admin ativo. Reconcile a configuração privada antes da recriação.')
        if changed:
            u['replace'](target, updated)
        require({**image_env, **configured()} == expected, 'Compose alteraria outras configurações do Admin.')
        if live != expected:
            restarted = True
            recreate()
        u['retry'](check, 'Admin não confirmou a flag e as configurações anteriores.')
    except BaseException:
        if changed:
            u['replace'](target, original)
        if restarted and {**image_env, **prior_config} == live:
            recreate()
        raise


def run(u, update):
    require = u['require']
    require(os.geteuid() == 0 and os.environ.get('SUDO_USER') in (None, 'leoceo'),
            'Execute com as permissões existentes do titular.')
    os.umask(0o077)
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, u['handle_signal'])
    for name in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME'):
        os.environ.pop(name, None)
    custody = u['BASE'] / 'private'
    state_file = custody / 'personal-d5e5ed2-cutover.json'
    with (custody / 'personal-d5e5ed2-cutover.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        plan = u['live_pg_plan'](json.loads(state_file.read_bytes()))
        require(plan['status'] == 'complete' and not u['ids_for'](u['PARALLEL']) and u['no_parallel_port'](),
                'O Personal original deve estar operacional sem instalação paralela.')
        u['release_health'](plan, plan['revision'], plan['image_id'])
        require(u['port_is_private'](3002), 'Dev fora de loopback na porta 3002.')
        pid = int(u['command'](u['dev_command']('show', '-p', 'MainPID', '--value', u['DEV_UNIT']),
                               step='Processo Dev').stdout)
        cwd = Path(f'/proc/{pid}/cwd').resolve()
        dev_env = u['dev_admin_env']()
        dev_revision = u['command'](('runuser', '-u', 'anticlone-dev', '--', 'git', 'rev-parse', 'HEAD'), cwd=cwd, step='SHA Dev').stdout.decode().strip()
        dev = {
            str(path.relative_to(cwd)): u['sha_file'](path)
            for directory in ('dist/apps', 'runtime') for path in (cwd / directory).rglob('*')
            if path.is_file() and 'admin-frontend' not in path.relative_to(cwd).parts
        }
        personal = inspect_live(u, plan, dev)
        name = plan['services'][0]
        print('Bundle sem metadado de revisão:', 'igual' if
              serve_bundle(u, 3001, plan['revision']) == serve_bundle(u, 3002, dev_revision) else 'distinto')
        for key in sorted(set(dev_env) | set(personal[name])):
            if key.startswith(('ADMIN_', 'RUNTIME_', 'INSTALLATION_VERIFIER_', 'SMTP_', 'COMMERCE_')):
                left, right = dev_env.get(key), personal[name].get(key)
                status = ('igual' if left == right else 'definido nos dois' if left and right
                          else 'somente Dev' if left else 'somente Personal')
                print(f'{key}: {status}')
        require(dev_env.get(FLAG) == 'true' and u['dev_query'](dev_env, SCHEMA_QUERY).endswith('|t'),
                'Dev não confirmou a flag e a migration 077.')
        admin = u['active_service'](u['ORIGINAL'], name)
        probe = """const {Pool}=require('pg');const db=new Pool({connectionString:process.env.DATABASE_URL});
        db.query(process.argv[1]).then(r=>console.log(JSON.stringify(Object.values(r.rows[0]))))
        .catch(()=>{process.exitCode=1}).finally(()=>db.end());"""
        def check_schema(container):
            return json.loads(u['docker']('exec', container, 'node', '-e', probe, SCHEMA_QUERY,
                                          step='Migration 077 na conexão do Admin').stdout)

        require(MIGRATION in plan['migrations'] and check_schema(admin['Id']) == [u['DB'], True] and
                u['pg'](plan['pg'], u['DB'], SCHEMA_QUERY, step='Migration 077 no PostgreSQL Personal')
                == u['DB'] + '|t', 'Migration 077 ausente ou divergente do manifesto da release.')
        for host in (u['HOSTS'][15], u['HOSTS'][16]):
            u['check_public'](host)
        enable(u, plan, admin, name, u['compose_context'](admin))
        expected = {**personal[name], FLAG: 'true'}
        def release_health(live_plan, revision, image):
            gateway = u['release_health'](live_plan, revision, image)
            for service, before in personal.items():
                active = u['active_service'](u['ORIGINAL'], service)
                after = u['container_env'](active)
                saved = expected if service == name else before
                require(all(after.get(key) == value for key, value in saved.items()),
                        f'Configuração efetiva mudou em {service}.')
                if service == name:
                    require(check_schema(active['Id']) == [u['DB'], True],
                            'Migration 077 indisponível no Admin.')
            for host in (u['HOSTS'][15], u['HOSTS'][16]):
                u['check_public'](host)
            return gateway

        if update:
            # Keep environment and public route checks inside the existing commit/rollback gate.
            updater = u['update_personal']
            updater.__globals__['release_health'] = release_health
            updater(custody, state_file, plan)
        else:
            release_health(plan, plan['revision'], plan['image_id'])
        print('Personal: schema 077, flag persistida, serviços e sondas compactas confirmados.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--updater', type=Path, required=True, help='caminho do atualizar-personal já usado')
    parser.add_argument('--update', action='store_true', help='também aplica o procedimento existente da main')
    options = parser.parse_args()
    u = runpy.run_path(str(options.updater.resolve(strict=True)))
    try:
        run(u, options.update)
    except (u['CutError'], OSError, ValueError, KeyError) as error:
        print(str(error) if isinstance(error, u['CutError']) else type(error).__name__, file=sys.stderr)
        sys.exit(1)
