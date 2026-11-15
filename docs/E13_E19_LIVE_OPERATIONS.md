# E-13 to E-19: live event operations

All units use the operation-stream architecture from [E09_E12_OPERATIONS.md](E09_E12_OPERATIONS.md); migration 0013 adds the `(stream, action)` grants.

| Unit | Stream / module | Implemented | Actions |
|---|---|---|---|
| E-13 authoritative state machine | `live` | Canonical `PHASES` in order; callers state the observed phase so stale consoles cannot skip; readiness checklist gate before pre-vote; suspend/resume overlay with reasons; cancel with reason; attributed transition history. Announcement and close require `result.publish`. | `session.control`, `result.publish`, `event.manage` |
| E-14 timers, floor control, points | `floor` | Server-clock timers (start/pause/resume/stop/adjust with reason), warning/grace/overtime signals, protected time for points of information, floor requests, points of information (speaker accepts/declines) and order (moderator rules), speech log with elapsed time. | `timer.control`, `floor.participate`, `session.control` |
| E-15 consoles | `consoles.ts` | Moderator, timekeeper, producer and debater view models derived only from authoritative state, exposing only the actions that role may take. | n/a (read models) |
| E-16 remote participation, media rooms | `media` + `MediaProvider` | Provider interface; the disabled default fails closed (`media_provider_unconfigured`); an in-memory simulator is provided for tests only. The provider is called first and only confirmed facts (room opened, mute, removal, end) are recorded. Publishing policy by role. | `media.control` (producer) |
| E-17 recording and broadcast | `recording` | Required consents per participant (self-service consent), recording/broadcast blocked until all consents exist, hash-chained segment manifest with verification, broadcast status and delay. | `media.control`, `participant.self` |
| E-18 transcription, attribution, corrections | `transcript` | Segments with speaker attribution from the floor log (majority overlap), audited corrections (previous text, reason, actor), publication freeze, plain-text rendering. | `event.manage` |
| E-19 audience Q&A and conduct | `questions` | Submission with pending/interval rate limits, moderation (approve/reject/merge/answered), strike escalation to mute/eject that also withdraws pending questions, restoration; audience view hides authors and shows only the caller's own submissions. | `question.submit`, `question.moderate` |

## Not included / owner decisions

- No media, recording-storage, ASR or streaming vendor is configured. Real rooms, join tokens, recordings and automatic transcripts require choosing a provider and adding its keys (e.g. LiveKit/Daily/Mux, an ASR vendor). Until then those operations fail closed.
- Console UIs are view models; the React console screens are follow-up UI work.
