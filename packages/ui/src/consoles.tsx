import { useCallback, useEffect, useState } from 'react';
import { Button, Notice, Panel, StatusBadge, TimerDisplay } from './components.js';
import { request } from './client.js';
import { advanceCommand, nextPhase, overtime, READINESS_ITEMS, remainingSeconds, roleActions, type ConsoleRole, type FloorView, type LiveView } from './console-model.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Stream = { revision: number; state: unknown } | null;
/** E-15 live consoles. Every button sends one typed command; the server re-authorizes each one. */
export function ConsolePage({ viewer }: { viewer: string }) {
  const params = new URLSearchParams(window.location.search);
  const tenant = params.get('tenant') ?? ''; const event = params.get('event') ?? ''; const liveId = params.get('live') ?? ''; const floorId = params.get('floor') ?? '';
  const role = (['moderator', 'timekeeper', 'debater', 'producer'].includes(params.get('role') ?? '') ? params.get('role') : null) as ConsoleRole | null;
  const valid = [tenant, event, liveId, floorId].every((v) => UUID.test(v)) && role !== null;
  const base = `/api/tenants/${tenant}/events/${event}/operations`;
  const [live, setLive] = useState<Stream>(null); const [floor, setFloor] = useState<Stream>(null);
  const [now, setNow] = useState(Date.now()); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const read = async (stream: string, id: string): Promise<Stream> => {
      const page = await request(`${base}/${stream}/${id}`); const first = Array.isArray(page.records) ? page.records[0] as { snapshot: { revision: number; data: { state: unknown } } } | undefined : undefined;
      return first ? { revision: first.snapshot.revision, state: first.snapshot.data.state } : null;
    };
    const [l, f] = await Promise.all([read('live', liveId), read('floor', floorId)]); setLive(l); setFloor(f);
  }, [base, liveId, floorId]);
  useEffect(() => { if (!valid) return; let alive = true; const refresh = () => { load().then(() => alive && setError('')).catch((e: unknown) => alive && setError(e instanceof Error ? e.message : 'Unable to load the console.')); };
    refresh(); const poll = setInterval(refresh, 2000); const tick = setInterval(() => setNow(Date.now()), 500); return () => { alive = false; clearInterval(poll); clearInterval(tick); }; }, [valid, load]);
  if (!valid) return <Notice tone="error">This console link is incomplete. Open it from your event workspace.</Notice>;
  const liveState = (live?.state ?? { phase: 'preparation', suspended: false, readiness: [], sequence: 0 }) as LiveView;
  const floorState = (floor?.state ?? { speakerId: null, segment: null, timer: { status: 'idle', allottedMs: 0, elapsedMs: 0, runningSince: null, graceMs: 0, protectedMs: 0 }, requests: [], points: [] }) as FloorView;
  async function send(stream: 'live' | 'floor', type: string, payload: Record<string, unknown>) {
    setBusy(true); setError('');
    try { await request(`${base}/${stream}/${stream === 'live' ? liveId : floorId}`, { commandId: crypto.randomUUID(), expectedRevision: (stream === 'live' ? live : floor)?.revision ?? 0, type, payload }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'The command was not accepted.'); } finally { setBusy(false); }
  }
  const actions = roleActions(role, liveState, floorState, viewer);
  const over = overtime(floorState.timer, now);
  return <>
    <header className="page-title"><p className="eyebrow">{role} console</p><h1>Live debate</h1></header>
    {error && <Notice tone="error">{error}</Notice>}
    <Panel title="Event state"><p>Phase: <strong>{liveState.phase}</strong> {liveState.suspended && <StatusBadge label="Suspended" tone="warning" />}</p><p>Next: {nextPhase(liveState.phase) ?? 'none'}</p></Panel>
    <Panel title="Floor">
      <p>Speaker: {floorState.speakerId ? (floorState.speakerId === viewer ? 'You' : floorState.speakerId.slice(0, 8)) : 'none'}{floorState.segment ? ` · ${floorState.segment}` : ''}</p>
      <TimerDisplay remainingSeconds={remainingSeconds(floorState.timer, now)} paused={floorState.timer.status === 'paused'} />
      {over !== 'none' && <StatusBadge label={over === 'grace' ? 'Grace period' : 'Overtime'} tone="warning" />}
      {floorState.points.filter((p) => p.status === 'pending').map((p) => <p key={p.pointId}>Pending point of {p.kind}</p>)}
    </Panel>
    <Panel title="Actions"><fieldset disabled={busy} className="actions">
      {actions.includes('advance') && <Button onClick={() => void send('live', 'advance', { from: liveState.phase, to: nextPhase(liveState.phase) })}>Advance to {nextPhase(liveState.phase)}</Button>}
      {actions.includes('announce') && <Button onClick={() => void send('live', 'announce', { from: liveState.phase, to: 'announcement' })}>Announce results</Button>}
      {actions.includes('close') && <Button onClick={() => void send('live', advanceCommand(liveState.phase) ?? 'close', { from: liveState.phase, to: 'closed' })}>Close event</Button>}
      {actions.includes('suspend') && <Button className="secondary" onClick={() => void send('live', 'suspend', { reason: 'Suspended from moderator console' })}>Suspend</Button>}
      {actions.includes('resume') && role === 'moderator' && <Button onClick={() => void send('live', 'resume', { reason: 'Resumed from moderator console' })}>Resume event</Button>}
      {actions.includes('confirmReadiness') && READINESS_ITEMS.map((item) => <Button key={item} className={liveState.readiness.includes(item) ? 'secondary' : ''} onClick={() => void send('live', 'confirmReadiness', { item, confirmed: !liveState.readiness.includes(item) })}>{liveState.readiness.includes(item) ? `Unconfirm ${item}` : `Confirm ${item}`}</Button>)}
      {actions.includes('pause') && <Button onClick={() => void send('floor', 'pause', {})}>Pause timer</Button>}
      {actions.includes('resume') && role === 'timekeeper' && <Button onClick={() => void send('floor', 'resume', {})}>Resume timer</Button>}
      {actions.includes('stop') && <Button className="secondary" onClick={() => void send('floor', 'stop', {})}>Stop speech</Button>}
      {actions.includes('adjust') && <><Button className="secondary" onClick={() => void send('floor', 'adjust', { deltaSeconds: 30, reason: 'Timekeeper added time' })}>+30 s</Button><Button className="secondary" onClick={() => void send('floor', 'adjust', { deltaSeconds: -30, reason: 'Timekeeper removed time' })}>-30 s</Button></>}
      {actions.includes('startSpeech') && <form onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); void send('floor', 'startSpeech', { speakerId: String(d.get('speaker')), segment: String(d.get('segment')), seconds: Number(d.get('seconds')), graceSeconds: 10, protectedSeconds: 30 }); }}>
        <label>Speaker id <input name="speaker" required pattern="[0-9a-f-]{36}" /></label><label>Segment <input name="segment" required maxLength={40} /></label><label>Seconds <input name="seconds" type="number" min={1} max={7200} defaultValue={420} required /></label><Button type="submit">Start speech</Button></form>}
      {actions.includes('requestFloor') && <Button onClick={() => void send('floor', 'requestFloor', {})}>Request the floor</Button>}
      {actions.includes('raisePoint') && <><Button onClick={() => void send('floor', 'raisePoint', { pointId: crypto.randomUUID(), kind: 'information' })}>Point of information</Button><Button className="secondary" onClick={() => void send('floor', 'raisePoint', { pointId: crypto.randomUUID(), kind: 'order' })}>Point of order</Button></>}
      {actions.includes('respondPoint') && floorState.points.filter((p) => p.kind === 'information' && p.status === 'pending').map((p) => <span key={p.pointId}><Button onClick={() => void send('floor', 'respondPoint', { pointId: p.pointId, accept: true })}>Accept point</Button><Button className="secondary" onClick={() => void send('floor', 'respondPoint', { pointId: p.pointId, accept: false })}>Decline</Button></span>)}
      {actions.includes('rulePoint') && floorState.points.filter((p) => p.kind === 'order' && p.status === 'pending').map((p) => <span key={p.pointId}><Button onClick={() => void send('floor', 'rulePoint', { pointId: p.pointId, ruling: 'upheld', note: 'Upheld by the moderator' })}>Uphold point of order</Button><Button className="secondary" onClick={() => void send('floor', 'rulePoint', { pointId: p.pointId, ruling: 'overruled', note: 'Overruled by the moderator' })}>Overrule</Button></span>)}
      {actions.length === 0 && <p>No actions are available to you right now.</p>}
    </fieldset></Panel>
  </>;
}
