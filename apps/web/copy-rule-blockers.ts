import type {RedirectStatus} from './page-redirect-controls';

const pageBlockers: Record<string,string> = {
  REDIRECT_SCHEMA_REQUIRED:'Atualize o banco do Admin para habilitar as regras por cópia.',
  LP_INACTIVE:'Reative o projeto e a LP antes de ativar a regra.',
  LP_URL_REQUIRED:'Mantenha uma única URL oficial cadastrada para esta LP.',
  RUNTIME_NOT_PUBLISHED:'Publique a instalação desta LP.',
  CONTROL_GATEWAY_UNCONFIGURED:'Configure ADMIN_OPERATIONAL_GATEWAY_ORIGIN no Admin privado.',
  TELEMETRY_NOT_REGISTERED:'O endpoint publicado não está no pool de telemetria. Confira a instalação e o cadastro do endpoint no pool.',
  TELEMETRY_DISABLED:'O endpoint publicado está desabilitado. Confira se ele deve ser reativado no pool de telemetria.',
  TELEMETRY_NOT_AUTHORIZED:'O endpoint publicado está fora da lista de origens permitidas no Dev. Confira a autorização desse endpoint.',
  TELEMETRY_UNVERIFIED:'O endpoint publicado ainda não tem uma verificação válida. Verifique o endpoint no pool de telemetria.',
  TELEMETRY_DNS_FAILED:'A verificação DNS do endpoint publicado falhou. Confira a resolução do domínio e verifique o endpoint novamente.',
  TELEMETRY_HTTPS_FAILED:'A verificação HTTPS do endpoint publicado falhou. Confira o acesso HTTPS e verifique o endpoint novamente.',
  TELEMETRY_GATEWAY_NOT_READY:'A verificação do pool não confirmou o modo operacional. Confira a saúde do gateway e verifique o endpoint novamente.',
  TELEMETRY_MISMATCH:'O endpoint de telemetria da instalação não está habilitado, autorizado ou verificado. Confira o endpoint publicado na instalação e verifique seu estado no pool de telemetria.',
};

export function copyRuleBlocker(issue: string | null, gateway: RedirectStatus['gateway'], contract: number) {
  if (issue) return pageBlockers[issue] ?? `Revise a instalação e o estado da LP. Impedimento informado pela API (${issue}).`;
  switch (gateway) {
    case 'OPERATIONAL': return null;
    case 'OBSERVATION_ONLY': return 'O gateway da instalação está em modo de observação. Confira se o gateway correto está no modo operacional.';
    case 'INCOMPATIBLE': return `O gateway da instalação não atende ao contrato ${contract}. Verifique a versão em execução no gateway.`;
    case 'UNREACHABLE': return 'O Admin não conseguiu validar a saúde do gateway da instalação. Confira a disponibilidade HTTPS do gateway e atualize o painel.';
    case 'UNCONFIGURED': return 'Verifique a publicação da instalação e a autorização do seu endpoint de telemetria.';
  }
}
