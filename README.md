# Poker Face

A stream overlay game built on the [Presage SmartSpectra SDK](https://physiology.presagetech.com). The streamer tries to keep a straight face; the audience tries to break it. A webcam is the only sensor.

- **Hold your face.** A clock runs while your expression stays neutral.
- **Chat attacks.** Viewers send distractions. The one who makes you crack gets the credit on the Top Breakers board.
- **You break when you react.** A smile, a startle or a flinch held past the threshold ends the round with a "POKER FACE BROKEN!" stamp.
- **Tension multiplier.** When the pulse reading is stable and above your baseline, points multiply up to ×2. When it is not stable, the overlay says "signal lost" instead of showing a number.

The pulse reading is a game mechanic for entertainment. It is not a medical measurement and the app makes no health claims.

## How it uses SmartSpectra

The SDK runs in the Electron main process and captures the camera natively (`useCamera`). The app requests the face metrics (expressions, blinking, talking, landmarks) plus `PULSE_RATE`, and uses:

| Signal | Used for |
| --- | --- |
| Expression scores (`HAPPY`, `SURPRISE`, `FEAR`) | Breaking the round: score at or above the threshold for 300 ms |
| `validationStatus` codes | Pausing the clock when the face is missing, turned away, or there are two faces; on-screen hints |
| Pulse rate with `stable` flag | Baseline during calibration, tension multiplier during a round, "signal lost" when unstable or stale |
| `videoOutput` frames | A small, mirrored preview in the control window |

The break rule (threshold 70, held 300 ms) comes from measuring the SDK on a laptop webcam: expressions arrive about 24 times a second with roughly 33 ms lag, and a single-frame threshold of 50 fired while talking.

## Requirements

- Windows 10/11 x64 (developed and tested there; the SDK also supports macOS and Linux, untested here)
- Node.js 20 or newer, Yarn 4 (`corepack enable`)
- A webcam and a SmartSpectra API key

## Setup

```
yarn install
cp .env.example .env      # then put your key in SMARTSPECTRA_API_KEY
yarn start
```

If Electron reports that it is not installed, run `node node_modules/electron/install.js` once.

## Playing

1. Read the consent screen and agree. The camera stays off until you do.
2. Pick a camera and press **Use this camera**. Face it with light on your face.
3. Press **Calibrate** and hold a neutral face for eight seconds. Pulse usually needs 25–30 seconds to appear; the round does not wait for it.
4. Press **Deal a round**. A three-second countdown lets you settle your face before the clock starts. Use the **Chat simulator** to send distractions under any viewer name.
5. React and the round breaks. **Fold** ends a round without a break.

**Break threshold** is adjustable (30–95). The app shows how high your resting face peaked during calibration so you can set it fairly.

## Adding the overlay to OBS

1. Start Poker Face. The footer shows the overlay address (default `http://127.0.0.1:4747/`).
2. In OBS add a **Browser** source with that URL, 1920×1080, transparent background.

Set `OVERLAY_PORT` in `.env` to change the port.

**Sharing the webcam with OBS.** On Windows a webcam can usually be opened by one app at a time. Poker Face lists every camera the system exposes, including virtual ones, so one option is to give the webcam to OBS and select **OBS Virtual Camera** in Poker Face. This route has not been verified end to end yet.

## Consent and Data Handling

- **Explicit consent first.** The first screen explains what is captured and why. The SDK session and the camera start only after you press "I agree". "Turn camera off" stops the camera and returns to that screen.
- **What is processed.** Webcam frames are analysed by the SmartSpectra SDK on this computer to produce expression scores, face-validity codes and a pulse estimate.
- **What is stored.** Nothing. The app writes no video, images, readings or logs to disk. Game state, including the leaderboard, lives in memory and is gone when the app closes.
- **What is shared.** The overlay page receives game state only: timer, points, a strain bar, viewer names, and a rounded pulse number while the reading is stable. It is served on `127.0.0.1` and is not reachable from other machines. If you add it to a stream, your viewers see what the overlay shows.
- **Presage.** The SDK contacts Presage to validate the API key. The SDK's optional telemetry is disabled in this app (`enableTelemetry: false`). The SDK's own data handling is governed by Presage's terms and privacy documentation.
- **Not medical.** Pulse is shown for entertainment, only while the SDK marks it stable, and is never interpreted as a health indicator.
- **One person.** Only the consenting streamer should be on camera. The clock pauses when more than one face is detected.
- **API key.** Read from `.env`, which is git-ignored. It is never sent to the control window or the overlay.

## Limitations

- Chat is simulated from the control window; there is no live chat integration.
- Pulse needs a still, well-lit face and often drops out after head movement.
- A resting face can read as `SAD`; only `HAPPY`, `SURPRISE` and `FEAR` count as reactions.
- No installer. Run from source.

## Project layout

```
src/game/game.mjs            pure game rules (reducer + view), no I/O
src/main/main.mjs            Electron main: SDK session, IPC, publish loop
src/main/sensor.mjs          SmartSpectra wrapper -> game events + preview frames
src/main/overlay-server.mjs  127.0.0.1 HTTP + server-sent events for OBS
src/control/                 control window (consent, camera, round, chat simulator)
src/overlay/                 OBS browser-source overlay
test/game.test.mjs           rule tests (yarn test)
spike-poker-face.mjs         signal latency/stability probe (yarn spike)
```

## Tests

```
yarn test
```
