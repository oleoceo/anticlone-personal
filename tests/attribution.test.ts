import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributionRules, withAttribution } from '../apps/attribution.js';

const original = 'http://127.0.0.1:8080';
const destination = original + '/checkout?utm_source=offer';
test('F42 allows only explicitly configured public labels for approved destinations', () => {
  const previous = process.env.ATTRIBUTION_ALLOWLIST;
  try {
    process.env.ATTRIBUTION_ALLOWLIST = JSON.stringify({['project']:{legacy:{[destination]:{utm_source:['ads'],utm_campaign:['spring']}}}});
    assert.deepEqual({...attributionRules('project', 'legacy', original)[destination]}, {utm_source:['ads'],utm_campaign:['spring']});
    assert.deepEqual({...attributionRules('other', 'legacy', original)}, {});
    assert.ok(withAttribution({action:'PAGE_REDIRECT',destination}, 'project', 'legacy', original).attribution);
    assert.equal(withAttribution({action:'OBSERVE_ONLY'}, 'project', 'legacy', original).attribution, undefined);
    assert.equal(withAttribution({action:'PAGE_REDIRECT',destination:original+'/other'}, 'project', 'legacy', original).attribution, undefined);
    for (const bad of [{email:['alice']},{utm_source:['alice@example.com']},{utm_source:['x'],token:['secret']}]) {
      process.env.ATTRIBUTION_ALLOWLIST = JSON.stringify({['project']:{legacy:{[destination]:bad}}});
      assert.deepEqual({...attributionRules('project', 'legacy', original)}, {});
    }
    process.env.ATTRIBUTION_ALLOWLIST = JSON.stringify({['project']:{legacy:{'https://attacker.test/':{utm_source:['ads']}}}});
    assert.deepEqual({...attributionRules('project', 'legacy', original)}, {});
  } finally { if (previous === undefined) delete process.env.ATTRIBUTION_ALLOWLIST; else process.env.ATTRIBUTION_ALLOWLIST=previous; }
});
