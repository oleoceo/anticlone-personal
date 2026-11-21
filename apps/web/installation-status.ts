export type InstallationIssue = {code: string; role?: string};
export type InstallationStatus = {
  state: 'PUBLISHED' | 'NOT_PUBLISHED' | 'NOT_INSTALLED';
  publication: {ready: boolean; defaultsReady?: boolean; issues: InstallationIssue[]; rotationAvailable: boolean; changesRequired: boolean};
  verification: {ready: boolean; issue: string | null};
  diagnostic?: {
    status: string;
    controlledVerification: {status: string; reason: string; checkedAt?: string; layers?: Record<string, boolean>};
    signals: {source: string; last_observed_at: string}[];
    layers: {layer: string; status: string; controlled: 'OBSERVED' | 'NOT_OBSERVED' | 'NOT_TESTED'}[];
  };
};

export const roleLabels = {SCRIPT: 'Scripts', TELEMETRY: 'Telemetria', STATIC_ASSETS: 'Recursos estáticos'};
export const healthPath = '/configuracoes/operacoes';

export const telemetryEndpointLabels = {
  DISABLED: 'Desativado para novas revisões',
  NOT_AUTHORIZED: 'Aguardando autorização no ambiente privado',
  UNVERIFIED: 'Aguardando verificação do endpoint',
  DNS_FAILED: 'DNS não validado',
  HTTPS_FAILED: 'HTTPS não validado',
  GATEWAY_NOT_READY: 'Gateway indisponível no endpoint',
  OPERATIONAL: 'Operacional',
};

export const installationMessages: Record<string, string> = {
  TELEMETRY_ORIGIN_UNAVAILABLE: 'O endpoint de telemetria está desativado, sem autorização ou sem verificação operacional. Atualize a situação ou escolha outro endpoint.',
  RUNTIME_ORIGIN_MISSING: 'Falta uma origem de runtime na configuração privada. Configure RUNTIME_PUBLIC_ORIGIN ou a origem específica do papel.',
  RUNTIME_ORIGIN_INVALID: 'A origem de runtime é inválida. Revise a configuração privada e informe apenas a origem, sem caminho nem barra final.',
  RUNTIME_ADMIN_HOST_CONFLICT: 'A origem de runtime usa o mesmo host do painel administrativo. Configure um host distinto.',
  DISTRIBUTION_SCHEMA_MISSING: 'A distribuição ainda não foi instalada no banco. Aplique as migrações de distribuição ao ambiente autorizado.',
  ROTATION_SCHEMA_MISSING: 'A rotação exige a migração 053 no banco deste ambiente.',
  INSTALLATION_NOT_PUBLISHED: 'Gere os endereços e instale os trechos na página oficial para iniciar a verificação.',
  INACTIVE_INSTALLATION: 'O projeto e a LP precisam estar ativos para a verificação. Confira o ciclo de vida da oferta.',
  SINGLE_OFFICIAL_URL_REQUIRED: 'A verificação exige uma única URL oficial. Conclua a transição de URLs na LP.',
  VERIFIER_HTTPS_REQUIRED: 'O verificador exige endereços HTTPS públicos na porta padrão para a LP e os recursos publicados. Para uma instalação local, confira os sinais de acesso.',
  ISOLATED_VERIFIER_UNAVAILABLE: 'Verificador isolado sem configuração. O responsável pelo ambiente precisa habilitá-lo no admin privado.',
  VERIFIER_IMAGE_INVALID: 'A referência da imagem do verificador é inválida. Revise INSTALLATION_VERIFIER_IMAGE no admin privado.',
  VERIFIER_SCHEMA_MISSING: 'A verificação controlada exige a migração 056 no banco deste ambiente.',
  NO_CURRENT_VERIFICATION: 'Sem prova para a configuração e revisão atuais. Instale os trechos e execute a verificação.',
  CONFIGURATION_CHANGED: 'A configuração mudou durante o teste. Confira a revisão e execute uma nova verificação.',
  VERIFICATION_SUPERSEDED: 'O resultado mais recente mudou enquanto a tela consultava a instalação. Confira o diagnóstico atual.',
  OFFICIAL_SITE_UNAVAILABLE: 'O verificador não conseguiu carregar a URL oficial. Confira DNS, HTTPS e a resposta do site antes de repetir o teste.',
  CHECK_FAILED: 'O teste ficou inconclusivo. Confira a URL oficial, o DNS, o TLS e a disponibilidade dos recursos e do verificador.',
  ISOLATION_POLICY_NOT_REPRODUCED: 'A política de isolamento do site impediu a reprodução da carga no verificador.',
  CONTAINER_CLEANUP_FAILED: 'O verificador isolado não confirmou o encerramento. Solicite a conferência do serviço privado antes de tentar de novo.',
  ALL_INSTALLATION_CHANNELS_OBSERVED: 'Todos os canais previstos foram comprovados na carga ensaiada.',
  CHANNELS_UNAVAILABLE: 'Alguns ou todos os canais ficaram sem prova nesta carga. Confira os trechos e as permissões de script, conexão e imagem na CSP da página.',
};

export function publicationIssueMessages(issues: InstallationIssue[]) {
  const groups = new Map<string, string[]>();
  for (const issue of issues) {
    const roles = groups.get(issue.code) ?? [];
    const role = issue.role && roleLabels[issue.role as keyof typeof roleLabels];
    if (role) roles.push(role);
    groups.set(issue.code, roles);
  }
  return [...groups].map(([code,roles]) =>
    (roles.length ? roles.join(', ') + ' · ' : '') + installationMessages[code]);
}

export function publicationLabel(data: InstallationStatus) {
  if (data.state==='PUBLISHED') return data.publication.changesRequired ? 'Publicada · origens alteradas' : 'Endereços publicados';
  return data.publication.ready ? 'Pronta para publicar' : 'Publicação bloqueada';
}
