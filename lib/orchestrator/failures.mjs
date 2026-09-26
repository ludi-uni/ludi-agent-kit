// Separates "try another model" from "the task itself failed".
import { classifyBackendFailure } from './health.mjs';

export const FAILURE_CLASSES = [
  'MODEL_FAILURE', 'BACKEND_LIMIT', 'TOOL_FAILURE', 'TEST_FAILURE', 'TIMEOUT',
  'NO_PROGRESS_TIMEOUT', 'PROGRESS_TIMEOUT',
  'POLICY_BLOCK', 'USER_DECISION_REQUIRED', 'MALFORMED_RESULT', 'EMPTY_RESPONSE', 'UNKNOWN',
];

export const REASSIGN_CLASSES = new Set(['MODEL_FAILURE', 'BACKEND_LIMIT']);

/**
 * Failure classes that indicate a model/protocol-quality problem rather than a
 * task problem. On these, retrying the SAME model is unlikely to help — advance
 * to the next candidate (or escalate capability) instead of a same-model retry.
 * EMPTY_RESPONSE and turn-limit TIMEOUT are included; MALFORMED_RESULT means the
 * model could not honour the structured-result contract.
 */
export const PROTOCOL_FAILURE_CLASSES = new Set(['MALFORMED_RESULT', 'EMPTY_RESPONSE', 'TIMEOUT']);

/**
 * True when a failure should move to the next model candidate, not retry the same one.
 * A TIMEOUT is only a protocol failure when the model made no real progress
 * (turn limit with ~0 tool calls = the model spun without doing work). A timeout
 * that followed genuine tool progress stays retryable on the same model.
 */
export function isProtocolFailure(failureClass, run = null) {
  // A no-progress timeout is a model-quality problem -> advance candidate.
  if (failureClass === 'NO_PROGRESS_TIMEOUT') return true;
  // A progress timeout means the model WAS working — it is not a protocol-quality
  // failure; it is recoverable (more turns / a bigger budget may finish it).
  if (failureClass === 'PROGRESS_TIMEOUT') return false;
  if (failureClass === 'TIMEOUT') {
    const toolCalls = run?.child?.toolCalls ?? run?.toolCalls;
    // No progress signal -> treat as protocol failure. Progress -> recoverable.
    if (toolCalls !== undefined && toolCalls !== null) return toolCalls === 0 && !run?.structured && !run?.result?.summary;
    return false; // unknown progress is not evidence of a protocol failure
  }
  return PROTOCOL_FAILURE_CLASSES.has(failureClass);
}

/**
 * Should this failure mark the model as failed for the WHOLE task (across
 * capabilities)? Task-global failures are model/protocol-quality problems that
 * will almost certainly recur if the same canonical model is invoked again under
 * a different capability — so the model is skipped task-wide, not just locally.
 *
 * Global:   MALFORMED_RESULT, EMPTY_RESPONSE, no-progress turn-limit TIMEOUT.
 * Not global: transient tool failure, recoverable command error, task-specific
 *             implementation/validation failure (feedback can fix those).
 *
 * @param {string} failureClass classified failure
 * @param {object} [telemetry] optional { toolCalls, turns, hasOutput } for the
 *   specific invocation — used only to judge TIMEOUT progress; never guessed.
 */
export function shouldMarkTaskGlobalFailure(failureClass, telemetry = null) {
  if (failureClass === 'MALFORMED_RESULT' || failureClass === 'EMPTY_RESPONSE' || failureClass === 'MODEL_FAILURE') return true;
  if (failureClass === 'NO_PROGRESS_TIMEOUT') return telemetry?.toolCalls === 0 && telemetry?.structuredProgress === false && telemetry?.hasFinalOutput === false;
  // A PROGRESS_TIMEOUT means the model was making real progress — it is NOT a
  // model-quality failure and must NOT be added to taskGlobalFailedModels.
  if (failureClass === 'PROGRESS_TIMEOUT') return false;
  if (failureClass === 'TIMEOUT') {
    // A generic timeout is not sufficient: require turn-limit provenance and
    // explicit evidence of zero tool calls, no structured progress and no final output.
    return telemetry?.turnLimit === true && telemetry?.toolCalls === 0 &&
      telemetry?.structuredProgress === false && telemetry?.hasFinalOutput === false;
  }
  return false;
}

export function classifyRun(run) {
  if (run?.failureClass && FAILURE_CLASSES.includes(run.failureClass)) return run.failureClass;
  const result = run?.result;
  const text = `${run?.error ?? ''} ${result?.summary ?? ''}`;
  if (classifyBackendFailure(text)) return 'BACKEND_LIMIT';
  if (/timed out|timeout|ETIMEDOUT|tool call limit|turn limit/i.test(text)) return 'TIMEOUT';
  if (/POLICY_BLOCK|policy block/i.test(text)) return 'POLICY_BLOCK';
  if (result?.status === 'blocked' || result?.status === 'needs_decision') return 'USER_DECISION_REQUIRED';
  if (!run?.structured && result?.status === 'unknown') return 'MALFORMED_RESULT';
  if (/no bound model|capability/i.test(text)) return 'MODEL_FAILURE';
  const verification = JSON.stringify(result?.verification ?? '');
  if (/test fail|tests failed|assertionerror|npm ERR/i.test(`${text} ${verification}`)) return 'TEST_FAILURE';
  if (/empty model response|empty response|no output|blank response/i.test(text)) return 'EMPTY_RESPONSE';
  if (/tool error|command failed|ludi_exec/i.test(text)) return 'TOOL_FAILURE';
  if (result?.status === 'failed') return 'TEST_FAILURE';
  if (run?.error) return 'MODEL_FAILURE';
  return 'UNKNOWN';
}
