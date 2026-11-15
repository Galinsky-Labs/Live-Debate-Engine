import { deepFreeze, fail, int, list, oneOf, record, str, uuid, type Context } from './common.js';
import { defineStream } from './stream.js';

/** E-10: eligibility rules, releases and legal-document acceptance bound to exact revision+hash. */
export const PARTICIPANT_ROLES = ['debater', 'judge', 'moderator', 'audience'] as const;
export type LegalDocument = Readonly<{ documentId: string; title: string; revision: number; sha256: string; requiredFor: readonly (typeof PARTICIPANT_ROLES)[number][]; kind: 'terms' | 'release' | 'privacy' | 'rules' }>;
export type Acceptance = Readonly<{ documentId: string; revision: number; sha256: string; acceptedAt: string }>;
export type Participant = Readonly<{
  principalId: string; role: (typeof PARTICIPANT_ROLES)[number];
  acceptances: readonly Acceptance[]; attestations: readonly Readonly<{ code: string; at: string }>[];
  review: Readonly<{ decision: 'eligible' | 'ineligible'; reason: string; by: string; at: string }> | null;
}>;
export type EligibilityState = Readonly<{ documents: readonly LegalDocument[]; attestations: readonly string[]; participants: readonly Participant[] }>;

export function initialEligibility(): EligibilityState { return deepFreeze({ documents: [], attestations: [], participants: [] }); }

/** Current, exact-revision acceptance is required; older revisions never satisfy a newer document. */
export function evaluateEligibility(state: EligibilityState, principalId: string): Readonly<{ eligible: boolean; missing: readonly string[] }> {
  const participant = state.participants.find((p) => p.principalId === principalId);
  if (!participant) return { eligible: false, missing: ['not_registered'] };
  const missing: string[] = [];
  for (const doc of state.documents.filter((d) => d.requiredFor.includes(participant.role))) {
    if (!participant.acceptances.some((a) => a.documentId === doc.documentId && a.revision === doc.revision && a.sha256 === doc.sha256)) missing.push(`document:${doc.documentId}`);
  }
  for (const code of state.attestations) if (!participant.attestations.some((a) => a.code === code)) missing.push(`attestation:${code}`);
  if (participant.review?.decision === 'ineligible') missing.push('review:ineligible');
  return deepFreeze({ eligible: missing.length === 0, missing });
}

function participantOf(state: EligibilityState, principalId: string): Participant {
  return state.participants.find((p) => p.principalId === principalId) ?? fail('not_registered');
}
function replace(state: EligibilityState, participant: Participant): EligibilityState {
  return deepFreeze({ ...state, participants: [...state.participants.filter((p) => p.principalId !== participant.principalId), participant].sort((a, b) => a.principalId.localeCompare(b.principalId)) });
}
const hex = (value: unknown) => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('invalid_sha256', 400); return value; };
const code = (value: unknown) => { if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(value)) fail('invalid_code', 400); return value; };

export function applyEligibility(state: EligibilityState, type: string, input: unknown, context: Context): EligibilityState {
  switch (type) {
    case 'publishDocument': {
      const p = record(input, ['documentId', 'title', 'revision', 'sha256', 'requiredFor', 'kind']);
      const doc: LegalDocument = { documentId: uuid(p.documentId, 'document'), title: str(p.title, 'title', 1, 200), revision: int(p.revision, 'revision', 1, 100000), sha256: hex(p.sha256),
        requiredFor: list(p.requiredFor, (r) => oneOf(r, PARTICIPANT_ROLES, 'role'), 'roles', 1, 4), kind: oneOf(p.kind, ['terms', 'release', 'privacy', 'rules'] as const, 'kind') };
      const prior = state.documents.find((d) => d.documentId === doc.documentId);
      if (prior && doc.revision <= prior.revision) fail('document_revision_must_increase', 409);
      if (state.documents.length >= 30 && !prior) fail('too_many_documents');
      return deepFreeze({ ...state, documents: [...state.documents.filter((d) => d.documentId !== doc.documentId), doc] });
    }
    case 'setAttestations': {
      const codes = list(record(input, ['codes']).codes, code, 'codes', 0, 20);
      if (new Set(codes).size !== codes.length) fail('duplicate_code');
      return deepFreeze({ ...state, attestations: codes });
    }
    case 'enroll': {
      const p = record(input, ['principalId', 'role']);
      const principalId = uuid(p.principalId, 'principal');
      if (state.participants.some((x) => x.principalId === principalId)) fail('already_enrolled', 409);
      if (state.participants.length >= 300) fail('too_many_participants');
      return replace(state, { principalId, role: oneOf(p.role, PARTICIPANT_ROLES, 'role'), acceptances: [], attestations: [], review: null });
    }
    case 'accept': {
      const p = record(input, ['documentId', 'revision', 'sha256']);
      const participant = participantOf(state, context.actor);
      const doc = state.documents.find((d) => d.documentId === uuid(p.documentId, 'document')) ?? fail('unknown_document');
      if (doc.revision !== int(p.revision, 'revision', 1) || doc.sha256 !== hex(p.sha256)) fail('document_changed', 409);
      const acceptance: Acceptance = { documentId: doc.documentId, revision: doc.revision, sha256: doc.sha256, acceptedAt: context.now };
      return replace(state, { ...participant, acceptances: [...participant.acceptances.filter((a) => !(a.documentId === doc.documentId && a.revision === doc.revision)), acceptance] });
    }
    case 'attest': {
      const value = code(record(input, ['code']).code);
      if (!state.attestations.includes(value)) fail('unknown_attestation');
      const participant = participantOf(state, context.actor);
      return replace(state, { ...participant, attestations: [...participant.attestations.filter((a) => a.code !== value), { code: value, at: context.now }] });
    }
    case 'review': {
      const p = record(input, ['principalId', 'decision', 'reason']);
      const participant = participantOf(state, uuid(p.principalId, 'principal'));
      if (participant.principalId === context.actor) fail('self_review_forbidden', 403);
      return replace(state, { ...participant, review: { decision: oneOf(p.decision, ['eligible', 'ineligible'] as const, 'decision'), reason: str(p.reason, 'reason', 5, 1000), by: context.actor, at: context.now } });
    }
    default: return fail('unknown_command', 400);
  }
}

const cmd = (type: string, action: 'event.manage' | 'participant.self') => ({ action, apply: (s: EligibilityState, p: unknown, c: Context) => applyEligibility(s, type, p, c) });
export const eligibilityStream = defineStream<EligibilityState>({
  name: 'eligibility', readAction: 'event.manage', initial: initialEligibility,
  commands: { publishDocument: cmd('publishDocument', 'event.manage'), setAttestations: cmd('setAttestations', 'event.manage'), enroll: cmd('enroll', 'event.manage'),
    review: cmd('review', 'event.manage'), accept: cmd('accept', 'participant.self'), attest: cmd('attest', 'participant.self') },
  // Participants see the documents, requirements and only their own record and status.
  view: (state, actor) => ({ documents: state.documents, attestations: state.attestations,
    participant: state.participants.find((p) => p.principalId === actor) ?? null, status: evaluateEligibility(state, actor) }),
});
