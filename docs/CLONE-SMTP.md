# Transporte de alertas de clone

F26/GS02/GS13 usa o outbox existente por incidente, com até três tentativas,
intervalo de um minuto, orçamento global de dez tentativas por hora e expiração
em 24 horas. A migration aditiva `033_clone_delivery_attempts.sql` registra início,
fim, transporte e resultado de cada tentativa. A retenção acompanha o incidente
(30 dias); exclusão do outbox remove seu histórico. `UNKNOWN` significa reserva
durável sem resultado persistido, inclusive interrupção de processo. `FAILED`
significa erro observado pelo cliente, sem garantir rejeição do provedor.

O provedor autorizado é configurado no ambiente privado do gateway:

```text
SMTP_PROVIDER=smtp
SMTP_HOST=<hostname do provedor autorizado>
SMTP_PORT=<porta>
SMTP_TLS=implicit
SMTP_SENDER=<remetente autorizado>
SMTP_RECIPIENT=<destinatário único autorizado>
SMTP_USER=<usuário privado>
SMTP_PASSWORD=<senha privada>
```

`SMTP_PROVIDER` aceita `smtp` ou `brevo` (SMTP autenticado, sem API proprietária).
`SMTP_TLS` aceita `implicit` ou `starttls`; TLS 1.2 ou superior e certificado válido
são obrigatórios. Não há opção para aceitar certificado inválido ou transmitir
credenciais sem TLS. Arquivos de ambiente permanecem fora do Git, com acesso
restrito ao operador. Não passar segredos por argumentos de linha de comando.
O mesmo ambiente no admin permite consultar somente a compatibilidade da
configuração, nunca usuário ou senha. O estado do admin não comprova a conexão
do gateway, que é um processo independente.

Após aplicar a migration 033 em ambiente autorizado, reiniciar o gateway. No painel
existente, salvar os seis campos públicos e solicitar habilitação. Todos devem
coincidir exatamente com o ambiente privado; divergência ou desativação impede
novas tentativas do transporte configurado. Uma tentativa já iniciada pode concluir.
Alteração de credenciais/destino privado exige reinício. Sem migration, o gateway
configurado recusa iniciar. Não usar campos enviados por navegador como autoridade
para conectar a destinos SMTP arbitrários.

O envio ocorre fora da decisão do runtime e tem prazo total de dez segundos,
com destruição da conexão ao expirar. O painel de incidentes mostra estado do
outbox e tentativas, sem mensagens de erro SMTP ou credenciais. Aceitação pelo
transporte não comprova entrega na caixa postal. Falha de persistência após
aceitação ou interrupção pode gerar duplicata no retry; Message-ID é estável,
sem promessa de exactly-once. Um incidente preserva sinal não verificado até
triagem explícita; o e-mail não confirma identidade nem autoria.

Sem `SMTP_PROVIDER`, preserva-se o laboratório anterior: loopback e endereços
sintéticos fixos. As migrations 057/058 e a [Frente 2](PRE-VPS-FRONT2.md)
estendem o mesmo provedor para CTA/saúde, com histórico de tentativas e revisão
auditada de backlog. Com provedor configurado, saúde não usa uma porta local
derivada do provedor. O worker independente pode alertar sobre falha do backend
local; isso não comprova disponibilidade pública nem entrega na caixa postal.

Prova reproduzível: `npm run build` e
`node --test dist/tests/smtp-provider.test.js`, com `TEST_DATABASE_URL` de
PostgreSQL isolado e Chromium instalado. O teste usa credenciais sintéticas,
certificado local efêmero e trust adicional apenas nos subprocessos de teste.
Cobre TLS implícito, STARTTLS, rejeição de certificado não confiável, falha de
autenticação, retry/reinício, original preservado, cópia em outro hostname,
deduplicação, consulta autenticada, isolamento de projetos e prazo total em
SMTP lento. Não usa contas externas nem comprova entrega externa.
