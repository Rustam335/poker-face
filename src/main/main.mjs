// Electron main process: owns the SDK session, the game state and the overlay server.

import { app, BrowserWindow, ipcMain, clipboard, shell } from 'electron';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGame, reduce, view } from '../game/game.mjs';
import { createSensor, listCameras } from './sensor.mjs';
import { startOverlayServer } from './overlay-server.mjs';

const PUBLISH_INTERVAL_MS = 100;
const DEFAULT_OVERLAY_PORT = 4747;
const RENDERER_EVENT_TYPES = new Set(['calibrate', 'start', 'stop', 'settings', 'distraction', 'reset']);
const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));

function loadEnvFile() {
  try {
    const text = readFileSync(here('../../.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

loadEnvFile();
const apiKey = process.env.SMARTSPECTRA_API_KEY ?? '';
const overlayPort = Number(process.env.OVERLAY_PORT) || DEFAULT_OVERLAY_PORT;

let game = createGame();
let sensorInfo = { status: 'off', error: apiKey ? null : 'SMARTSPECTRA_API_KEY is missing. Add it to .env and restart.', cameraName: null };
let overlayUrl = null;
let sensor = null;
let controlWindow = null;
let overlay = null;

const setSensorInfo = (patch) => {
  sensorInfo = { ...sensorInfo, ...patch };
};

const dispatch = (event) => {
  game = reduce(game, event);
};

const sendToWindow = (channel, payload) => {
  if (controlWindow && !controlWindow.isDestroyed()) controlWindow.webContents.send(channel, payload);
};

function publish() {
  const now = Date.now();
  dispatch({ type: 'tick', at: now });
  const snapshot = view(game, now);
  overlay?.publish(snapshot);
  sendToWindow('state', { ...snapshot, sensor: sensorInfo, overlayUrl });
}

function getSensor() {
  if (sensor) return sensor;
  sensor = createSensor({
    apiKey,
    onEvent: dispatch,
    onFrame: (frame) => sendToWindow('frame', frame),
    onStatus: (status) => setSensorInfo({ status }),
    onError: (message) => setSensorInfo({ error: message }),
  });
  return sensor;
}

function registerIpc() {
  ipcMain.handle('cameras:list', () => listCameras());

  ipcMain.handle('sensor:start', async (_event, cameraId) => {
    const camera = listCameras().find((entry) => entry.id === cameraId);
    if (!camera) return { ok: false, error: 'That camera is no longer available.' };
    if (!apiKey) return { ok: false, error: sensorInfo.error };
    try {
      setSensorInfo({ error: null, cameraName: camera.name });
      await getSensor().start(camera.id);
      return { ok: true };
    } catch (error) {
      setSensorInfo({ error: error.message, status: 'off' });
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('sensor:stop', async () => {
    await sensor?.stop();
    dispatch({ type: 'reset' });
    setSensorInfo({ status: 'off', cameraName: null });
    return { ok: true };
  });

  ipcMain.handle('overlay:copy-url', () => {
    if (overlayUrl) clipboard.writeText(overlayUrl);
    return overlayUrl;
  });

  ipcMain.on('game:dispatch', (_event, payload) => {
    if (!payload || typeof payload !== 'object' || !RENDERER_EVENT_TYPES.has(payload.type)) return;
    dispatch({
      type: payload.type,
      at: Date.now(),
      sender: typeof payload.sender === 'string' ? payload.sender : '',
      kind: typeof payload.kind === 'string' ? payload.kind : '',
      threshold: payload.threshold,
    });
  });
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0d2a22',
    autoHideMenuBar: true,
    title: 'Poker Face',
    webPreferences: { preload: here('./preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  controlWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:')) shell.openExternal(url);
    return { action: 'deny' };
  });
  controlWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  controlWindow.loadFile(here('../control/index.html'));
}

app.whenReady().then(async () => {
  registerIpc();
  overlay = startOverlayServer(overlayPort);
  try {
    overlayUrl = await overlay.ready;
  } catch (error) {
    setSensorInfo({ error: `Overlay server could not start on port ${overlayPort}: ${error.message}` });
  }
  createControlWindow();
  setInterval(publish, PUBLISH_INTERVAL_MS);
});

let quitting = false;
app.on('before-quit', async (event) => {
  if (quitting || !sensor) return;
  quitting = true;
  event.preventDefault();
  try {
    await sensor.destroy();
  } catch (error) {
    process.stderr.write(`[shutdown] ${error.message}\n`);
  }
  overlay?.close();
  app.exit(0);
});

app.on('window-all-closed', () => app.quit());
