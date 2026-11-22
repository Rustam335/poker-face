// Wraps the SmartSpectra SDK and turns its packets into plain game events.
// Runs in the Electron main process: the SDK captures the camera natively.

import {
  SmartSpectraSDK,
  CameraSelection,
  MetricType,
  ValidationCode,
  ProcessingStatus,
  PixelFormat,
  faceMetrics,
  decodeMetrics,
} from '@smartspectra/node-sdk';

const EXPRESSION_NAMES = ['UNSPECIFIED', 'ANGRY', 'CONTEMPT', 'DISGUST', 'FEAR', 'HAPPY', 'NEUTRAL', 'SAD', 'SURPRISE'];
const PREVIEW_WIDTH = 320;
const PREVIEW_INTERVAL_MS = 100;
const BYTES_PER_PIXEL = { [PixelFormat.kRGB]: 3, [PixelFormat.kBGR]: 3, [PixelFormat.kRGBA]: 4, [PixelFormat.kBGRA]: 4 };
const BLUE_FIRST = new Set([PixelFormat.kBGR, PixelFormat.kBGRA]);

const nameOf = (table, value) => Object.keys(table).find((key) => table[key] === value) ?? String(value);
const last = (list) => (list && list.length > 0 ? list[list.length - 1] : null);

export function listCameras() {
  return SmartSpectraSDK.availableCameras().map((camera) => ({ id: camera.id, name: camera.name ?? 'Unnamed camera' }));
}

/** Shrinks a packed RGB/BGR(A) frame to a small RGBA buffer for the preview canvas. */
function toPreview(buf, width, height, stride, pixelFormat) {
  const bytes = BYTES_PER_PIXEL[pixelFormat];
  if (!bytes) return null;
  const step = Math.max(1, Math.ceil(width / PREVIEW_WIDTH));
  const outWidth = Math.floor(width / step);
  const outHeight = Math.floor(height / step);
  const out = Buffer.allocUnsafe(outWidth * outHeight * 4);
  const [red, blue] = BLUE_FIRST.has(pixelFormat) ? [2, 0] : [0, 2];
  let o = 0;
  for (let y = 0; y < outHeight; y += 1) {
    const row = y * step * stride;
    for (let x = 0; x < outWidth; x += 1) {
      const i = row + x * step * bytes;
      out[o] = buf[i + red];
      out[o + 1] = buf[i + 1];
      out[o + 2] = buf[i + blue];
      out[o + 3] = 255;
      o += 4;
    }
  }
  return { data: out, width: outWidth, height: outHeight };
}

function eventsFromPacket(buf, at) {
  const metrics = decodeMetrics(buf);
  const events = [];
  const expression = last(metrics.face?.expression);
  if (expression) {
    const scores = Object.fromEntries(
      (expression.scores ?? []).map((score) => [EXPRESSION_NAMES[score.type] ?? String(score.type), score.confidence]),
    );
    events.push({ type: 'expression', at, scores });
  }
  const pulse = last(metrics.cardio?.pulseRate);
  if (pulse) events.push({ type: 'pulse', at, value: pulse.value, stable: Boolean(pulse.stable) });
  return events;
}

/**
 * @param {{ apiKey: string, onEvent: (event: object) => void, onFrame: (frame: object) => void,
 *           onStatus: (status: string) => void, onError: (message: string) => void }} options
 */
export function createSensor({ apiKey, onEvent, onFrame, onStatus, onError }) {
  const sdk = new SmartSpectraSDK({
    apiKey,
    requestedMetrics: [...faceMetrics, MetricType.PULSE_RATE],
    enableTelemetry: false,
  });
  let running = false;
  let lastPreviewAt = 0;

  sdk.on('processingStatus', (status) => onStatus(nameOf(ProcessingStatus, status)));
  sdk.on('validationStatus', (code, _timestamp, hint) =>
    onEvent({ type: 'validation', at: Date.now(), code: nameOf(ValidationCode, code), hint }),
  );
  sdk.on('error', (code, message) => onError(`${message} (code ${code})`));
  sdk.on('metrics', (buf) => {
    for (const event of eventsFromPacket(buf, Date.now())) onEvent(event);
  });
  sdk.on('videoOutput', (buf, width, height, stride, pixelFormat) => {
    const now = Date.now();
    if (now - lastPreviewAt < PREVIEW_INTERVAL_MS) return;
    lastPreviewAt = now;
    const frame = toPreview(buf, width, height, stride, pixelFormat);
    if (frame) onFrame(frame);
  });

  async function stop() {
    if (!running) return;
    running = false;
    await sdk.stopAsync();
  }

  return {
    async start(cameraId) {
      await stop();
      sdk.useCamera(CameraSelection.byId(cameraId));
      sdk.start();
      running = true;
    },
    stop,
    async destroy() {
      await stop();
      await sdk.destroy();
    },
  };
}
