export const abbreviatedPaths: Record<string, string> = {
  'runtime.js':'a.js', 'core.js':'b.js', 'fallback.js':'c.js', 'observe':'e',
  'observe/fallback':'f', 'entry-decision':'g', 'cta-refresh':'h',
  'observed-session':'j', 'observed-action':'k', 'html.gif':'m.gif',
  'css.gif':'n.gif', 'cta-inventory.js':'p.js',
};

export const compactPaths: Record<string, string> = {
  'runtime.js':'app.js', 'core.js':'common.js', 'fallback.js':'events.js', 'observe':'collect',
  'observe/fallback':'report', 'entry-decision':'config', 'cta-refresh':'refresh',
  'observed-session':'session', 'observed-action':'activity', 'html.gif':'pixel.gif',
  'css.gif':'style.gif', 'cta-inventory.js':'inventory.js',
};

export function distributionPaths(contractVersion: number) {
  if (contractVersion === 3) return compactPaths;
  if (contractVersion === 2) return abbreviatedPaths;
}

export const namedDistributionSchema = `EXISTS (SELECT 1 FROM pg_constraint
  WHERE conrelid=to_regclass('runtime_distributions') AND conname='runtime_distributions_named_contract_check')`;

export const assetFileContract = 4;
export const assetProbeToken = '00000000000000000000';

export const assetFilePatterns: Record<string, string> = {
  'runtime.js':'js/app.*.js', 'core.js':'js/common.*.js', 'fallback.js':'js/events.*.js',
  'observe':'api/collect.*', 'observe/fallback':'api/report.*', 'entry-decision':'api/config.*',
  'cta-refresh':'api/refresh.*', 'observed-session':'api/session.*', 'observed-action':'api/activity.*',
  'html.gif':'img/pixel.*.gif', 'css.gif':'img/style.*.gif', 'cta-inventory.js':'js/inventory.*.js',
};

export const distributionRoleByResource: Record<string, 'SCRIPT'|'TELEMETRY'|'STATIC_ASSETS'> = {
  'runtime.js':'SCRIPT', 'core.js':'SCRIPT', 'fallback.js':'SCRIPT',
  'observe':'TELEMETRY', 'observe/fallback':'TELEMETRY', 'entry-decision':'TELEMETRY',
  'cta-refresh':'TELEMETRY', 'observed-session':'TELEMETRY', 'observed-action':'TELEMETRY',
  'html.gif':'STATIC_ASSETS', 'css.gif':'STATIC_ASSETS', 'cta-inventory.js':'STATIC_ASSETS',
};

export const assetFileDistributionSchema = `EXISTS (SELECT 1 FROM pg_constraint
  WHERE conrelid=to_regclass('runtime_distributions') AND conname='runtime_distributions_asset_file_contract_check')`;
