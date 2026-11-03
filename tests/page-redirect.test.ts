import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvedDestination, entryDecision } from '../apps/page-redirect.js';

const original = 'http://127.0.0.1:8080', clone = 'http://localhost:8080';
const policy = { version: 1, enabled: true, approved_destination: original + '/approved', allocation:{PAID_ATTRIBUTED:100,ORGANIC:100,REFERRAL:100,DIRECT_UNKNOWN:100} };
test('entry policy requires server-controlled LOW and an approved destination', () => {
  assert.equal(entryDecision(policy, original, clone, clone, 'LOW', '0123456789abcdef0123456789abcdef', 'DIRECT_UNKNOWN').action, 'PAGE_REDIRECT');
  for (const risk of ['HIGH', 'UNCERTAIN', undefined]) assert.equal(entryDecision(policy, original, clone, clone, risk, '0123456789abcdef0123456789abcdef', 'DIRECT_UNKNOWN').action, 'OBSERVE_ONLY');
  assert.equal(entryDecision(policy, original, original, clone, 'LOW', '0123456789abcdef0123456789abcdef', 'DIRECT_UNKNOWN').action, 'OBSERVE_ONLY');
  assert.equal(entryDecision(policy, original, clone, undefined, 'LOW', '0123456789abcdef0123456789abcdef', 'DIRECT_UNKNOWN').action, 'OBSERVE_ONLY');
  assert.equal(entryDecision({...policy, enabled:false}, original, clone, clone, 'LOW', '0123456789abcdef0123456789abcdef', 'DIRECT_UNKNOWN').action, 'OBSERVE_ONLY');
  for (const destination of ['javascript:alert(1)', 'http://evil.test/', 'http://127.0.0.1:8080@evil.test/', original + '/#x', original + '/\\evil']) {
    assert.throws(() => approvedDestination(destination, original));
    assert.equal(entryDecision({...policy, approved_destination:destination}, original, clone, clone, 'LOW', '0123456789abcdef0123456789abcdef', 'DIRECT_UNKNOWN').action, 'OBSERVE_ONLY');
  }
});
