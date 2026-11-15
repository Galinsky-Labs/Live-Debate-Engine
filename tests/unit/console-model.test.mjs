import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceCommand, nextPhase, overtime, remainingSeconds, roleActions } from '../../dist/packages/ui/src/console-model.js';
import { PHASES } from '../../dist/packages/contracts/src/domain.js';
import { nextPhase as serverNext } from '../../dist/packages/competition/src/operations/live.js';
import { timerReading } from '../../dist/packages/competition/src/operations/floor.js';

test('browser console model matches the authoritative server ordering and timer arithmetic', () => {
  for (const phase of PHASES) assert.equal(nextPhase(phase), serverNext(phase), phase);
  assert.equal(advanceCommand('verification'), 'announce'); assert.equal(advanceCommand('announcement'), 'close'); assert.equal(advanceCommand('closed'), null);
  const timer = { status: 'running', allottedMs: 60000, elapsedMs: 10000, runningSince: '2027-01-01T00:00:00.000Z', graceMs: 5000, protectedMs: 0 };
  for (const s of [0, 30, 49, 52, 70]) {
    const now = Date.parse('2027-01-01T00:00:00.000Z') + s * 1000;
    assert.equal(remainingSeconds(timer, now), Math.max(0, Math.ceil(timerReading(timer, new Date(now).toISOString()).remainingMs / 1000)));
  }
  assert.equal(overtime(timer, Date.parse('2027-01-01T00:00:53.000Z')), 'grace'); assert.equal(overtime(timer, Date.parse('2027-01-01T00:01:00.000Z')), 'overtime');
});
test('role actions are limited per console', () => {
  const live = { phase: 'discussion', suspended: false, readiness: [], sequence: 3 };
  const floor = { speakerId: 'a', segment: 's', timer: { status: 'running', allottedMs: 1, elapsedMs: 0, runningSince: null, graceMs: 0, protectedMs: 0 }, requests: [], points: [{ pointId: 'p', kind: 'information', raisedBy: 'b', status: 'pending' }] };
  assert.deepEqual(roleActions('moderator', live, floor, 'm'), ['advance', 'suspend']);
  assert.deepEqual(roleActions('timekeeper', live, floor, 't'), ['pause', 'stop', 'adjust']);
  assert.deepEqual(roleActions('debater', live, floor, 'a'), ['respondPoint']);
  assert.deepEqual(roleActions('debater', live, floor, 'b'), ['raisePoint', 'requestFloor']);
  assert.deepEqual(roleActions('producer', { ...live, phase: 'verification' }, floor, 'p'), ['announce']);
});
