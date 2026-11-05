/** Standalone laboratory interpreter. No production caller or protection integration. */
export const currencies = Object.freeze({
  BRL: { scale: 2, symbols: ['R$'] }, USD: { scale: 2, symbols: ['US$'] },
  EUR: { scale: 2, symbols: ['€'] }, GBP: { scale: 2, symbols: ['£'] },
  JPY: { scale: 0, symbols: ['JP¥'] }, KWD: { scale: 3, symbols: ['د.ك'] },
});
type Currency = keyof typeof currencies;
export type Meaning = 'PRICE_CURRENT' | 'PRICE_PREVIOUS' | 'SAVINGS' | 'INSTALLMENT' | 'RECURRING' | 'UNKNOWN';
export interface TextEvidence { text: string; struck?: boolean }
export interface Candidate {
  raw: string; currency: Currency | null; minorUnits: string | null; scale: number | null;
  status: 'RESOLVED' | 'UNRESOLVED' | 'REJECTED'; meaning: Meaning;
  evidence: string; reason: string;
}
const MAX_TEXT = 512;
const aliases = Object.entries(currencies).flatMap(([code, rule]) => [code, ...rule.symbols]);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const token = [...aliases, '$', '\u00a5'].sort((a,b) => b.length-a.length).map(escape).join('|');
// Consume the complete numeric-looking token, including malformed separators.
const number = '[0-9][0-9_\u066b\u066c\uff0e.,\u00a0\u202f\x20\u0027]*[0-9]|[0-9]';
const pattern = new RegExp(`(?:(?:${token})[ \\u00a0\\u202f]*(?:${number})|(?:${number})[ \\u00a0\\u202f]*(?:${token}))`, 'gu');

function amounts(raw: string, scale: number): string[] {
  const results = new Set<string>();
  // Explicit supported regional grammars; no locale inference or rounding.
  for (const decimal of ['.', ',']) {
    const parts = raw.split(decimal);
    const variants: [string,string][] = [[raw, '']];
    if (scale && parts.length === 2 && parts[1].length === scale && /^\d+$/.test(parts[1])) variants.push([parts[0], parts[1]]);
    for (const [integer, fraction] of variants) {
      const groups = [decimal === '.' ? ',' : '.', ' ', '\u00a0', '\u202f', "'"];
      const valid = /^(?:0|[1-9]\d*)$/.test(integer) || groups.some(g => new RegExp(`^[1-9][0-9]{0,2}(?:${escape(g)}[0-9]{3})+$`).test(integer));
      if (!valid) continue;
      const digits = integer.replace(/[., '\u00a0\u202f]/g, '');
      if (digits.length > 18) continue;
      results.add(BigInt(digits + fraction.padEnd(scale, '0')).toString());
    }
  }
  return [...results];
}

function classify(template: string, struck: boolean): { meaning: Meaning; reason: string } {
  const t = template.trim().toLowerCase().replace(/\s+/g, ' ');
  const rules: [Meaning, RegExp][] = [
    ['PRICE_CURRENT', /^(?:preço(?: atual| promocional)?|price|now|agora|por|total|valor total)\s*:?\s*@$/u],
    ['PRICE_PREVIOUS', /^(?:(?:de|antes|was|preço anterior)\s*:?\s*)?@$/u],
    ['SAVINGS', /^(?:economize|economia|save|savings)\s*:?\s*@$/u],
    ['INSTALLMENT', /^(?:[1-9][0-9]?\s*x\s*(?:de\s*)?@(?:\s*sem juros)?|parcela\s*:?\s*@)$/u],
    ['RECURRING', /^(?:(?:assinatura|subscription)\s*:?\s*)?@\s*(?:\/\s*(?:mês|mes|month|ano|year)|por (?:mês|mes|ano)|per (?:month|year))$/u],
  ];
  const matches = rules.filter(([meaning, re]) => re.test(t) && (meaning !== 'PRICE_PREVIOUS' || struck || t !== '@')).map(([m]) => m);
  if (struck && !matches.includes('PRICE_PREVIOUS')) matches.push('PRICE_PREVIOUS');
  if (matches.length !== 1) return { meaning: 'UNKNOWN', reason: matches.length ? 'Conflicting commercial evidence' : 'No complete supported commercial phrase' };
  return { meaning: matches[0], reason: matches[0] === 'PRICE_PREVIOUS' && struck ? 'Visible strike-through evidence' : 'Complete explicit commercial phrase' };
}

export function interpretText(input: TextEvidence): Candidate[] {
  if (!input || typeof input.text !== 'string' || input.text.length > MAX_TEXT || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(input.text)) return [];
  const text = input.text;
  const matches = [...text.matchAll(pattern)];
  return matches.slice(0, 32).map(match => {
    const raw = match[0].trim();
    const index = match.index!;
    const tags = raw.match(new RegExp(token, 'gu')) ?? [];
    const tag = tags[0] ?? '';
    const currency = (Object.keys(currencies) as Currency[]).find(c => c === tag || (currencies[c].symbols as readonly string[]).includes(tag)) ?? null;
    const candidate: Candidate = { raw, currency, minorUnits: null, scale: currency ? currencies[currency].scale : null, status: 'UNRESOLVED', meaning: 'UNKNOWN', evidence: text, reason: 'Ambiguous currency symbol' };
    const before = text.slice(0,index), after = text.slice(index+match[0].length);
    if (/[\p{L}\p{N}.,+\-−$€£¥]$/u.test(before) || /^[\p{L}\p{N}%.,$€£¥]/u.test(after) || tags.length !== 1) return { ...candidate, status: 'REJECTED', reason: 'Invalid token boundary' };
    if (!currency) return candidate;
    if (new RegExp(token, 'u').test(before + after)) return { ...candidate, status: 'UNRESOLVED', reason: 'Additional currency evidence in text run' };
    const numeric = raw.replace(tag, '').trim();
    const values = amounts(numeric, currencies[currency].scale);
    if (values.length !== 1) return { ...candidate, status: values.length ? 'UNRESOLVED' : 'REJECTED', reason: values.length ? 'Ambiguous numeric format' : 'Invalid grouping, precision or amount limit' };
    const classification = matches.length === 1 ? classify(before+'@'+after, input.struck === true) : { meaning: 'UNKNOWN' as const, reason: 'Multiple amounts in one text run' };
    return { ...candidate, minorUnits: values[0], status: 'RESOLVED', ...classification };
  });
}

/** Invoke explicitly inside a browser. Reads rendered text; no listeners, writes or I/O. */
export function collectVisibleText(): { status: 'COMPLETE' | 'LIMIT_EXCEEDED'; runs: TextEvidence[] } {
  const runs: TextEvidence[] = [];
  let visited = 0, size = 0, exceeded = false;
  function walk(element: Element, inheritedStrike: boolean): void {
    if (++visited > 20000) { exceeded = true; return; }
    const style = getComputedStyle(element);
    if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','INPUT','TEXTAREA','SELECT'].includes(element.tagName) || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || element.getClientRects().length === 0) return;
    const struck = inheritedStrike || ['DEL','S'].includes(element.tagName) || style.textDecorationLine.includes('line-through');
    let text = '', allStruck = true;
    const flush = () => { if (text.trim()) { runs.push({text: text.trim(), struck: allStruck}); size += text.length; } text = ''; allStruck = true; };
    function inline(parent: Element, strike: boolean): void {
      for (const child of parent.childNodes) {
        if (++visited > 20000 || size + text.length > 20000) { exceeded = true; return; }
        if (child.nodeType === Node.TEXT_NODE) {
          const value = child.textContent ?? '';
          text += value;
          if (value.trim() && !strike) allStruck = false;
        } else if (child instanceof Element) {
          const css = getComputedStyle(child);
          if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','INPUT','TEXTAREA','SELECT'].includes(child.tagName) || css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) === 0 || child.getClientRects().length === 0) continue;
          if (child.tagName === 'BR' || css.display !== 'inline') { flush(); walk(child, strike); }
          else inline(child, strike || ['DEL','S'].includes(child.tagName) || css.textDecorationLine.includes('line-through'));
        }
      }
    }
    inline(element, struck);
    flush();
  }
  if (document.body) walk(document.body, false);
  return exceeded || size > 20000 || runs.length > 256 ? {status:'LIMIT_EXCEEDED', runs:[]} : {status:'COMPLETE', runs};
}
