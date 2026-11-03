import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selected, validateAllocation } from '../apps/allocation.js';
const values = {PAID_ATTRIBUTED:100, ORGANIC:50, REFERRAL:0, DIRECT_UNKNOWN:50};
const session = (n: number) => n.toString(16).padStart(32,'0');
test('allocation validates all classes and ten-point increments', () => {
  for (let n=0; n<=100; n+=10) assert.equal(validateAllocation({...values, ORGANIC:n}).ORGANIC,n);
  for (const n of [-10, 101, 5, 50.1, '50', null]) assert.throws(() => validateAllocation({...values, ORGANIC:n}));
  assert.throws(() => validateAllocation({...values, extra:10}));
  assert.throws(() => validateAllocation({PAID_ATTRIBUTED:100}));
});
test('allocation is stable, independently classed and varies by rule and version', () => {
  const input=validateAllocation(values);
  for (let n=0;n<1000;n++) {
    const id=session(n); assert.equal(selected(id,'PAGE_REDIRECT',1,input,'PAID_ATTRIBUTED'),true); assert.equal(selected(id,'PAGE_REDIRECT',1,input,'REFERRAL'),false);
    assert.equal(selected(id,'PAGE_REDIRECT',1,input,'ORGANIC'),selected(id,'PAGE_REDIRECT',1,input,'ORGANIC'));
  }
  assert.ok(Array.from({length:1000},(_,n)=>session(n)).some(id=>selected(id,'PAGE_REDIRECT',1,input,'ORGANIC')!==selected(id,'OTHER_RULE',1,input,'ORGANIC')));
  assert.ok(Array.from({length:1000},(_,n)=>session(n)).some(id=>selected(id,'PAGE_REDIRECT',1,input,'ORGANIC')!==selected(id,'PAGE_REDIRECT',2,input,'ORGANIC')));
  for (const invalid of [undefined,'','abc',session(1).toUpperCase()+'x']) assert.equal(selected(invalid,'PAGE_REDIRECT',1,input,'ORGANIC'),false);
  assert.equal(selected(session(1),'PAGE_REDIRECT',1,input,'FORGED'),false);
});
test('50% over 10000 deterministic identities falls within three percentage points', () => {
  const count=Array.from({length:10000},(_,n)=>selected(session(n),'PAGE_REDIRECT',1,validateAllocation(values),'ORGANIC')).filter(Boolean).length;
  assert.ok(count>=4700 && count<=5300, String(count));
});
