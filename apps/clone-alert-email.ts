export type CloneAlert = {
  outboxId: string;
  incidentId: string;
  project: string;
  host: string;
  projectName?: string | null;
  pageName?: string | null;
  firstSeen?: Date | null;
  status?: string;
  risk?: string | null;
  confidence?: string | null;
  sources?: string[];
};

const sourceLabels = {
  core: 'Runtime principal (Core)',
  fallback: 'Runtime de contingência (Fallback)',
  html_canary: 'Canário HTML',
  css_canary: 'Canário CSS',
};
const riskLabels = {LOW: 'Baixo', HIGH: 'Alto', UNCERTAIN: 'Incerto', ERROR: 'Erro na avaliação'};
const confidenceLabels = {insufficient: 'Insuficiente', test_only: 'Somente ambiente de teste'};
const states = {
  unverified: ['Não verificado', 'Clonagem ainda não confirmada. Os sinais são declarações recebidas do navegador, sem verificação independente.', 'Compare a LP autorizada com as evidências registradas e classifique o incidente.'],
  investigating: ['Em investigação', 'Clonagem ainda não confirmada. Os sinais registrados exigem revisão.', 'Revise as evidências e registre a conclusão da investigação.'],
  confirmed_copy: ['Cópia confirmada na triagem', 'A confirmação foi registrada na triagem administrativa.', 'Revise a decisão e as medidas registradas no incidente.'],
  false_positive: ['Falso positivo', 'A triagem administrativa classificou o incidente como falso positivo.', 'Consulte a decisão registrada se precisar revisar o caso.'],
};

function lookup<T>(labels: Record<string, T>, key?: string | null): T | undefined {
  return key && Object.hasOwn(labels, key) ? labels[key] : undefined;
}

function display(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 253);
}

function escapeHtml(value: string): string {
  const entities: Record<string, string> = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
  return value.replace(/[&<>"']/g, character => entities[character]);
}

export function cloneAlertEmail(alert: CloneAlert) {
  const state = lookup(states, alert.status);
  const title = 'Observação de domínio';
  const pageName = display(alert.pageName ?? '');
  const subject = `AntiClone | Incidente #${alert.incidentId} · ${state?.[0] ?? 'Revisão de domínio'}`;
  const lines: [string, string][] = [
    ['Incidente', `#${alert.incidentId}`],
    ['Projeto', [display(alert.projectName ?? ''), `ID ${display(alert.project)}`].filter(Boolean).join(' · ')],
    ['LP', pageName ? `${pageName} (referenciada em recibo de runtime)` : 'Sem associação única nos recibos disponíveis'],
    ['Domínio observado', display(alert.host)],
    ['Primeira detecção (UTC)', alert.firstSeen
      ? new Intl.DateTimeFormat('pt-BR', {day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC'}).format(alert.firstSeen)
      : 'Indisponível'],
    ['Risco do domínio no projeto', lookup(riskLabels, alert.risk) ?? 'Sem avaliação registrada'],
    ['Confiança', lookup(confidenceLabels, alert.confidence) ?? 'Indisponível'],
    ['Fontes de sinais', [...new Set(alert.sources)].map(source => lookup(sourceLabels, source)).filter(Boolean).join(', ') || 'Sem fontes registradas'],
    ['Evidências', state?.[1] ?? 'A confirmação de clonagem está indisponível para este incidente.'],
    ['Estado', state?.[0] ?? 'Indisponível'],
    ['Ação recomendada', state?.[2] ?? 'Abra o incidente para revisar os dados disponíveis.'],
    ['Admin Dev', 'Entre pelo endereço privado que você já usa e abra Projetos → projeto → Incidentes.'],
    ['Caminho após autenticação', `/admin/ui/novo/projetos/${encodeURIComponent(alert.project)}/incidentes/${alert.incidentId}`],
  ];
  const text = [title, '', ...lines.map(([label, value]) => `${label}: ${value}`)].join('\n');
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:16px;background:#eef2f6;color:#182638;font:16px/1.5 Arial,sans-serif">
<main style="box-sizing:border-box;max-width:640px;margin:auto;padding:24px;background:#fff;border-top:5px solid #235482;overflow-wrap:anywhere">
<p style="margin:0;color:#235482;font-weight:bold">AntiClone Personal</p>
<h1 style="margin:4px 0 20px;font-size:26px">${title}</h1>
${lines.map(([label, value]) => `<p style="margin:0 0 14px"><strong>${label}</strong><br>${escapeHtml(value)}</p>`).join('\n')}
</main></body></html>`;
  return {subject, text, html};
}
