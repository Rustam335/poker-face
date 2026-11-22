// Throwaway spike: how fast and how reliable are SmartSpectra's face and pulse
// signals on this machine? Answers open questions 1-3 in docs/HANDOFF.md.
//
// Run:  yarn spike            (reads SMARTSPECTRA_API_KEY from .env)
// Test: sit still 30s -> talk 30s -> press ENTER and smile/gasp right away
//       (repeat a few times) -> move your head -> Ctrl+C for the summary.

import {
  SmartSpectraSDK,
  CameraSelection,
  MetricType,
  ValidationCode,
  ProcessingStatus,
  faceMetrics,
  decodeMetrics,
} from '@smartspectra/node-sdk';

import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const API_KEY = process.env.SMARTSPECTRA_API_KEY;
const CAMERA_NAME = process.env.CAMERA_NAME ?? ''; // substring match, e.g. "Integrated"
const REACTION_LABELS = ['HAPPY', 'SURPRISE', 'FEAR'];
const REACTION_THRESHOLD = 50; // expression score 0-100 that counts as "broke"
const PRINT_EVERY_MS = 500;
// SPIKE_AUTO=1: hands-free run. Spoken cues + beeps replace ENTER/Ctrl+C (Windows only).
const AUTO = process.env.SPIKE_AUTO === '1';
const MARK_WINDOW_MS = 6000;

const EXPRESSION_NAMES = [
  'UNSPECIFIED', 'ANGRY', 'CONTEMPT', 'DISGUST', 'FEAR', 'HAPPY', 'NEUTRAL', 'SAD', 'SURPRISE',
];

// Mirror everything printed to spike.log (git-ignored) so the run can be reviewed afterwards.
const LOG_FILE = 'spike.log';
writeFileSync(LOG_FILE, `spike run ${new Date().toISOString()}\n`);
for (const level of ['log', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    appendFileSync(LOG_FILE, `${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
  };
}

if (!API_KEY) {
  console.error('SMARTSPECTRA_API_KEY is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const nameOf = (table, value) =>
  Object.keys(table).find((key) => table[key] === value) ?? String(value);
const toNumber = (v) => (typeof v === 'number' ? v : v?.toNumber?.() ?? Number(v));
const last = (list) => (list && list.length > 0 ? list[list.length - 1] : null);
const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const stats = {
  startedAt: Date.now(),
  packets: 0,
  packetGapsMs: [],
  expressionPackets: 0,
  expressionLagMs: [],
  expressionStable: 0,
  pulseSamples: 0,
  pulseStable: 0,
  pulseValues: [],
  reactionLatenciesMs: [],
  validation: {},
  rawPrinted: false,
  phases: {},
  marks: [], // { at, peak, peakLabel, latencyMs }
};
let phase = 'manual';
const phaseStats = () =>
  (stats.phases[phase] ??= {
    expressionPackets: 0, reactionHits: 0, maxReaction: 0, labels: {},
    pulseSamples: 0, pulseStable: 0, talkPackets: 0, talkDetected: 0,
  });
let lastPacketAt = 0;
let lastPrintAt = 0;
let markAt = null; // set when ENTER is pressed; cleared when a reaction is seen

function pickCamera() {
  const cameras = SmartSpectraSDK.availableCameras();
  console.log('Cameras:', cameras.map((c) => c.name).join(' | ') || '(none)');
  if (!CAMERA_NAME) return CameraSelection.default;
  const match = cameras.find((c) => (c.name ?? '').toLowerCase().includes(CAMERA_NAME.toLowerCase()));
  if (!match) {
    console.error(`No camera matching "${CAMERA_NAME}".`);
    process.exit(1);
  }
  console.log('Using camera:', match.name);
  return CameraSelection.byId(match.id);
}

function readExpression(face) {
  const expression = last(face?.expression);
  if (!expression) return null;
  const scores = Object.fromEntries(
    (expression.scores ?? []).map((s) => [EXPRESSION_NAMES[s.type] ?? String(s.type), s.confidence]),
  );
  const [topLabel, topScore] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0] ?? ['?', 0];
  return {
    scores,
    topLabel,
    topScore,
    stable: Boolean(expression.stable),
    lagMs: Date.now() - toNumber(expression.timestamp) / 1000,
  };
}

function onMetrics(buf) {
  const now = Date.now();
  const metrics = decodeMetrics(buf);
  stats.packets += 1;
  if (lastPacketAt) stats.packetGapsMs.push(now - lastPacketAt);
  lastPacketAt = now;

  const expression = readExpression(metrics.face);
  const pulse = last(metrics.cardio?.pulseRate);
  const blink = last(metrics.face?.blinking);
  const talk = last(metrics.face?.talking);

  if (!stats.rawPrinted && (expression || pulse)) {
    stats.rawPrinted = true;
    const raw = metrics.toJSON();
    if (raw.face?.landmarks) raw.face.landmarks = `[${raw.face.landmarks.length} sets omitted]`;
    console.log('\n--- first raw packet (verify shapes) ---');
    console.log(JSON.stringify(raw, null, 1).slice(0, 3000));
    console.log('--- end raw packet ---\n');
  }

  const ps = phaseStats();
  if (talk) {
    ps.talkPackets += 1;
    if (talk.detected) ps.talkDetected += 1;
  }
  if (pulse) {
    ps.pulseSamples += 1;
    if (pulse.stable) ps.pulseStable += 1;
  }
  if (expression) {
    const [peakLabel, peak] = REACTION_LABELS
      .map((label) => [label, expression.scores[label] ?? 0])
      .sort((a, b) => b[1] - a[1])[0];
    ps.expressionPackets += 1;
    ps.labels[expression.topLabel] = (ps.labels[expression.topLabel] ?? 0) + 1;
    ps.maxReaction = Math.max(ps.maxReaction, peak);
    if (peak >= REACTION_THRESHOLD) ps.reactionHits += 1;
    const mark = last(stats.marks);
    if (mark && now - mark.at <= MARK_WINDOW_MS) {
      if (peak > mark.peak) Object.assign(mark, { peak, peakLabel });
      if (mark.latencyMs === null && peak >= REACTION_THRESHOLD) mark.latencyMs = now - mark.at;
    }
    stats.expressionPackets += 1;
    if (expression.stable) stats.expressionStable += 1;
    stats.expressionLagMs.push(expression.lagMs);

    const reaction = REACTION_LABELS.find((label) => (expression.scores[label] ?? 0) >= REACTION_THRESHOLD);
    if (markAt && reaction) {
      const latency = now - markAt;
      stats.reactionLatenciesMs.push(latency);
      console.log(`\n>>> REACTION ${reaction} ${expression.scores[reaction].toFixed(0)} — ${latency} ms after ENTER\n`);
      markAt = null;
    }
  }

  if (pulse) {
    stats.pulseSamples += 1;
    if (pulse.stable) {
      stats.pulseStable += 1;
      stats.pulseValues.push(pulse.value);
    }
  }

  if (now - lastPrintAt < PRINT_EVERY_MS) return;
  lastPrintAt = now;
  const parts = [
    expression
      ? `face ${expression.topLabel} ${expression.topScore.toFixed(0)}${expression.stable ? '' : '?'} lag ${expression.lagMs.toFixed(0)}ms`
      : 'face -',
    pulse ? `pulse ${pulse.value.toFixed(0)} conf ${pulse.confidence.toFixed(0)} ${pulse.stable ? 'STABLE' : 'unstable'}` : 'pulse -',
    blink ? `blink ${blink.detected ? 'Y' : 'n'}` : '',
    talk ? `talk ${talk.detected ? 'Y' : 'n'}` : '',
  ];
  console.log(parts.filter(Boolean).join(' | '));
}

function printSummary() {
  const seconds = (Date.now() - stats.startedAt) / 1000;
  const pct = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(0)}%` : 'n/a');
  console.log('\n================ SUMMARY ================');
  console.log(`Duration:            ${seconds.toFixed(0)} s`);
  console.log(`Metrics packets:     ${stats.packets} (${(stats.packets / seconds).toFixed(1)}/s, median gap ${median(stats.packetGapsMs)} ms)`);
  console.log(`Expression packets:  ${stats.expressionPackets} (${(stats.expressionPackets / seconds).toFixed(1)}/s), stable ${pct(stats.expressionStable, stats.expressionPackets)}`);
  console.log(`Expression lag:      median ${median(stats.expressionLagMs)?.toFixed(0)} ms (capture -> callback)`);
  console.log(`ENTER -> reaction:   ${stats.reactionLatenciesMs.join(', ') || 'none recorded'} ms (includes your own reaction time)`);
  console.log(`Pulse samples:       ${stats.pulseSamples}, stable ${pct(stats.pulseStable, stats.pulseSamples)}, median ${median(stats.pulseValues)?.toFixed(0) ?? 'n/a'} BPM`);
  console.log('Validation codes:   ', stats.validation);
  for (const mark of stats.marks) {
    console.log(`Mark: peak ${mark.peakLabel ?? '-'} ${mark.peak.toFixed(0)}, crossed ${REACTION_THRESHOLD} after ${mark.latencyMs ?? 'never'} ms`);
  }
  for (const [name, p] of Object.entries(stats.phases)) {
    console.log(
      `Phase ${name}: expr ${p.expressionPackets}, reaction hits ${p.reactionHits} (max ${p.maxReaction.toFixed(0)}), ` +
      `pulse ${p.pulseStable}/${p.pulseSamples} stable, talk ${p.talkDetected}/${p.talkPackets}, labels ${JSON.stringify(p.labels)}`,
    );
  }
  console.log('=========================================');
}

const sdk = new SmartSpectraSDK({
  apiKey: API_KEY,
  requestedMetrics: [...faceMetrics, MetricType.PULSE_RATE],
  enableTelemetry: false,
});

let autoStarted = false;
sdk.on('processingStatus', (status) => {
  const name = nameOf(ProcessingStatus, status);
  console.log('[status]', name);
  if (AUTO && !autoStarted && name === 'kRunning') {
    autoStarted = true;
    startAutoScript();
  }
});
sdk.on('validationStatus', (code, _ts, hint) => {
  const name = nameOf(ValidationCode, code);
  if (!stats.validation[name]) console.log('[validation]', name, hint);
  stats.validation[name] = (stats.validation[name] ?? 0) + 1;
});
sdk.on('error', (code, message, retryable) => console.error('[error]', code, message, 'retryable=', retryable));
sdk.on('metrics', onMetrics);

function mark() {
  markAt = Date.now();
  stats.marks.push({ at: markAt, peak: 0, peakLabel: null, latencyMs: null });
  console.log('\n\n>>> MARK - react now!\n\n');
}
if (!AUTO) process.stdin.on('data', mark);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  printSummary();
  try {
    await sdk.stopAsync();
    await sdk.destroy();
  } catch (error) {
    console.error('Shutdown error:', error.message);
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);

function startAutoScript() {
  const cue = spawn('powershell', ['-NoProfile', '-Command', '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
  cue.stdin.write('Add-Type -AssemblyName System.Speech; $v = New-Object System.Speech.Synthesis.SpeechSynthesizer\n');
  const say = (text) => cue.stdin.write(`$v.SpeakAsync('${text}') | Out-Null\n`);
  const beep = () => cue.stdin.write('[console]::beep(1000,250)\n');
  const at = (seconds, fn) => setTimeout(fn, seconds * 1000);
  const enter = (name, text) => () => {
    phase = name;
    console.log(`\n=== PHASE ${name} ===\n`);
    say(text);
  };
  enter('still', 'Sit still. Neutral face.')();
  at(30, enter('talk', 'Talk now. Keep talking.'));
  at(60, enter('react', 'Stop talking. Neutral face. Smile or gasp at each beep.'));
  for (const seconds of [70, 80, 90, 100]) at(seconds, () => { beep(); mark(); });
  at(110, enter('move', 'Move your head around.'));
  at(130, enter('still2', 'Sit still again.'));
  at(155, () => { say('Done.'); setTimeout(() => { cue.stdin.end(); shutdown(); }, 1500); });
}

sdk.useCamera(pickCamera());
sdk.start();
console.log(`SmartSpectra ${SmartSpectraSDK.version} started. ENTER = mark a reaction, Ctrl+C = summary.`);
