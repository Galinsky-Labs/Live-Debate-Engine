import type { AnyStream } from './stream.js';
import { rosterStream } from './roster.js';
import { eligibilityStream } from './eligibility.js';
import { scheduleStream } from './schedule.js';
import { admissionStream } from './admission.js';
import { liveStream } from './live.js';
import { floorStream } from './floor.js';
import { mediaStream } from './media.js';
import { recordingStream } from './recording.js';
import { transcriptStream } from './transcript.js';
import { questionsStream } from './questions.js';
import { createPollStream } from './poll.js';
import { paperStream } from './paper.js';
import { resultsStream } from './results.js';
import { panelStream } from './panel.js';
import { scorecardStream } from './scorecard.js';
import { prizesStream } from './prizes.js';
import { bracketStream } from './bracket.js';
import { disputesStream } from './disputes.js';
import { payoutsStream } from './payouts.js';
import { editorialStream } from './editorial.js';
import { accessStream } from './access.js';
import { aiReviewStream, datasetStream, qualificationStream } from '../ai/streams.js';

/** Every operation stream served by the engine. The database allow-list must match. */
export function operationStreams(secret: string): readonly AnyStream[] {
  return Object.freeze([
    rosterStream, eligibilityStream, scheduleStream, admissionStream,
    liveStream, floorStream, mediaStream, recordingStream, transcriptStream, questionsStream,
    createPollStream(secret), paperStream, panelStream, scorecardStream, resultsStream,
    prizesStream, bracketStream, disputesStream, payoutsStream,
    editorialStream, accessStream,
    datasetStream, qualificationStream, aiReviewStream,
  ]);
}
/** Stream definitions for static checks; the poll stream here uses a placeholder sealing secret. */
export const OPERATION_STREAMS: readonly AnyStream[] = operationStreams('static-definition-only');
