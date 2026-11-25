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
