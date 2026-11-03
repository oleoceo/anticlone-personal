#!/usr/bin/env python3
"""Verificador de estrutura documental; NÃO valida funcionamento da aplicação."""
import re, sys, json
from pathlib import Path
root=Path(__file__).resolve().parent.parent
required=[
    'AGENTS.md','CLAUDE.md','README.md','STATUS.md',
    'ANTICLONE-PERSONAL-BLUEPRINT.md',
    'docs/FUNCTIONAL-MATRIX.md','docs/TEST-SCENARIOS.md',
    'docs/AGENT-WORKFLOW.md','docs/SECURITY-BOUNDARIES.md',
    'docs/DECISIONS.md','docs/SOURCES.md','docs/WINDOWS-GITHUB.md',
]
errors=[]
for file in required:
    if not (root/file).is_file(): errors.append('Arquivo obrigatorio ausente: '+file)
if (root/'CLAUDE.md').is_file() and (root/'CLAUDE.md').read_text(encoding='utf8').strip()!='@AGENTS.md':
    errors.append('CLAUDE.md deve conter somente @AGENTS.md para evitar drift')
if (root/'docs/FUNCTIONAL-MATRIX.md').exists():
    content=(root/'docs/FUNCTIONAL-MATRIX.md').read_text(encoding='utf8')
    ids=re.findall(r'^\| (F\d{2,}) \|',content,re.M)
    if len(ids)<30: errors.append('Matriz funcional incompleta: menos de 30 capacidades')
    if len(ids)!=len(set(ids)): errors.append('IDs de capacidades duplicados')
if (root/'docs/TEST-SCENARIOS.md').exists():
    content=(root/'docs/TEST-SCENARIOS.md').read_text(encoding='utf8')
    ids=re.findall(r'^\| (GS\d{2,}) \|',content,re.M)
    if len(ids)<16: errors.append('Cenarios Golden incompletos')
    if len(ids)!=len(set(ids)): errors.append('IDs de cenarios duplicados')
source_extensions={'.ts','.tsx','.js','.jsx','.mjs','.cjs','.vue'}
code_dirs=[root/x for x in ('apps','runtime','shared')]
has_code=any(f.is_file() and f.suffix in source_extensions for d in code_dirs if d.exists() for f in d.rglob('*'))
if has_code:
    pkg=root/'package.json'
    if not pkg.is_file():
        errors.append('Codigo detectado; exige package.json raiz com lint,typecheck,test,build')
    else:
        try:
            scripts=json.loads(pkg.read_text(encoding='utf8')).get('scripts',{})
            for name in ('lint','typecheck','test','build'):
                if not scripts.get(name):errors.append(f'Falta script real {name} em package.json')
        except (ValueError,UnicodeDecodeError) as e:
            errors.append('package.json invalido: '+str(e))
if errors:
    print('FALHOU:')
    for e in errors: print(' -',e)
    sys.exit(1)
print('OK: estrutura documental consistente.')
print('ATENCAO: isto NAO prova deteccao, seguranca ou mitigacao. Estado de codigo:', 'presente — rode testes reais' if has_code else 'nao iniciado')
