# Permissões e salvaguardas

## Autorizado aos agentes sem retorno ao usuário
- Ler projeto e referências autorizadas; criar branches/worktrees; editar código local; instalar dependências aprovadas e justificadas; executar testes; criar commits e PRs; acompanhar checks; corrigir erros reproduzidos.
- Apenas usar hostnames e cópias simuladas controladas pelo proprietário nos testes. Não testar coleta/interceptação em páginas de terceiros.
- Não ampliar rastreamento sensível além da minimização de dados e retenção definidas.

## Exige intervenção humana, antes da ação
- Criar custo recorrente, configurar pagamento, trocar DNS/Cloudflare, publicar endpoint público, deploy na VPS de produção, criar/injetar segredos/credenciais, alterar firewall, remover backup, rodar migração destrutiva ou coletar dados sensíveis além do planejado.
- Apagar dados, mudar proprietário/permissões de GitHub, tornar repo público, desativar proteção de branch, conceder `admin` irrestrito a integração.
- Mudança material de lógica de proteção que não preserve os testes do contrato.

## Segurança técnica obrigatória
- Tratar payload, `Referer`, `Origin`, `X-Forwarded-For`, IP e fingerprint como sinais não confiáveis, com proxy confiável explicitamente configurado.
- JavaScript público nunca leva credenciais do backend, SMTP, checkout ou banco; hash não torna automaticamente identificadores anônimos.
- Testes de rede/SSRF com allowlist de destinos e timeouts; não executar URLs de usuário arbitrárias no backend.
- Evidência é sinal de atividade, não prova jurídica de identidade. CTA recuperado ≠ compra comprovada.
- Minimizar dados de visitantes; separar IP de acesso e IP de hospedagem; restringir acesso às observações e configurar retenção conforme exigências aplicáveis.
- Não publicar runtime/admin por compartilhamento acidental de hostname sem decisão explícita de arquitetura.
