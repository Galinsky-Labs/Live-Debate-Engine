import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { applyCommand } from '../../dist/packages/competition/src/operations/stream.js';
import { OPERATION_STREAMS } from '../../dist/packages/competition/src/operations/index.js';
import { liveStream } from '../../dist/packages/competition/src/operations/live.js';
import { floorStream, timerReading } from '../../dist/packages/competition/src/operations/floor.js';
import { consoleView } from '../../dist/packages/competition/src/operations/consoles.js';
import { createMediaStream, disabledMediaProvider, simulatedMediaProvider, canPublish } from '../../dist/packages/competition/src/operations/media.js';
import { recordingStream, verifyManifest } from '../../dist/packages/competition/src/operations/recording.js';
import { transcriptStream, attributeSpeaker, renderTranscript } from '../../dist/packages/competition/src/operations/transcript.js';
import { questionsStream } from '../../dist/packages/competition/src/operations/questions.js';

const ids = { entityId: randomUUID(), eventId: randomUUID(), tenantId: randomUUID() };
const staff = randomUUID();
const t0 = Date.UTC(2027, 0, 1, 18, 0);
const at = (seconds) => new Date(t0 + seconds * 1000).toISOString();
function step(stream, state, type, payload, actor = staff, seconds = 0) { return applyCommand(stream, state, type, payload, { actor, now: at(seconds) }).state; }

test('every stream command and read action is in the database allow-list', async () => {
  const sql = (await Promise.all((await readdir('database/migrations')).filter((f) => f.endsWith('.sql')).sort().map((f) => readFile(`database/migrations/${f}`, 'utf8')))).join('\n');
  const rows = new Set([...sql.matchAll(/\('([a-z-]+)','([a-z.-]+)','(write|read)'\)/g)].map((m) => `${m[1]}|${m[2]}|${m[3]}`));
  for (const stream of OPERATION_STREAMS) {
    assert.ok(rows.has(`${stream.name}|${stream.readAction}|read`), `${stream.name} read`);
    for (const [type, command] of Object.entries(stream.commands)) assert.ok(rows.has(`${stream.name}|${command.action}|write`), `${stream.name}.${type} ${command.action}`);
  }
});

test('E-13 state machine: ordered phases, readiness gate, stale-console refusal, suspend and cancel', () => {
  let s = liveStream.initial(ids);
  s = step(liveStream, s, 'advance', { from: 'preparation', to: 'readiness' });
  assert.throws(() => step(liveStream, s, 'advance', { from: 'readiness', to: 'pre-vote' }), /not_ready/);
  for (const item of ['roster-locked', 'eligibility-complete', 'admission-allocated', 'media-ready', 'polls-configured']) s = step(liveStream, s, 'confirmReadiness', { item, confirmed: true });
  s = step(liveStream, s, 'advance', { from: 'readiness', to: 'pre-vote' });
  assert.throws(() => step(liveStream, s, 'advance', { from: 'readiness', to: 'pre-vote' }), /phase_conflict/);
  assert.throws(() => step(liveStream, s, 'advance', { from: 'pre-vote', to: 'discussion' }), /transition_not_allowed/);
  s = step(liveStream, s, 'suspend', { reason: 'Stream outage' });
  assert.throws(() => step(liveStream, s, 'advance', { from: 'pre-vote', to: 'openings' }), /event_suspended/);
  s = step(liveStream, s, 'resume', { reason: 'Stream restored' });
  for (const [from, to] of [['pre-vote', 'openings'], ['openings', 'discussion'], ['discussion', 'questions'], ['questions', 'closings'], ['closings', 'post-vote'], ['post-vote', 'verification']]) s = step(liveStream, s, 'advance', { from, to });
  assert.throws(() => step(liveStream, s, 'advance', { from: 'verification', to: 'announcement' }), /transition_not_allowed/);
  s = step(liveStream, s, 'announce', { from: 'verification', to: 'announcement' });
  assert.throws(() => step(liveStream, s, 'cancel', { reason: 'Too late to cancel now' }), /cannot_cancel/);
  s = step(liveStream, s, 'close', { from: 'announcement', to: 'closed' });
  assert.equal(s.phase, 'closed'); assert.equal(s.history.at(-1).by, staff);
  assert.ok(liveStream.commands.announce.action === 'result.publish' && liveStream.commands.advance.action === 'session.control');
});

test('E-14 timers, grace, adjustments, protected time and points', () => {
  const speaker = randomUUID(); const opponent = randomUUID();
  let s = step(floorStream, floorStream.initial(ids), 'startSpeech', { speakerId: speaker, segment: 'opening-for', seconds: 120, graceSeconds: 10, protectedSeconds: 30 }, staff, 0);
  assert.equal(timerReading(s.timer, at(10)).protected, true);
  assert.throws(() => step(floorStream, s, 'raisePoint', { pointId: randomUUID(), kind: 'information' }, opponent, 10), /protected_time/);
  const poi = randomUUID();
  s = step(floorStream, s, 'raisePoint', { pointId: poi, kind: 'information' }, opponent, 45);
  assert.throws(() => step(floorStream, s, 'respondPoint', { pointId: poi, accept: true }, opponent, 46), /only_speaker_responds/);
  s = step(floorStream, s, 'respondPoint', { pointId: poi, accept: false }, speaker, 46);
  s = step(floorStream, s, 'pause', {}, staff, 60);
  assert.equal(timerReading(s.timer, at(500)).remainingMs, 60000);
  s = step(floorStream, s, 'resume', {}, staff, 100);
  s = step(floorStream, s, 'adjust', { deltaSeconds: 15, reason: 'Technical interruption' }, staff, 101);
  assert.equal(timerReading(s.timer, at(170)).signal, 'warning');
  assert.equal(timerReading(s.timer, at(180)).signal, 'grace');
  assert.equal(timerReading(s.timer, at(200)).signal, 'overtime');
  const order = randomUUID();
  s = step(floorStream, s, 'raisePoint', { pointId: order, kind: 'order' }, opponent, 150);
  s = step(floorStream, s, 'rulePoint', { pointId: order, ruling: 'overruled', note: 'Within the motion scope' }, staff, 151);
  s = step(floorStream, s, 'stop', {}, staff, 190);
  assert.equal(s.log[0].elapsedMs, 150000); assert.equal(s.log[0].endedAt, at(190));
  assert.throws(() => step(floorStream, s, 'raisePoint', { pointId: randomUUID(), kind: 'order' }, opponent, 191), /no_active_speech/);
});

test('E-15 consoles expose role-specific actions only', () => {
  const speaker = randomUUID(); const other = randomUUID();
  const live = liveStream.initial(ids);
  const floor = step(floorStream, floorStream.initial(ids), 'startSpeech', { speakerId: speaker, segment: 'opening', seconds: 60, graceSeconds: 0, protectedSeconds: 0 });
  assert.deepEqual(consoleView('timekeeper', live, floor, at(5), staff).actions, ['pause', 'stop', 'adjust']);
  assert.equal(consoleView('debater', live, floor, at(5), speaker).speaking, true);
  assert.deepEqual(consoleView('debater', live, floor, at(5), other).actions, ['raisePoint', 'requestFloor']);
  assert.equal(consoleView('moderator', live, floor, at(5), staff).nextPhase, 'readiness');
});

test('E-16 media: disabled provider fails closed; simulator confirms facts before recording them', async () => {
  const disabled = createMediaStream(disabledMediaProvider);
  await assert.rejects(disabled.prepare('openRoom', {}, disabled.initial(ids), { actor: staff, now: at(0) }), /media_provider_unconfigured/);
  const provider = simulatedMediaProvider(); const media = createMediaStream(provider); const guest = randomUUID();
  let s = media.initial(ids);
  const run = async (type, payload) => { s = applyCommand(media, s, type, await media.prepare(type, payload, s, { actor: staff, now: at(0) }), { actor: staff, now: at(0) }).state; };
  await run('openRoom', {}); await run('admit', { principalId: guest, role: 'guest' }); await run('mute', { principalId: guest });
  assert.ok(provider.rooms.get(s.providerRoomId).muted.has(guest));
  await run('remove', { principalId: guest, reason: 'Disruptive conduct' });
  await assert.rejects(provider.joinToken(s.providerRoomId, guest, 'guest', false), /join_denied/);
  assert.equal(canPublish('judge'), false); assert.equal(canPublish('debater'), true);
  assert.equal('roomOpened' in media.commands, false);
});

test('E-17 recording requires consent and keeps a verifiable hash chain', () => {
  const a = randomUUID(); const b = randomUUID(); const hash = (c) => c.repeat(64);
  let s = step(recordingStream, recordingStream.initial(ids), 'requireConsents', { principalIds: [a, b] });
  s = step(recordingStream, s, 'consent', { given: true }, a);
  assert.throws(() => step(recordingStream, s, 'start', {}), /consent_missing/);
  assert.throws(() => step(recordingStream, s, 'broadcast', { status: 'live', delaySeconds: 10 }), /consent_missing/);
  assert.throws(() => step(recordingStream, s, 'consent', { given: true }, randomUUID()), /consent_not_requested/);
  s = step(recordingStream, s, 'consent', { given: true }, b);
  s = step(recordingStream, s, 'start', {});
  s = step(recordingStream, s, 'addSegment', { segmentId: randomUUID(), startedAt: at(0), endedAt: at(60), sha256: hash('a'), bytes: 1000 });
  s = step(recordingStream, s, 'addSegment', { segmentId: randomUUID(), startedAt: at(60), endedAt: at(120), sha256: hash('b'), bytes: 2000 });
  assert.throws(() => step(recordingStream, s, 'addSegment', { segmentId: randomUUID(), startedAt: at(100), endedAt: at(130), sha256: hash('c'), bytes: 1 }), /overlapping_segment/);
  s = step(recordingStream, s, 'finalize', {});
  assert.equal(verifyManifest(s), true);
  assert.equal(verifyManifest({ ...s, segments: [{ ...s.segments[0], sha256: hash('f') }, s.segments[1]] }), false);
  assert.equal(verifyManifest({ ...s, segments: [s.segments[1], s.segments[0]] }), false);
});

test('E-18 transcript attribution follows the floor log; corrections are audited', () => {
  const a = randomUUID(); const b = randomUUID();
  const log = [{ segment: 'opening-for', speakerId: a, startedAt: at(0), endedAt: at(60), elapsedMs: 60000 }, { segment: 'opening-against', speakerId: b, startedAt: at(60), endedAt: null, elapsedMs: 0 }];
  assert.equal(attributeSpeaker(at(0), 55000, 20000, log), b); assert.equal(attributeSpeaker(at(0), 50000, 20000, log), null); assert.equal(attributeSpeaker(at(0), 50000, 20000, []), null);
  let s = step(transcriptStream, transcriptStream.initial(ids), 'begin', { startedAt: at(0) });
  const seg = randomUUID();
  s = step(transcriptStream, s, 'appendSegment', { segmentId: seg, offsetMs: 1000, durationMs: 4000, text: 'Thank you, chair.', source: 'asr', speakerLog: log });
  assert.equal(s.segments[0].speakerId, a);
  s = step(transcriptStream, s, 'correct', { segmentId: seg, text: 'Thank you, Madam Chair.', speakerId: null, reason: 'ASR misheard the honorific' });
  assert.equal(s.corrections[0].previousText, 'Thank you, chair.'); assert.equal(s.segments[0].revision, 2);
  assert.match(renderTranscript(s), /Madam Chair/);
  s = step(transcriptStream, s, 'publish', {});
  assert.throws(() => step(transcriptStream, s, 'appendSegment', { segmentId: randomUUID(), offsetMs: 0, durationMs: 1, text: 'x', source: 'human', speakerLog: [] }), /transcript_published/);
});

test('E-19 Q&A moderation, rate limits, privacy-preserving view and conduct escalation', () => {
  const viewer = randomUUID(); const other = randomUUID();
  let s = step(questionsStream, questionsStream.initial(ids), 'setOpen', { open: true });
  const q1 = randomUUID();
  s = step(questionsStream, s, 'submit', { questionId: q1, text: 'How would this be funded?', directedTo: 'for' }, viewer, 0);
  assert.throws(() => step(questionsStream, s, 'submit', { questionId: randomUUID(), text: 'Second question too soon', directedTo: 'both' }, viewer, 30), /rate_limited/);
  s = step(questionsStream, s, 'approve', { questionId: q1 });
  const view = questionsStream.view(s, other);
  assert.equal(view.queue.length, 1); assert.equal('author' in view.queue[0], false); assert.equal(view.mine.length, 0);
  s = step(questionsStream, s, 'strike', { principalId: other, note: 'Heckling the speaker' });
  s = step(questionsStream, s, 'strike', { principalId: other, note: 'Repeated heckling' });
  assert.throws(() => step(questionsStream, s, 'submit', { questionId: randomUUID(), text: 'Can I still ask?', directedTo: 'both' }, other, 100), /participation_restricted/);
  s = step(questionsStream, s, 'markAnswered', { questionId: q1 });
  assert.throws(() => step(questionsStream, s, 'approve', { questionId: q1 }), /invalid_question_state/);
});
