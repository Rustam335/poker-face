// Renders game snapshots pushed by the app over server-sent events.

const FEED_VISIBLE_MS = 9000;
const PHASE_LABELS = { idle: 'waiting', calibrating: 'calibrating', ready: 'ready', countdown: 'get ready', playing: 'live', broken: 'broken' };
const REACTION_WORDS = { HAPPY: 'cracked a smile', SURPRISE: 'got startled', FEAR: 'flinched' };

const $ = (id) => document.getElementById(id);
const feedItems = new Map(); // id -> { element, at }

function formatClock(ms) {
  const tenths = Math.floor(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths % 10}`;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderFeed(feed, distractions) {
  const liveIds = new Set(feed.map((item) => item.id));
  for (const [id, entry] of feedItems) {
    if (!liveIds.has(id)) {
      entry.element.remove();
      feedItems.delete(id);
    }
  }
  for (const item of [...feed].reverse()) {
    if (feedItems.has(item.id)) continue;
    const kind = distractions[item.kind] ?? { label: item.kind, emoji: '🃏' };
    const row = element('li');
    row.append(element('span', 'emoji', kind.emoji), element('span', 'sender', item.sender), element('span', '', `sent a ${kind.label}`));
    $('feed').prepend(row);
    feedItems.set(item.id, { element: row, at: item.at });
  }
  const now = Date.now();
  for (const entry of feedItems.values()) entry.element.classList.toggle('is-old', now - entry.at > FEED_VISIBLE_MS);
}

function renderBoard(leaderboard) {
  $('board').classList.toggle('is-empty', leaderboard.length === 0);
  const rows = leaderboard.map((entry) => {
    const row = element('li');
    row.append(element('span', 'name', entry.name), element('span', 'breaks', String(entry.breaks)));
    return row;
  });
  $('board-list').replaceChildren(...rows);
}

function render(state) {
  document.body.dataset.phase = state.phase;
  $('phase').textContent = state.phase === 'playing' && !state.faceOk ? 'face the camera' : PHASE_LABELS[state.phase] ?? state.phase;

  const shownMs = state.phase === 'broken' && state.broken ? state.broken.survivedMs : state.survivedMs;
  $('clock').textContent = state.countdown === null ? formatClock(shownMs) : String(state.countdown);
  $('points').textContent = String(state.phase === 'broken' && state.broken ? state.broken.points : state.points);

  $('strain-fill').style.transform = `scaleX(${state.strain.toFixed(3)})`;
  $('strain').setAttribute('aria-valuenow', String(Math.round(state.strain * 100)));
  $('strain-label').textContent = state.strain > 0.75 ? 'cracking' : state.strain > 0.4 ? 'twitching' : 'steady';

  const hasPulse = state.pulse !== null;
  $('pulse-chip').classList.toggle('is-lost', !hasPulse);
  $('pulse').textContent = hasPulse ? String(state.pulse) : 'signal lost';
  $('multiplier').textContent = `×${state.multiplier.toFixed(1)}`;

  renderFeed(state.feed, state.distractions);
  renderBoard(state.leaderboard);

  if (state.broken) {
    $('broken-label').textContent = REACTION_WORDS[state.broken.label] ?? 'cracked';
    const held = `held ${formatClock(state.broken.survivedMs)}`;
    $('broken-by').textContent = state.broken.by ? `broken by ${state.broken.by} · ${held}` : held;
  }
}

const source = new EventSource('/events');
source.onmessage = (message) => {
  try {
    render(JSON.parse(message.data));
  } catch (error) {
    console.error('Overlay could not render a snapshot', error);
  }
};
