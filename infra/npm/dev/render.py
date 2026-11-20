#!/usr/bin/env python3
"""Render the three Dev fragments and compare Nginx's complete configuration dumps."""
import ipaddress
from pathlib import Path
import re
import sys

HOST = 'protect.leoceo.online'
SITE = '/data/nginx/proxy_host/13.conf'
HOOK = '/data/nginx/custom/http_top.conf'
DEST = '/data/nginx/custom/anticlone-dev'
FRAGMENTS = ('http-limits.conf', 'proxy-host.conf', 'proxy-location.conf')
INCLUDES = ''.join(f'include {DEST}/{name};\n' for name in FRAGMENTS[1:])
HTTP_INCLUDE = f'include {DEST}/{FRAGMENTS[0]};\n'


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def substitute_once(pattern, replacement, source):
    result, count = re.subn(pattern, replacement, source, flags=re.MULTILINE)
    require(count == 1, 'Formato inesperado do Proxy Host 13.')
    return result


def render(target, bridge, original_host, original_hook):
    require(ipaddress.IPv4Address(bridge) in ipaddress.IPv4Network('10.0.0.0/8') or
            ipaddress.IPv4Address(bridge) in ipaddress.IPv4Network('172.16.0.0/12') or
            ipaddress.IPv4Address(bridge) in ipaddress.IPv4Network('192.168.0.0/16'),
            'O destino precisa ser o IPv4 privado da bridge proxy.')
    require(re.findall(r'^\s*server_name\s+([^;]+);', original_host, re.M) == [HOST],
            'O Proxy Host 13 deve ter somente protect.leoceo.online.')
    require(re.findall(r'^\s*location\s+([^\n{]+)', original_host, re.M) and
            [x.strip() for x in re.findall(r'^\s*location\s+([^\n{]+)', original_host, re.M)] == ['/'],
            'O Proxy Host 13 precisa ter somente a localização padrão do NPM.')
    require(len(re.findall(r'^\s*server\s*\{', original_host, re.M)) == 1 and
            re.search(r'^\s*listen\b[^;]*\b443\s+ssl\b', original_host, re.M) and
            re.search(r'^\s*ssl_certificate\s+\S+;', original_host, re.M) and
            'force-ssl.conf;' in original_host,
            'O host 13 precisa ter TLS público existente e Force SSL.')
    require('anticlone_dev_' not in original_hook and DEST not in original_hook + original_host,
            'Há uma instalação AntiClone Dev no hook ou host.')

    candidate = substitute_once(r'^(\s*set \$forward_scheme\s+)[^;]+;', r'\g<1>https;', original_host)
    candidate = substitute_once(r'^(\s*set \$server\s+)[^;]+;', fr'\g<1>"{bridge}";', candidate)
    candidate = substitute_once(r'^(\s*set \$port\s+)[^;]+;', r'\g<1>13003;', candidate)
    candidate = substitute_once(r'^([ \t]*location / \{)', INCLUDES + r'\1', candidate)
    (target / '13.conf').write_text(candidate)
    (target / 'http_top.conf').write_text(original_hook + ('' if not original_hook or original_hook.endswith('\n') else '\n') + HTTP_INCLUDE)
    (target / 'advanced.conf').write_text(INCLUDES)
    for name in FRAGMENTS:
        source = (Path(__file__).resolve().parent.parent / name).read_text()
        result = (source.replace('PUBLIC_GATEWAY_HOST', HOST)
                  .replace('anticlone_personal_', 'anticlone_dev_')
                  .replace('anticlone-personal-public:3000', f'{bridge}:13003')
                  .replace('/run/anticlone/', f'{DEST}/tls/')
                  # Preserve the original TCP peer even if global real-IP has rewritten $remote_addr.
                  .replace('$binary_remote_addr', '$realip_remote_addr')
                  .replace('$remote_addr', '$realip_remote_addr'))
        if name == 'proxy-host.conf':
            result = re.sub(r'location = /admin.*\nlocation = /login.*',
                            r'location ~* "^/(admin|login)(/|$)" { return 404; }', result)
        (target / name).write_text(result)


def dump(path):
    sections = re.split(r'^# configuration file (/.+):\n', path.read_text(), flags=re.M)
    require(not sections[0].strip() and len(sections) > 1, 'Dump nginx -T incompleto.')
    files = dict(zip(sections[1::2], (content.rstrip('\n') for content in sections[2::2])))
    require(len(files) * 2 + 1 == len(sections), 'Dump nginx -T com arquivos repetidos.')
    return files


def compare(before, after, target, fixture=False, published=False):
    old, new = dump(before), dump(after)
    expected = {SITE: target / '13.conf', HOOK: target / 'http_top.conf',
                **{f'{DEST}/{name}': target / name for name in FRAGMENTS}}
    if fixture:
        expected['/data/nginx/proxy_host/zz-anticlone-dev-gate.conf'] = target / 'other.conf'
    require(set(new) == set(old) | set(expected), 'Arquivos inesperados no nginx -T candidato.')
    for name, body in new.items():
        if name in expected:
            reference = expected[name].read_text().rstrip('\n')
            if published and name == SITE:
                # NPM inserts Advanced with its own blank lines or indentation.
                compact = lambda value: [line.strip() for line in value.splitlines() if line.strip()]
                same = compact(body) == compact(reference)
            else:
                same = body == reference
        else:
            same = body == old[name]
        require(same, f'Divergência no nginx -T de {name}.')
    owners = [
        name for name, body in new.items()
        if any(HOST in names.split() for names in re.findall(r'^\s*server_name\s+([^;]+);', body, re.M))
    ]
    require(owners == [SITE], 'O hostname AntiClone aparece em outro arquivo server_name.')


if __name__ == '__main__':
    action, *args = sys.argv[1:]
    if action == 'render':
        output, bridge, site_path, hook_path = args
        hook = Path(hook_path)
        render(Path(output), bridge, Path(site_path).read_text(), hook.read_text() if hook.exists() else '')
    elif action == 'compare':
        old, new, output, *mode = args
        compare(Path(old), Path(new), Path(output), mode == ['fixture'], mode == ['published'])
    elif action == 'baseline':
        baseline, copy = map(Path, args)
        require(dump(baseline) == dump(copy), 'O clone inicial diverge do nginx -T real.')
    elif action == 'detach':
        path = Path(args[0])
        rows = path.read_bytes().splitlines(keepends=True)
        line = HTTP_INCLUDE.strip().encode()
        require(sum(row.strip() == line for row in rows) <= 1, 'A inclusão exclusiva aparece mais de uma vez.')
        sys.stdout.buffer.write(b''.join(row for row in rows if row.strip() != line))
    else:
        raise SystemExit('Ação inválida.')
