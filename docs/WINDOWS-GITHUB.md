# Git e GitHub privado no Windows (PowerShell)

## Pré-requisitos

Verifique no PowerShell:

```powershell
git --version
gh --version
```

Se faltar, instale Git e GitHub CLI pelos sites oficiais ou, quando disponível, com:

```powershell
winget install --id Git.Git -e
winget install --id GitHub.cli -e
```

Feche e reabra o PowerShell após instalar. Configure **sua própria** identificação para os commits (não copie credenciais de chats):

```powershell
git config --global user.name "SEU_NOME_OU_APELIDO"
git config --global user.email "SEU_EMAIL_DO_GITHUB"
git config --global init.defaultBranch main
```

## Criar repositório privado a partir da pasta que já existe

```powershell
cd C:\projetos\anticlone-personal
gh auth login       # GitHub.com / HTTPS / navegador; confirmar uso como helper do Git
gh auth status
python scripts/validate_repo.py  # opcional local; a CI repetirá

git init -b main
git add AGENTS.md CLAUDE.md README.md STATUS.md ANTICLONE-PERSONAL-BLUEPRINT.md .gitignore .gitattributes docs scripts .agents .claude .github
git status --short
git diff --cached --check
git commit -m "chore: iniciar AntiClone Personal com regras e matriz"
gh repo create anticlone-personal --private --source=. --remote=origin --push
gh repo view --json name,visibility,url --jq '{name,visibility,url}'
```

**Confirme que `visibility` é `PRIVATE`.** O `git add` é explícito para evitar inclusão acidental da pasta de referências e de segredos. Se a pasta já tiver `.git`, não reinicialize sem revisar a situação.

## Configuração do GitHub após criação

- Em **Settings → Branches / Rulesets**, criar proteção para `main`: PR obrigatório, status check de validação, impedir force push e exclusão. Ajustar regras disponíveis conforme o tipo de conta/plano.
- Em **Settings → Actions → General**, dar permissões mínimas ao token da CI; não habilitar deploy automático sem pipeline validada.
- Repositório deve ser privado e sem colaboradores extras que não sejam necessários.
- Segredos (DB/SMTP/VPS) devem ser configurados somente quando a implantação estiver pronta, em gerenciador de segredos/ambiente adequado, nunca `.env` versionado.

## Comandos rotineiros para agentes

```powershell
git switch main
git pull --ff-only
git switch -c feat/deteccao-inicial
# ... código e testes ...
git status --short
git diff --check
git add apps runtime shared tests docs STATUS.md  # ajustar à mudança real
git commit -m "feat: detectar execucao em host nao autorizado"
git push -u origin feat/deteccao-inicial
gh pr create --fill --base main
gh pr checks
```

Não executar `gh repo create` se já existir repositório remoto com esse nome; nesse caso vincule com `git remote add origin URL` após conferir a URL e estado remoto. Não executar push force como correção.

## Automação opcional do primeiro push

`scripts/setup-github.ps1` automatiza os passos seguros, **não** configura credenciais ou regras de branch. Execute apenas depois de autenticar `gh auth login` e conferir os arquivos. Em caso de erro, ele interrompe sem tentar apagar nada.
