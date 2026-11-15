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

/** Every operation stream served by the engine. The database allow-list must match. */
export const OPERATION_STREAMS: readonly AnyStream[] = Object.freeze([
  rosterStream, eligibilityStream, scheduleStream, admissionStream,
  liveStream, floorStream, mediaStream, recordingStream, transcriptStream, questionsStream,
]);
