// Pure game rules. No I/O, no clocks: every event carries its own `at` (ms).
// reduce(state, event) always returns a new state object.

export const REACTION_LABELS = ['HAPPY', 'SURPRISE', 'FEAR'];
export const DEFAULT_SETTINGS = Object.freeze({ threshold: 70, holdMs: 300 });
export const THRESHOLD_RANGE = Object.freeze({ min: 30, max: 95 });

const CALIBRATION_MS = 8000;
export const COUNTDOWN_MS = 3000; // time to settle into a neutral face before the clock starts
const PULSE_FRESH_MS = 6000; // pulse older than this counts as "signal lost"
const CREDIT_WINDOW_MS = 20000; // a break is credited to a distraction this recent
const TENSION_SPAN_BPM = 25; // baseline + this many BPM = full tension
const POINTS_PER_SECOND = 10;
const MAX_FRAME_GAP_MS = 500; // longer gaps between samples earn nothing
const MAX_FEED_ITEMS = 5;
const MAX_NAME_LENGTH = 24;
const BLOCKING_FACE_CODES = new Set(['kNoFaceFound', 'kMultipleFacesFound', 'kFaceNotForward']);

export const DISTRACTIONS = Object.freeze({
  joke: { label: 'Dad joke', emoji: '🥁' },
  scare: { label: 'Jump scare', emoji: '👻' },
  roast: { label: 'Roast', emoji: '🔥' },
  flatter: { label: 'Flattery', emoji: '💐' },
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

export function createGame() {
  return {
    phase: 'idle', // idle | calibrating | ready | countdown | playing | broken
    countdownEndsAt: null,
    settings: DEFAULT_SETTINGS,
    faceCode: 'kOk',
    faceHint: '',
    reaction: { label: null, score: 0 },
    overSince: null,
    calibration: null, // { startedAt, restingPeak, pulses }
    restingPeak: null,
    baselinePulse: null,
    pulse: null, // { value, stable, at }
    round: null, // { survivedMs, score, lastSampleAt }
    feed: [], // newest first: { id, sender, kind, at }
    broken: null, // { label, score, by, survivedMs, points }
    leaderboard: [], // { name, breaks }
    bestMs: 0,
    nextId: 1,
  };
}

const isFaceOk = (state) => !BLOCKING_FACE_CODES.has(state.faceCode);

const isPulseLive = (state, at) =>
  Boolean(state.pulse && state.pulse.stable && at - state.pulse.at <= PULSE_FRESH_MS);

/** 0..1 when a fresh stable pulse and a baseline exist, otherwise null. */
export function tensionOf(state, at) {
  if (!isPulseLive(state, at) || state.baselinePulse === null) return null;
  return clamp((state.pulse.value - state.baselinePulse) / TENSION_SPAN_BPM, 0, 1);
}

const multiplierOf = (state, at) => 1 + (tensionOf(state, at) ?? 0);

function peakReaction(scores) {
  return REACTION_LABELS.map((label) => ({ label, score: scores[label] ?? 0 })).sort(
    (a, b) => b.score - a.score,
  )[0];
}

function creditedSender(state, at) {
  const latest = state.feed[0];
  return latest && at - latest.at <= CREDIT_WINDOW_MS ? latest.sender : null;
}

function addBreak(leaderboard, name) {
  const exists = leaderboard.some((entry) => entry.name === name);
  const next = exists
    ? leaderboard.map((entry) => (entry.name === name ? { ...entry, breaks: entry.breaks + 1 } : entry))
    : [...leaderboard, { name, breaks: 1 }];
  return [...next].sort((a, b) => b.breaks - a.breaks);
}

function breakRound(state, reaction, at) {
  const by = creditedSender(state, at);
  return {
    ...state,
    phase: 'broken',
    overSince: null,
    round: null,
    broken: {
      label: reaction.label,
      score: reaction.score,
      by,
      survivedMs: state.round.survivedMs,
      points: Math.round(state.round.score),
    },
    leaderboard: by ? addBreak(state.leaderboard, by) : state.leaderboard,
    bestMs: Math.max(state.bestMs, state.round.survivedMs),
  };
}

function playExpression(state, reaction, at) {
  const { round } = state;
  if (!isFaceOk(state)) {
    // Looking away pauses the clock and cannot break the round.
    return { ...state, overSince: null, round: { ...round, lastSampleAt: at } };
  }
  const gap = round.lastSampleAt === null ? 0 : at - round.lastSampleAt;
  const earnedMs = gap > MAX_FRAME_GAP_MS ? 0 : gap;
  const nextRound = {
    survivedMs: round.survivedMs + earnedMs,
    score: round.score + (earnedMs / 1000) * POINTS_PER_SECOND * multiplierOf(state, at),
    lastSampleAt: at,
  };
  const next = { ...state, round: nextRound };
  if (reaction.score < state.settings.threshold) return { ...next, overSince: null };
  const overSince = state.overSince ?? at;
  if (at - overSince < state.settings.holdMs) return { ...next, overSince };
  return breakRound(next, reaction, at);
}

function calibrateExpression(state, reaction, at) {
  if (!isFaceOk(state)) return state;
  const calibration = {
    ...state.calibration,
    restingPeak: Math.max(state.calibration.restingPeak, reaction.score),
  };
  if (at - calibration.startedAt < CALIBRATION_MS) return { ...state, calibration };
  return {
    ...state,
    phase: 'ready',
    calibration: null,
    restingPeak: calibration.restingPeak,
    baselinePulse: median(calibration.pulses) ?? state.baselinePulse,
  };
}

/** Countdown over: the clock starts now. Reactions during the countdown never count. */
function beginIfDue(state, at) {
  if (state.phase !== 'countdown' || at < state.countdownEndsAt) return state;
  return { ...state, phase: 'playing', countdownEndsAt: null };
}

function onExpression(before, event) {
  const state = beginIfDue(before, event.at);
  const reaction = peakReaction(event.scores);
  const next = { ...state, reaction };
  if (state.phase === 'calibrating') return calibrateExpression(next, reaction, event.at);
  if (state.phase === 'playing') return playExpression(next, reaction, event.at);
  return next;
}

function onPulse(state, event) {
  const pulse = { value: event.value, stable: Boolean(event.stable), at: event.at };
  const next = { ...state, pulse };
  if (!pulse.stable) return next;
  if (state.phase === 'calibrating') {
    return { ...next, calibration: { ...state.calibration, pulses: [...state.calibration.pulses, pulse.value] } };
  }
  // Pulse often arrives after calibration ends; the first stable reading out of a round becomes the baseline.
  if (state.baselinePulse === null && state.phase !== 'playing') return { ...next, baselinePulse: pulse.value };
  return next;
}

function onDistraction(state, event) {
  if (!(event.kind in DISTRACTIONS)) return state;
  const sender = String(event.sender ?? '').trim().slice(0, MAX_NAME_LENGTH) || 'anonymous';
  const item = { id: state.nextId, sender, kind: event.kind, at: event.at };
  return { ...state, nextId: state.nextId + 1, feed: [item, ...state.feed].slice(0, MAX_FEED_ITEMS) };
}

export function reduce(state, event) {
  switch (event.type) {
    case 'expression':
      return onExpression(state, event);
    case 'pulse':
      return onPulse(state, event);
    case 'validation':
      return { ...state, faceCode: event.code, faceHint: event.hint ?? '' };
    case 'distraction':
      return onDistraction(state, event);
    case 'calibrate':
      if (state.phase === 'playing' || state.phase === 'countdown') return state;
      return {
        ...state,
        phase: 'calibrating',
        broken: null,
        calibration: { startedAt: event.at, restingPeak: 0, pulses: [] },
      };
    case 'start':
      if (state.phase !== 'ready' && state.phase !== 'broken') return state;
      return {
        ...state,
        phase: 'countdown',
        countdownEndsAt: event.at + COUNTDOWN_MS,
        broken: null,
        overSince: null,
        feed: [],
        round: { survivedMs: 0, score: 0, lastSampleAt: null },
      };
    case 'tick':
      return beginIfDue(state, event.at);
    case 'stop':
      if (state.phase !== 'playing' && state.phase !== 'countdown') return state;
      return {
        ...state,
        phase: 'ready',
        countdownEndsAt: null,
        overSince: null,
        bestMs: Math.max(state.bestMs, state.round.survivedMs),
        round: null,
      };
    case 'settings': {
      const threshold = Number(event.threshold);
      if (!Number.isFinite(threshold)) return state;
      return {
        ...state,
        settings: { ...state.settings, threshold: clamp(Math.round(threshold), THRESHOLD_RANGE.min, THRESHOLD_RANGE.max) },
      };
    }
    case 'reset':
      return { ...createGame(), settings: state.settings };
    default:
      return state;
  }
}

/** Snapshot sent to the control window and the overlay. */
export function view(state, at) {
  const pulseLive = isPulseLive(state, at);
  const tension = tensionOf(state, at);
  return {
    phase: state.phase,
    threshold: state.settings.threshold,
    faceOk: isFaceOk(state),
    faceCode: state.faceCode,
    faceHint: state.faceHint,
    reaction: state.reaction,
    strain: clamp(state.reaction.score / state.settings.threshold, 0, 1),
    countdown: state.phase === 'countdown' ? Math.max(1, Math.ceil((state.countdownEndsAt - at) / 1000)) : null,
    calibrationProgress: state.calibration ? clamp((at - state.calibration.startedAt) / CALIBRATION_MS, 0, 1) : null,
    restingPeak: state.restingPeak,
    pulse: pulseLive ? Math.round(state.pulse.value) : null,
    baselinePulse: state.baselinePulse === null ? null : Math.round(state.baselinePulse),
    tension,
    multiplier: 1 + (tension ?? 0),
    survivedMs: state.round?.survivedMs ?? 0,
    points: Math.round(state.round?.score ?? 0),
    feed: state.feed,
    broken: state.broken,
    leaderboard: state.leaderboard.slice(0, 5),
    bestMs: state.bestMs,
    distractions: DISTRACTIONS,
  };
}
