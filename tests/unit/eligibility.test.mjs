import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewDocumentAcceptance,matchingCurrentAcceptance} from '../../packages/competition/src/eligibility.mjs';
const accepted=()=>({tenantId:'tenant-1',participantId:'person-1',documentId:'release-1',
 documentRevision:2,documentHash:'a'.repeat(64),acceptedAt:'2026-10-18T12:00:00.000Z'});
test('acceptance binds exact immutable revision and hash',()=>{
 const r=reviewDocumentAcceptance(accepted());assert.ok(Object.isFrozen(r));
 assert.equal(matchingCurrentAcceptance(r,accepted()),true);
 assert.equal(matchingCurrentAcceptance(r,{...accepted(),documentRevision:3}),false);
 assert.equal(matchingCurrentAcceptance(r,{...accepted(),documentHash:'b'.repeat(64)}),false);
});
test('unknown fields, malformed timestamps, and hashes rejected',()=>{
 for(const patch of [{consent:true},{documentHash:'invalid'},
 {documentRevision:-1},{acceptedAt:'yesterday'},{participantId:'../tenant'}])
 assert.throws(()=>reviewDocumentAcceptance({...accepted(),...patch}));
});

test('receipt identifiers and hashes never accept string coercion',()=>{
 for(const key of ['tenantId','participantId','documentId','documentHash']) {
  for(const value of [42,[accepted()[key]],{toString:()=>accepted()[key]}])
   assert.throws(()=>reviewDocumentAcceptance({...accepted(),[key]:value}));
 }
 assert.throws(()=>reviewDocumentAcceptance({...accepted(),documentRevision:1_000_001}));
});

test('canonical millisecond timestamps match history without accepting normalized invalid dates',()=>{
 assert.equal(reviewDocumentAcceptance({...accepted(),acceptedAt:'2026-10-18T12:00:00.123Z'}).acceptedAt,'2026-10-18T12:00:00.123Z');
 for(const acceptedAt of ['2026-02-30T12:00:00.000Z','2026-10-18T12:00:00Z','2026-10-18T12:00:00.1230Z','2026-10-18T12:00:00.000+00:00'])
  assert.throws(()=>reviewDocumentAcceptance({...accepted(),acceptedAt}));
});

