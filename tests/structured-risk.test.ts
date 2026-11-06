import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessEvidence, stealthEligible, type StructuredEvidence } from '../apps/risk.js';

const receipt: StructuredEvidence = {type:'gateway_receipt',provenance:'gateway',reliability:'observed',validity:'current'};
const claim: StructuredEvidence = {type:'traffic_claim',provenance:'browser',reliability:'uncorroborated',validity:'current'};
test('structured risk never treats browser claims and gateway receipt as independent operator evidence', () => {
  for (const signals of [[],[claim],[receipt],[claim,receipt],[claim,receipt,{...claim,validity:'stale' as const}],
    [claim,receipt,{type:'contradiction' as const,provenance:'browser' as const,reliability:'uncorroborated' as const,validity:'current' as const}],
    [claim,receipt,{type:'collection_gap' as const,provenance:'gateway' as const,reliability:'unknown' as const,validity:'current' as const}]]) {
    const result=assessEvidence(signals,false);
    assert.equal(result.level,'UNCERTAIN'); assert.equal(result.version,'conservative-risk-v4');
    assert.equal(stealthEligible(result,false),false); assert.deepEqual(result,assessEvidence(signals,false));
  }
  assert.equal(assessEvidence([],true).level,'UNCERTAIN');
  assert.equal(assessEvidence([receipt,{...claim,validity:'stale'}],true).level,'UNCERTAIN');
  const lab=assessEvidence([receipt,claim],true); assert.equal(lab.level,'LOW'); assert.equal(stealthEligible(lab,false),true);
  assert.equal(stealthEligible(lab,true),false);
});

test('limitations are deterministic and correlated claims cannot establish independence', () => {
  const gap: StructuredEvidence = {type:'collection_gap',provenance:'gateway',reliability:'unknown',validity:'unknown'};
  const conflict: StructuredEvidence = {type:'contradiction',provenance:'browser',reliability:'uncorroborated',validity:'current'};
  const result = assessEvidence([receipt, ...Array(30).fill(claim) as StructuredEvidence[], gap, conflict], false);
  assert.deepEqual(result.limitations, ['INDEPENDENT_EVIDENCE_NOT_AVAILABLE','PROVENANCE_NOT_VERIFIABLE','EVIDENCE_EXPIRED_OR_UNKNOWN','COLLECTION_GAP','CONTRADICTORY_EVIDENCE']);
  assert.equal(result.level,'UNCERTAIN');
  assert.equal(stealthEligible(result,false),false);
  assert.equal(assessEvidence([receipt,gap],true).level,'UNCERTAIN');
  assert.equal(assessEvidence([receipt,conflict],true).level,'UNCERTAIN');
  assert.deepEqual(assessEvidence([],false).limitations,['INDEPENDENT_EVIDENCE_NOT_AVAILABLE','NO_EVIDENCE']);
});
