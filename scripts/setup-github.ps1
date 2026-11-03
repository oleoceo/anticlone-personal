# PowerShell 7 / Windows PowerShell 5.1. Execute da raiz do projeto.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

function Require-Cmd([string]$name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "Comando ausente: $name. Veja docs/WINDOWS-GITHUB.md." }
}
Require-Cmd git
Require-Cmd gh
if (-not (Test-Path -LiteralPath 'ANTICLONE-PERSONAL-BLUEPRINT.md')) { throw 'Blueprint ausente na raiz.' }
if (-not (Test-Path -LiteralPath 'AGENTS.md')) { throw 'AGENTS.md ausente na raiz.' }
if ((Get-Content -LiteralPath 'CLAUDE.md' -Raw).Trim() -ne '@AGENTS.md') { throw 'CLAUDE.md precisa importar apenas @AGENTS.md.' }
if (-not (git config user.name)) { throw 'Configure git config --global user.name antes.' }
if (-not (git config user.email)) { throw 'Configure git config --global user.email antes.' }
& gh auth status
if ($LASTEXITCODE -ne 0) { throw 'Autentique com gh auth login antes de executar o script.' }
if (Test-Path -LiteralPath '.git') { throw 'Ja existe .git. Use comandos manuais; nao reinicializar.' }

Write-Host 'ATENCAO: repositorio GitHub PRIVATE, somente arquivos explicitamente listados.'
& git init -b main
if ($LASTEXITCODE -ne 0) { throw 'git init falhou' }
$paths=@('AGENTS.md','CLAUDE.md','README.md','STATUS.md','ANTICLONE-PERSONAL-BLUEPRINT.md','.gitignore','.gitattributes','docs','scripts','.agents','.claude','.github')
& git add -- $paths
if ($LASTEXITCODE -ne 0) { throw 'git add falhou' }
& git status --short
& git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'diff possui problemas' }
& git commit -m 'chore: iniciar AntiClone Personal com regras e matriz'
if ($LASTEXITCODE -ne 0) { throw 'git commit falhou' }
& gh repo create anticlone-personal --private --source=. --remote=origin --push
if ($LASTEXITCODE -ne 0) { throw 'GitHub falhou. Repo local preservado: verifique remotes e GitHub antes de repetir.' }
& gh repo view --json name,visibility,url --jq '{name,visibility,url}'
if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel verificar a visibilidade do repositorio.' }
Write-Host 'Revise PRIVATE e configure protecao da main conforme docs/WINDOWS-GITHUB.md.'
