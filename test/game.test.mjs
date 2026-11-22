import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, reduce, view, tensionOf } from '../src/game/game.mjs';

const run = (state, events) => events.reduce(reduce, state);
const face = (at, scores = {}) => ({ type: 'expression', at, scores: { NEUTRAL: 90, ...scores } });
const frames = (from, to, scores, step = 40) => {
  const list = [];
  for (let at = from; at <= to; at += step) list.push(face(at, scores));
  return list;
};
const readyGame = () => run(createGame(), [{ type: 'calibrate', at: 0 }, ...frames(0, 8000)]);
const playingGame = () => run(readyGame(), [{ type: 'start', at: 6000 }, { type: 'tick', at: 9000 }]);

test('calibration finishes after eight seconds of face samples', () => {
  const state = readyGame();
  assert.equal(state.phase, 'ready');
});

test('calibration takes the median stable pulse as baseline and ignores unstable ones', () => {
  const state = run(createGame(), [
    { type: 'calibrate', at: 0 },
    { type: 'pulse', at: 1000, value: 70, stable: true },
    { type: 'pulse', at: 2000, value: 140, stable: false },
    { type: 'pulse', at: 3000, value: 74, stable: true },
    { type: 'pulse', at: 4000, value: 72, stable: true },
    ...frames(0, 8000),
  ]);
  assert.equal(state.baselinePulse, 72);
});

test('first stable pulse after calibration becomes the baseline when none was captured', () => {
  const state = reduce(readyGame(), { type: 'pulse', at: 9000, value: 80, stable: true });
  assert.equal(state.baselinePulse, 80);
});

test('round cannot start before calibration', () => {
  assert.equal(reduce(createGame(), { type: 'start', at: 0 }).phase, 'idle');
});

test('dealing a round starts a three second countdown before the clock runs', () => {
  const dealt = reduce(readyGame(), { type: 'start', at: 9000 });
  assert.equal(dealt.phase, 'countdown');
  assert.equal(view(dealt, 9100).countdown, 3);
  assert.equal(view(dealt, 11500).countdown, 1);
  assert.equal(reduce(dealt, { type: 'tick', at: 11999 }).phase, 'countdown');
  assert.equal(reduce(dealt, { type: 'tick', at: 12000 }).phase, 'playing');
});

test('a reaction during the countdown does not break the round or earn time', () => {
  const state = run(readyGame(), [{ type: 'start', at: 9000 }, ...frames(9040, 11960, { HAPPY: 100 })]);
  assert.equal(state.phase, 'countdown');
  assert.equal(state.round.survivedMs, 0);
});

test('the clock starts from the first face sample after the countdown', () => {
  const state = run(readyGame(), [{ type: 'start', at: 9000 }, ...frames(9040, 13000)]);
  assert.equal(state.phase, 'playing');
  assert.equal(state.round.survivedMs, 1000);
});

test('folding during the countdown returns to ready', () => {
  const state = run(readyGame(), [{ type: 'start', at: 9000 }, { type: 'stop' }]);
  assert.equal(state.phase, 'ready');
});

test('holding a neutral face accumulates survival time and points', () => {
  const state = run(playingGame(), frames(10000, 12000));
  assert.equal(state.phase, 'playing');
  assert.equal(state.round.survivedMs, 2000);
  assert.equal(Math.round(state.round.score), 20);
});

test('a reaction held past the hold time breaks the round', () => {
  const state = run(playingGame(), [...frames(10000, 11000), ...frames(11040, 11400, { HAPPY: 95 })]);
  assert.equal(state.phase, 'broken');
  assert.equal(state.broken.label, 'HAPPY');
});

test('a single-frame spike above the threshold does not break the round', () => {
  const state = run(playingGame(), [face(10000), face(10040, { SURPRISE: 99 }), ...frames(10080, 11000)]);
  assert.equal(state.phase, 'playing');
});

test('a reaction below the threshold does not break the round', () => {
  const state = run(playingGame(), frames(10000, 12000, { HAPPY: 60 }));
  assert.equal(state.phase, 'playing');
});

test('SAD and other non-reaction labels never break the round', () => {
  const state = run(playingGame(), frames(10000, 12000, { SAD: 99, NEUTRAL: 1 }));
  assert.equal(state.phase, 'playing');
});

test('looking away pauses the clock and cannot break the round', () => {
  const state = run(playingGame(), [
    ...frames(10000, 11000),
    { type: 'validation', code: 'kFaceNotForward' },
    ...frames(11040, 13000, { HAPPY: 100 }),
  ]);
  assert.equal(state.phase, 'playing');
  assert.equal(state.round.survivedMs, 1000);
});

test('a break is credited to the most recent distraction sender', () => {
  const state = run(playingGame(), [
    face(10000),
    { type: 'distraction', at: 10010, sender: 'rina', kind: 'joke' },
    { type: 'distraction', at: 10020, sender: 'budi', kind: 'scare' },
    ...frames(10040, 10500, { FEAR: 90 }),
  ]);
  assert.equal(state.broken.by, 'budi');
  assert.deepEqual(state.leaderboard, [{ name: 'budi', breaks: 1 }]);
});

test('a break long after the last distraction is credited to nobody', () => {
  const state = run(playingGame(), [
    { type: 'distraction', at: 10000, sender: 'rina', kind: 'joke' },
    ...frames(10000, 40000),
    ...frames(40040, 40500, { HAPPY: 90 }),
  ]);
  assert.equal(state.broken.by, null);
  assert.deepEqual(state.leaderboard, []);
});

test('leaderboard counts repeat breakers and sorts by breaks', () => {
  const breakBy = (state, sender, at) =>
    run(state, [
      { type: 'start', at: at - 3100 },
      { type: 'tick', at: at - 50 },
      face(at),
      { type: 'distraction', at, sender, kind: 'roast' },
      ...frames(at + 40, at + 500, { HAPPY: 90 }),
    ]);
  const state = breakBy(breakBy(breakBy(readyGame(), 'a', 10000), 'b', 20000), 'b', 30000);
  assert.deepEqual(state.leaderboard, [{ name: 'b', breaks: 2 }, { name: 'a', breaks: 1 }]);
});

test('unknown distraction kinds are ignored and sender names are trimmed', () => {
  const base = playingGame();
  assert.equal(reduce(base, { type: 'distraction', at: 1, sender: 'x', kind: 'nope' }).feed.length, 0);
  const named = reduce(base, { type: 'distraction', at: 1, sender: `  ${'z'.repeat(60)}  `, kind: 'joke' });
  assert.equal(named.feed[0].sender.length, 24);
  assert.equal(reduce(base, { type: 'distraction', at: 1, sender: '  ', kind: 'joke' }).feed[0].sender, 'anonymous');
});

test('tension is null without a fresh stable pulse and scales with BPM above baseline', () => {
  const base = { ...readyGame(), baselinePulse: 70 };
  assert.equal(tensionOf(base, 9000), null);
  const live = reduce(base, { type: 'pulse', at: 9000, value: 82.5, stable: true });
  assert.equal(tensionOf(live, 9500), 0.5);
  assert.equal(tensionOf(live, 9000 + 7000), null);
  const unstable = reduce(base, { type: 'pulse', at: 9000, value: 95, stable: false });
  assert.equal(tensionOf(unstable, 9500), null);
});

test('raised pulse multiplies points', () => {
  const base = { ...playingGame(), baselinePulse: 70 };
  const state = run(base, [{ type: 'pulse', at: 10000, value: 95, stable: true }, ...frames(10000, 12000)]);
  assert.equal(Math.round(state.round.score), 40);
});

test('threshold setting is clamped to the allowed range', () => {
  assert.equal(reduce(createGame(), { type: 'settings', threshold: 5 }).settings.threshold, 30);
  assert.equal(reduce(createGame(), { type: 'settings', threshold: 200 }).settings.threshold, 95);
  assert.equal(reduce(createGame(), { type: 'settings', threshold: 'abc' }).settings.threshold, 70);
});

test('stopping a round records the best time and returns to ready', () => {
  const state = run(playingGame(), [...frames(10000, 13000), { type: 'stop' }]);
  assert.equal(state.phase, 'ready');
  assert.equal(state.bestMs, 3000);
});

test('reduce does not mutate the previous state', () => {
  const before = playingGame();
  const frozen = structuredClone(before);
  run(before, [...frames(10000, 10500, { HAPPY: 99 }), { type: 'distraction', at: 1, sender: 'a', kind: 'joke' }]);
  assert.deepEqual(before, frozen);
});

test('view hides the pulse number when the signal is lost', () => {
  const state = reduce(readyGame(), { type: 'pulse', at: 9000, value: 77.4, stable: true });
  assert.equal(view(state, 9100).pulse, 77);
  assert.equal(view(state, 20000).pulse, null);
});
