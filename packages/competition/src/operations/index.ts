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

/** Every operation stream served by the engine. The database allow-list must match. */
export function operationStreams(secret: string): readonly AnyStream[] {
  return Object.freeze([
    rosterStream, eligibilityStream, scheduleStream, admissionStream,
    liveStream, floorStream, mediaStream, recordingStream, transcriptStream, questionsStream,
    createPollStream(secret), paperStream, panelStream, scorecardStream, resultsStream,
  ]);
}
/** Stream definitions for static checks; the poll stream here uses a placeholder sealing secret. */
export const OPERATION_STREAMS: readonly AnyStream[] = operationStreams('static-definition-only');
