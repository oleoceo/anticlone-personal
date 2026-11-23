// Canonical browser navigation URL. No DNS resolution or network request is performed.
export function normalizeHttpsAddress(raw: unknown): string {
  if (typeof raw !== 'string') throw new TypeError('invalid HTTPS address');
  const value = raw.trim();
  if (!value || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/u.test(value) || value.startsWith('/')) {
    throw new TypeError('invalid HTTPS address');
  }
  const input = value.includes('://') && /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'https://' + value;
  if (!/^https:\/\/[^/?#]/i.test(input) || /^https:\/\/[^/?#]*@/i.test(input)) throw new TypeError('invalid HTTPS address');
  const url = new URL(input);
  const host = url.hostname.replace(/\.$/, '');
  const labels = host.split('.');
  if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048 ||
      host.length > 253 || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      !/[a-z]/.test(labels.at(-1) ?? '') || /\.(localhost|local|internal|invalid|onion)$/.test(host)) {
    throw new TypeError('invalid HTTPS address');
  }
  return url.href;
}
