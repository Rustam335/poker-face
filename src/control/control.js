// Control window: consent, camera choice, calibration, round controls, chat simulator.
// All state lives in the main process; this file only renders snapshots and sends intents.

const api = window.pokerFace;
const $ = (id) => document.getElementById(id);

const FACE_HINTS = {
  kNoFaceFound: 'No face found.',
  kMultipleFacesFound: 'Only one face, please.',
  kFaceNotForward: 'Face the camera.',
  kTooDark: 'Too dark: add light on your face.',
  kTooBright: 'Too bright.',
  kFaceNotCentered: 'Centre your face.',
  kFaceTooClose: 'Move back a little.',
  kFaceTooFar: 'Move closer.',
  kExcessiveMotion: 'Hold still.',
  kChestNotVisible: 'Show more of your chest for a steadier pulse.',
};
const REACTION_WORDS = { HAPPY: 'smile', SURPRISE: 'surprise', FEAR: 'flinch' };
const STATUS_WORDS = { off: 'Camera off', kIdle: 'Camera idle', kStarting: 'Camera on, looking for a face…', kRunning: 'Camera live', kStopping: 'Stopping…', kError: 'Camera error' };

const previewContext = $('preview').getContext('2d');
let distractionsBuilt = false;

function formatClock(ms) {
  const tenths = Math.floor(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths % 10}`;
}

function showError(message) {
  $('error').textContent = message ?? '';
  $('error').hidden = !message;
}

async function loadCameras() {
  try {
    const cameras = await api.listCameras();
    const options = cameras.map((camera) => {
      const option = document.createElement('option');
      option.value = camera.id;
      option.textContent = camera.name;
      return option;
    });
    $('camera').replaceChildren(...options);
    if (cameras.length === 0) showError('No camera found. Plug one in and reopen the app.');
  } catch (error) {
    showError(`Could not list cameras: ${error.message}`);
  }
}

function buildDistractions(distractions) {
  const buttons = Object.entries(distractions).map(([kind, info]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    const emoji = document.createElement('span');
    emoji.textContent = info.emoji;
    const label = document.createElement('span');
    label.textContent = info.label;
    button.append(emoji, label);
    button.addEventListener('click', () => api.dispatch({ type: 'distraction', kind, sender: $('sender').value }));
    return button;
  });
  $('distractions').replaceChildren(...buttons);
  distractionsBuilt = true;
}

// The SDK reports kStarting until it has a usable face, so both count as a live camera.
const isLive = (state) => state.sensor.status === 'kStarting' || state.sensor.status === 'kRunning';

function roundLine(state) {
  if (!isLive(state)) return 'Start a camera first.';
  if (state.phase === 'calibrating') return 'Calibrating: neutral face, eyes on the camera.';
  if (state.phase === 'countdown') return 'Get your poker face on…';
  if (state.phase === 'playing') return state.faceOk ? `Holding. ${state.points} points.` : 'Paused: face the camera.';
  if (state.phase === 'broken' && state.broken) {
    const what = REACTION_WORDS[state.broken.label] ?? 'reaction';
    const who = state.broken.by ? ` Broken by ${state.broken.by}.` : '';
    return `Broken by a ${what} after ${formatClock(state.broken.survivedMs)}.${who}`;
  }
  if (state.phase === 'ready') return 'Ready. Deal a round when the chat is.';
  return 'Calibrate to deal the first hand.';
}

function render(state) {
  const live = isLive(state);
  $('status').textContent = state.sensor.cameraName && live
    ? `${STATUS_WORDS.kRunning} · ${state.sensor.cameraName}`
    : STATUS_WORDS[state.sensor.status] ?? state.sensor.status;
  showError(state.sensor.error);

  const hint = FACE_HINTS[state.faceCode];
  $('face-hint').textContent = live ? hint ?? 'Face found.' : 'Pick a camera to begin.';
  $('face-hint').classList.toggle('is-warning', live && !state.faceOk);

  $('strain-fill').style.transform = `scaleX(${state.strain.toFixed(3)})`;
  $('reaction').textContent = state.reaction.label ? `${REACTION_WORDS[state.reaction.label]} ${Math.round(state.reaction.score)}` : '–';
  $('pulse').textContent = state.pulse === null ? 'signal lost' : `♥ ${state.pulse}`;
  $('baseline').textContent = state.baselinePulse === null ? '–' : String(state.baselinePulse);
  $('multiplier').textContent = `×${state.multiplier.toFixed(1)}`;

  const shownMs = state.phase === 'broken' && state.broken ? state.broken.survivedMs : state.survivedMs;
  $('clock').textContent = state.countdown === null ? formatClock(shownMs) : String(state.countdown);
  $('round-line').textContent = roundLine(state);
  $('calibration').hidden = state.calibrationProgress === null;
  $('calibration-fill').style.transform = `scaleX(${(state.calibrationProgress ?? 0).toFixed(3)})`;

  $('calibrate').disabled = !live || ['playing', 'countdown', 'calibrating'].includes(state.phase);
  $('start').disabled = !live || !(state.phase === 'ready' || state.phase === 'broken');
  $('stop').disabled = state.phase !== 'playing' && state.phase !== 'countdown';

  if (document.activeElement !== $('threshold')) $('threshold').value = String(state.threshold);
  $('threshold-value').textContent = String(state.threshold);
  $('resting').textContent = state.restingPeak === null
    ? 'Higher is more forgiving.'
    : `Your resting face peaked at ${Math.round(state.restingPeak)} during calibration. Higher is more forgiving.`;

  if (!distractionsBuilt) buildDistractions(state.distractions);
  for (const button of $('distractions').querySelectorAll('button')) button.disabled = state.phase !== 'playing';

  const rows = state.leaderboard.map((entry) => {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;
    const breaks = document.createElement('span');
    breaks.className = 'breaks';
    breaks.textContent = String(entry.breaks);
    row.append(name, breaks);
    return row;
  });
  $('board-list').replaceChildren(...rows);
  $('best').textContent = formatClock(state.bestMs);
  $('overlay-url').textContent = state.overlayUrl ?? 'unavailable';
}

function drawFrame(frame) {
  const canvas = $('preview');
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  }
  previewContext.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
}

$('consent-yes').addEventListener('click', async () => {
  $('consent').hidden = true;
  $('table').hidden = false;
  await loadCameras();
});
$('consent-no').addEventListener('click', () => {
  $('consent-note').hidden = false;
});
$('revoke').addEventListener('click', async () => {
  await api.stopCamera();
  previewContext.clearRect(0, 0, $('preview').width, $('preview').height);
  $('table').hidden = true;
  $('consent').hidden = false;
});
$('camera-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await api.startCamera($('camera').value);
  if (!result.ok) showError(result.error);
});
$('calibrate').addEventListener('click', () => api.dispatch({ type: 'calibrate' }));
$('start').addEventListener('click', () => api.dispatch({ type: 'start' }));
$('stop').addEventListener('click', () => api.dispatch({ type: 'stop' }));
$('threshold').addEventListener('input', (event) => api.dispatch({ type: 'settings', threshold: Number(event.target.value) }));
$('copy-url').addEventListener('click', async () => {
  await api.copyOverlayUrl();
  $('copy-url').textContent = 'Copied';
  setTimeout(() => { $('copy-url').textContent = 'Copy'; }, 1500);
});

api.onState(render);
api.onFrame(drawFrame);
