# Homologação DEV após a limpeza de 27/11/2026

O Admin DEV estava configurado para usar `http://127.0.0.1:13002` como padrão de distribuição. A publicação inicial gravava os três papéis nesse endereço e uma LP externa procuraria os recursos na máquina do visitante. O valor efetivo de `RUNTIME_PUBLIC_ORIGIN` do Admin DEV passou a ser `https://protect.leoceo.online`, origem já autorizada no pool, verificada e servida pelo Gateway operacional. A precedência configurável por papel e a exigência de verificação da origem foram preservadas.

## Evidência no DEV ativo

| Prova | Resultado |
|---|---|
| Inventário pós-limpeza | Zero projetos, páginas, aliases e registros de cadastro. Seis registros antirreplay de MFA, uma configuração de notificações e três origens de distribuição presentes. |
| Cadastro pela implementação servida e papel PostgreSQL do Admin | Criação de projeto e LP, reenvio idempotente, rejeição de entrada inválida e rejeição de duplicidade. Ensaio com transação revertida e inventário final idêntico. |
| Publicação e republicação | Revisões 1 e 2 com aliases compactos e os três papéis no Gateway HTTPS. Releitura das revisões dentro da transação e reversão ao final. |
| Recuperação dos processos | Admin, Gateway privado, Gateway público e worker ativos após reinicialização. Gateway privado em observação, Gateway público em modo operacional e novo estado READY do worker. O container PostgreSQL DEV também reiniciou, voltou a healthy e o Gateway público recuperou a conexão. |
| SMTP configurado | Conexão TLS autenticada pelo mesmo transporte da aplicação, sem envio de mensagem ao provedor real neste ensaio. |

A falha genérica relatada no primeiro cadastro não reapareceu nas provas de cadastro. A transação no banco ativo não passou por uma sessão do proprietário no navegador. Nenhum dado de homologação precisou ser excluído por SQL direto. A funcionalidade de expurgo físico continua bloqueada pelo contrato existente.

O primeiro reinício do PostgreSQL expôs uma falha do worker. O pool emitiu um erro de conexão ociosa sem tratamento e o systemd teve de recuperar o processo. O Admin e o worker agora tratam o evento com mensagem sanitizada, seguindo o padrão do Gateway. A regressão encerra apenas conexões de teste identificadas, verifica a sessão autenticada do Admin e exige conexão PostgreSQL recém-aberta no mesmo processo do worker.

## Regressão funcional

Os cenários focais de `admin-frontend`, `admin-totp`, `page-redirect-journey`, `operational-journey` e `provider-notifications` passaram 20 de 20 em Chromium, PostgreSQL e SMTP controlados. Eles cobrem sessão, MFA persistente, perda de resposta, cadastros válidos e inválidos, publicação, instalação, original e cópia sob controle de teste, regras por cópia, CTAs independentes, fail-open, incidentes, métricas, retry de notificações e recuperação do Gateway e do worker.

A suíte `runtime-distribution` passou 3 de 3. A nova regressão verifica que o padrão HTTPS exige verificação antes de publicar, grava os três papéis na origem verificada e entrega o script publicado por mTLS. A LP aparece no inventário de uso do endpoint no painel. Revisão independente `/root/revisao_dev` favorável para a base `370d65a` e delta de teste `4a0d2d5`.

A regressão ampla detectou um deadlock na limpeza do schema da jornada React. O teardown agora aguarda a saída do Gateway de teste antes de remover o schema. A jornada afetada passou novamente em Chromium e PostgreSQL. Revisão independente favorável para o delta `8b36d65`.

O ensaio de ponta a ponta controlado usou fixtures no ambiente de testes já existente no DEV. A transação revertida no serviço ativo não tornou os aliases visíveis para outras conexões. O ciclo autenticado no painel ativo com a credencial do proprietário e o recebimento real em caixa postal permanecem sem prova neste ensaio.
