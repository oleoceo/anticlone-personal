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
def check_documents(root):
    """Verifica UTF-8 e declaracoes explicitas de situacao no STATUS."""
    problems=[]
    contents={}
    for path in list(root.glob('*.md')) + list((root/'docs').rglob('*.md')):
        try:
            content=path.read_text(encoding='utf8')
        except UnicodeDecodeError:
            problems.append(f'{path.relative_to(root)}: UTF-8 invalido')
            continue
        contents[path.relative_to(root).as_posix()]=content
        fence=None
        for number,line in enumerate(content.splitlines(),1):
            marker=re.match(r'^\s{0,3}(`{3,}|~{3,})',line)
            if marker:
                token=marker.group(1)
                if fence is None: fence=token
                elif token[0]==fence[0] and len(token)>=len(fence): fence=None
                prose=''
            else:
                prose='' if fence or line.startswith(('    ', '\t')) else re.sub(r'(`+).*?\1', '', line)
            if '\ufffd' in line or re.search(r'[ÃÂ][\x80-\xbf]',line):
                problems.append(f'{path.relative_to(root)}:{number}: possivel texto corrompido')
            elif re.search(r'[^\W\d_]\?{2,}[^\W\d_]',prose):
                problems.append(f'{path.relative_to(root)}:{number}: possivel texto corrompido')
    matrix=contents.get('docs/FUNCTIONAL-MATRIX.md','')
    statuses=dict(re.findall(r'^\| (F\d{2,}) \|.*\| (P|PARCIAL|V|B) \|\s*$',matrix,re.M))
    seen=set()
    for number,line in enumerate(contents.get('STATUS.md','').splitlines(),1):
        match=re.match(r'^- \*\*((?:F\d{2,})(?:/F\d{2,})*)\s+(parcial|parciais|validada(?:s)?|bloqueada(?:s)?|planejada(?:s)?)(?=\s|[:—*])',line,re.I)
        if not match: continue
        label=match.group(2).lower()
        expected=('PARCIAL' if label.startswith('parcia') else 'V' if label.startswith('validada') else 'B' if label.startswith('bloqueada') else 'P')
        for capability in match.group(1).split('/'):
            if capability in seen: continue
            seen.add(capability)
            if capability not in statuses:
                problems.append(f'STATUS.md:{number}: {capability} ausente da matriz')
            elif statuses[capability]!=expected:
                problems.append(f'STATUS.md:{number}: {capability} declarado {expected}, matriz {statuses[capability]}')
    return problems

errors.extend(check_documents(root))
if any('UTF-8 invalido' in error for error in errors):
    print('FALHOU:')
    for error in errors: print(' -',error)
    sys.exit(1)
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
