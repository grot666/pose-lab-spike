# POSE LAB — MediaPipe Pose Landmarker spike

A spike that checks whether **MediaPipe Pose Landmarker** can do real-time pose recognition in the browser: **detect → judge → visualize → measure**. Default is **single-device / local**. Optional **room-code multi-device** sync (phone camera → desktop viewer) uses PeerJS cloud signaling.

The theme is an adult, consensual BDSM role-play set in a sci-fi AI lab. The "Dom" is a floating white sphere AI with no humanoid form and no speech. It talks through light (colour, pulse, orbit rings, scan beam, a hold-progress halo) and on-screen text in a cold, condescending lab voice.

* No speech (no TTS), no account backend. You run it locally with `npm run dev`; CI also publishes the same static build to GitHub Pages (see "CI and GitHub Pages"). There is a quiet sci-fi lab hum plus a few UI beeps, all procedurally generated local files (see "Audio").
* **Models and WASM are same-origin** (`public/`). Single-device mode needs no network at runtime. Room mode opens a WebRTC data channel via the **PeerJS cloud broker** (`0.peerjs.com`) for signaling only; landmarks travel peer-to-peer. CSP allows that signaling host (see "Multi-device rooms" and "Findings").
* **No image or video upload or saving.** Frames go straight from the `<video>` element to the in-memory detector. Room mode shares compact landmark + session JSON with the peer who knows the room code — not raw video (landmarks-first spike).
* There's a **safeword** button in the bottom-right corner at all times. It hard-stops the loop and the camera. In room mode, safeword on **either** device ends the session for **both**.

---

## Quick start

```bash
git clone https://github.com/grot666/pose-lab-spike.git
cd pose-lab-spike
npm install
npm run dev            # https://localhost:5173  (self-signed cert, accept the warning)
```

Requires Node 20.19+ (or 22.12+). `npm run dev` / `npm run build` first run `scripts/check-assets.mjs`. If a model or WASM file is missing, it stops and tells you to run `npm run fetch-models`.

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server on **HTTPS** (`@vitejs/plugin-basic-ssl`) at **host 0.0.0.0:5173**. YAML hot reload. |
| `npm test` | Vitest: pose rules, One Euro filter, debounce, safeword, tracking, session, room code/protocol, i18n parity, audio bank |
| `npm run build` | `tsc --noEmit` + production build into `dist/` (models and WASM included) |
| `npm run preview` | Serves `dist/` over HTTPS on 0.0.0.0:4173 |
| `npm run fetch-models` | One-time asset setup (see below). Add `-- --force` to re-download. |
| `npm run gen-audio` | Re-synthesise `public/audio/*.wav` (deterministic, no deps, no network) |

URL parameters: `?lang=en` / `?lang=zh-CN`, `?debug=1` (open the debug panel), `?tier=lite|full|heavy`, `?seq=random|sequential`, `?mute=1` (start with audio muted), `?role=camera|viewer&room=ABCD` (multi-device room; see below), `?mode=face` (standalone facial expression test; see below).

### Multi-device rooms (PeerJS)

Same session on two devices via a short **room code**. No accounts.

| Role | Device | What it does |
|---|---|---|
| **camera** | Phone | Captures camera, runs MediaPipe Pose locally, owns the session timers / judging, sends landmarks + session HUD state over a PeerJS data channel. |
| **viewer** | Desktop | Does **not** load MediaPipe. Reconstructs the 2D skeleton + 3D capsule from landmarks, shows HUD / debug. Safeword still works. |

**Signaling:** [PeerJS](https://peerjs.com/) npm package (`peerjs@1.5.5`) + free cloud broker **`0.peerjs.com`** (WSS/HTTPS). Documented spike dependency — swap for a self-hosted PeerServer / PartyKit / Worker later if needed. Data channel serialization is **JSON** (no CBOR / `unsafe-eval`). Landmarks-first; optional low-res video WebRTC is out of scope for this spike (phone may still mirror `getUserMedia` locally).

**How to create / join**

1. Open the app (Pages or `npm run dev`) on either device.
2. **Create room** → generates a 4-character code (e.g. `WXYZ`), opens as **camera**, and shows a **Copy viewer link** button.
3. On the other device: **Join room**, enter the code, pick **viewer** (or open the copied `?role=viewer&room=WXYZ` link).
4. Wait until both show **Peer linked**, then tap **Start** on each side (camera starts sensors + model; viewer starts listening).
5. Single-device remains the default: use **Single device (local only)** when no room params are present.

Direct URLs also work: `?role=camera&room=ABCD` / `?role=viewer&room=ABCD`.

**CSP:** `connect-src` allows `'self'` plus `https://0.peerjs.com` and `wss://0.peerjs.com` for the broker. MediaPipe telemetry remains blocked.


### Facial expression test (`?mode=face`)

Standalone mode (not mixed into the default pose session). Entry: lobby button **表情测试 / Expression test**, or open `?mode=face`.

* Uses MediaPipe **Face Landmarker** + 52 ARKit-style **blendshapes** (`public/models/face_landmarker.task`), same offline `public/` + CSP policy as pose models (PeerJS exceptions unchanged; face mode is local-only).
* Configurable catalogue: `src/content/expressions.yaml` (ids + rules only). Copy in `src/content/i18n/{zh-CN,en}.yaml` under `expressions.*` / `face.*`.
* Included expressions: **neutral, smile, frown, surprise, mouth_open, eyes_closed, tongue_out**. Limits: `tongue_out` is often weak on webcams; frown vs soft neutral can blur; no emotion classifier — blendshape gates only.
* Same lab aesthetic: Start + Safeword, command HUD, **match confidence**, hold progress, round report, console JSON metrics (`mode: 1` tags face rounds; expression index in `attempts[].pose`).
* Pure scoring + debounce covered by `tests/expressionRules.test.ts`.

### Model and WASM assets (offline)

The repo **commits** the assets, so a fresh clone runs offline after `npm install`:

```
public/models/pose_landmarker_{lite,full,heavy}.task   5.8 / 9.4 / 30.7 MB
public/models/face_landmarker.task                     ~3.8 MB
public/mediapipe/wasm/vision_wasm_*.{js,wasm}          ~34 MB
```

Every file is under 50 MB, so no Git LFS is needed. To refresh them (for example after bumping `@mediapipe/tasks-vision`):

```bash
npm run fetch-models          # downloads missing .task files from storage.googleapis.com
                              # and copies wasm from node_modules/@mediapipe/tasks-vision/wasm
git add public && git commit -m "update mediapipe assets"
```

This one-time script is the **only** step that touches the network. `@mediapipe/tasks-vision` is pinned to an exact version (`1.0.1`) so the JS and the committed WASM always match.

### CI and GitHub Pages

`.github/workflows/ci.yml` (GitHub Actions) runs `npm ci` → `npm test` → `npm run build` on every pull request and every push to `main`, and checks that the models / WASM / audio from `public/` were copied into `dist/`.

* **Pull requests:** build and test only. Nothing is uploaded or deployed.
* **Push to `main`:** additionally
  * uploads `dist/` as a workflow artifact named **`pose-lab-dist`** (kept 30 days; download it from the run page under *Actions → CI → run → Artifacts*), and
  * deploys `dist/` to **GitHub Pages**: <https://grot666.github.io/pose-lab-spike/>

**How the Pages URL works.** This is a *project* site, so it is served from a sub-path: `https://<owner>.github.io/<repo>/`. (A *user/org* site would be a repo named `<owner>.github.io`, served from the domain root.) `vite.config.ts` builds with a relative base (`base: './'`), and all runtime asset URLs (models, WASM, audio) are resolved from `import.meta.env.BASE_URL` against the page location, so the same `dist/` works on the project sub-path, on a user/org site, behind a custom domain, and with `npm run preview`. If a host needs an absolute base, override it: `BASE_PATH=/pose-lab-spike/ npm run build`. Open the URL **with** the trailing slash (GitHub redirects `/pose-lab-spike` → `/pose-lab-spike/`).

**Camera / secure context.** `getUserMedia` only works in a secure context (HTTPS or `localhost`). GitHub Pages is always HTTPS, so the camera works there on desktop and phones without any self-signed-certificate warning. Everything still runs in the browser: models and WASM are fetched from the same Pages origin, and frames never leave the device.

**Self-hosting is unchanged:** `npm run dev` (HTTPS on 0.0.0.0:5173) remains the way to run it locally or on the LAN.

Pages source must be set to **GitHub Actions** (*Settings → Pages → Build and deployment → Source*). It is already enabled for this repo.

### Test on a phone over the LAN

1. Put the phone and the computer on the same Wi-Fi.
2. Run `npm run dev`. Vite prints a `Network: https://192.168.x.y:5173/` URL.
3. Open that **https** URL on the phone and accept the self-signed certificate warning. Camera access needs a secure context, and plain `http://<lan-ip>` will not work.
4. Prop the phone up about 2.5–3 m away at hip height. Your **whole body** has to be in frame, including feet and knees for the kneeling poses.
5. Tap **Start**, then allow the camera. Wake Lock keeps the screen on.
6. Use the debug panel (bottom-left) to switch to the **back camera**, change the model tier, and tune the filter and debounce.

On iOS, Safari 16.4+ works. If the camera doesn't start, check *Settings → Safari → Camera*. Many firewalls block port 5173, so allow it if the phone can't connect.

---

## What it does

**Layout:** camera and the 2D skeleton on the left (top on mobile/portrait). The 3D lab is on the right (bottom on mobile): the sphere AI plus a translucent 33-joint capsule figure driven by `worldLandmarks`. The HUD sits over the lab and there's an expandable debug panel.

**Test loop**
1. Face the camera. The person must be stable for 15 frames before the round starts.
2. The AI announces a pose command. Order is random (each pose once per round) or sequential.
3. You have **10 s to enter** the pose. Entering is debounced: **N = 10** consecutive matching frames.
4. **Hold** for a target drawn from **5–15 s**. You can change this in `config.ts` or with the debug sliders.
5. Outcomes:
   * **success:** hold completed.
   * **fail:** enter window expired.
   * **leave:** **M = 15** consecutive non-matching frames during the hold. The hold resets to 0 and a fresh 10 s enter window starts.
6. After the last command you get an on-screen **round report**, and a numbers-only JSON metrics object is logged with `console.info`.

**Tracking honesty**
* *Wrists invisible* (`partial`) is **not** track loss. Rules that need wrists return `unknown`. `unknown` freezes the debouncer and never counts as a miss. `at_your_service` explicitly expects hidden wrists.
* *Full track loss* (no person, or shoulders/hips not visible for more than 400 ms) **pauses every timer**. The AI comments in character ("Specimen left the observation field…"). Track loss **never** causes a fail or a leave, and it is reported separately (`trackLosses`, `trackLossMs`).

**Safeword:** `src/core/safeword.ts` defines `SafewordSource` (sources only *report*) and `SafewordController`. The controller latches the first trigger, notifies listeners once, detaches every source, and can't be re-armed. The spike ships only `ButtonSafewordSource`: the corner button, `pointerdown` + `click`, armed from page load. When it fires, the app:
* stops the detection loop
* stops the camera tracks (the camera light goes off)
* closes the landmarker and releases the wake lock
* turns the sphere to calm **warm white**, then freezes rendering
* shows the safeword end screen (aftercare copy from i18n)

---

## Project layout

```
src/
  config.ts              numbers & switches only (default lang, camera 1280x720, tiers, filter, debounce, timings)
  main.ts                bootstrap + YAML HMR wiring
  app.ts                 orchestrator: adapters -> core -> render
  core/                  framework-free, unit-tested logic (no MediaPipe, no DOM)
    roomCode.ts          room codes, ?role=&room= parsing, PeerJS host id
    roomProtocol.ts      wire messages, landmark pack/unpack, parse/validate
    landmarks.ts         unified landmark model (33 joints, virtual points, connections)
    geometry.ts          joint angles, torso tilt, head pitch, scale references
    poseRules.ts         rule DSL types + evaluator (pass / fail / unknown)
    poseLibrary.ts       validates poses.yaml (only id + rules allowed)
    oneEuro.ts           One Euro filter + whole-pose smoother
    debounce.ts          enter-N / leave-M hysteresis
    tracking.ts          tracking / partial (wrists or legs hidden) / lost, + stats
    jitter.ts            2nd-difference jitter meter (mm)
    session.ts           test-loop state machine (pause on loss, leave reset, report)
    metrics.ts           FPS / inference stats, numbers-only round report
    safeword.ts          SafewordSource, SafewordController, ButtonSafewordSource
    i18n.ts              dotted keys, {placeholders}, variants, fallback + warn
  adapters/
    mediapipePose.ts     the ONLY MediaPipe import; converts to unified PoseFrame
    camera.ts            getUserMedia (front/back, 1280x720 ideal)
    wakeLock.ts          Screen Wake Lock with re-acquire on tab return
    peerRoom.ts          PeerJS room transport (camera host / viewer dial)
  sync/
    roomBridge.ts        send-rate throttling + protocol handlers for App
  audio/
    audioBank.ts         AudioBank: register cues, play / loop / stop, mute, volume, cooldowns (pure, tested)
    webAudioBackend.ts   Web Audio output (master + ambience/sfx buses, gapless loops)
    labCues.ts           cue manifest: the ONLY place with audio file paths
    audioPrefs.ts        mute / volume persistence (localStorage)
  render/
    labScene.ts          three.js scene, EffectComposer + UnrealBloomPass + OutputPass
    sphereAI.ts          the sphere "Dom": moods, rings, halo progress shader, scan beam
    capsuleFigure.ts     33-joint translucent capsule figure from world landmarks
    skeleton2d.ts        visibility-coloured 2D overlay
    hud.ts, debugPanel.ts, audioToggle.ts, lobby.ts, dom.ts, colors.ts
  content/
    poses.yaml           7 poses: id + rules only
    i18n/zh-CN.yaml      all copy (Chinese)
    i18n/en.yaml         all copy (English) – identical keys (enforced by a test)
tests/                   vitest suites + synthetic 33-joint skeleton fixtures
scripts/                 fetch-models.mjs, check-assets.mjs, assets.mjs, gen-audio.mjs
public/                  models/*.task, mediapipe/wasm/*, audio/*.wav, favicon
```

**Unified landmarks** (`core/landmarks.ts`): world coordinates in metres with the origin at the hip centre. **+x is image-right, +y is up, +z points toward the camera.** This matches three.js. The adapter flips MediaPipe's y-down and z-away axes. Nothing outside `adapters/` imports MediaPipe types.

---

## Adding or tuning poses

Edit `src/content/poses.yaml`. It hot-reloads in `npm run dev`, and a validation error keeps the previous version and logs the reason. A pose is **only** `id` + `rules`. Names, commands and instructions go in i18n.

```yaml
- id: my_pose
  rules:
    - { id: torso_upright, type: torso_tilt, max: 15 }                        # degrees from vertical
    - { id: legs_straight, type: angle, angles: [knee_left, knee_right], min: 155, minVisibility: 0.3 }
    - { id: feet_wide, type: distance, a: left_ankle, b: right_ankle, ref: shoulder_width, axes: xz, min: 1.4 }
    - { id: hands_high, type: offset, a: [left_wrist, right_wrist], b: [left_shoulder, right_shoulder], axis: y, ref: torso, min: 0.25 }
    - { id: head_up, type: head_pitch, min: -20 }
    - id: hands_behind_back
      type: any_of
      rules:
        - { id: wrists_hidden, type: visibility, joints: [left_wrist, right_wrist], max: 0.5 }
        - { id: wrists_behind, type: offset, a: wrist_mid, b: hip_mid, axis: z, ref: shoulder_width, max: -0.05 }
```

| type | measures |
|---|---|
| `angle` | named joint angles: `elbow_*`, `shoulder_*` (0° = arm along torso), `hip_*` (180° = straight), `knee_*` (180° = straight). All listed must pass. |
| `torso_tilt` | hip_mid→shoulder_mid vs vertical, in degrees |
| `head_pitch` | ear_mid→nose elevation. Neutral ≈ −12°, bowed < −30°, chin up > 0° |
| `distance` | \|a−b\| / ref (`shoulder_width`, `hip_width`, `torso`, `meter`), optionally on a subset of axes |
| `offset` | (a.axis − b.axis) / ref; lists are evaluated pairwise |
| `visibility` | joint visibility range (`mode: all\|any`) |
| `any_of` / `all_of` / `not` | combinators |

Points: the 33 MediaPipe joint names plus `shoulder_mid hip_mid ear_mid wrist_mid elbow_mid knee_mid ankle_mid`.

Then:
1. Add `poses.<id>.{name,command,instruction}` and `hints.<rule id>` to **both** `zh-CN.yaml` and `en.yaml`.
2. Add a synthetic skeleton to `tests/fixtures/skeletons.ts`. The confusion-matrix test requires that each fixture matches **only** its own pose.
3. Tune against real data with the debug panel. When no command is active it shows the best-matching pose with every rule's live value.

Shipped poses: `attention`, `at_your_service` (hands clasped behind the back), `inspection` (feet wide, hands behind the head, elbows out), `wait` (hands clasped low in front, head bowed), `kneel` (high kneel), `nadu` (sitting on heels, knees wide, palms on thighs, head up), `collar_me` (kneeling, chin raised, hands at the nape).

---

## Audio

* **Ambience:** a low, seamless 8 s drone loop (55/110 Hz partials with slow beating, faint shimmer and a filtered-noise "air handler" bed). It fades in when you click **开始 / Start**. The click also unlocks Web Audio for autoplay policies. It fades out when a round ends (report screen), comes back on **Next round**, and stops for good on the **safeword**. While the tab is hidden, output is suspended.
* **UI cues** (short, quiet, with per-cue cooldowns so they never spam): command issued, success, fail, and track lost (at most once every 5 s).
* **Toggle:** use the **音效 开/关 · SOUND ON/OFF** button in the top bar, or press **M**. The debug panel (`?debug=1`) also has **Audio → Mute / volume** and shows the AudioContext state. Mute and volume persist in `localStorage` (`pose-lab.audio`).
* **Assets:** `public/audio/*.wav` (16-bit mono, 22.05 kHz, ~465 KB total) are synthesised by `scripts/gen-audio.mjs`. The output is deterministic, needs no third-party sounds and no network, and is committed. They're served same-origin, so the CSP is unchanged.
* **Adding a cue:** generate or drop a file into `public/audio/`, add `{ id, src, bus, volume, loop?, cooldownMs? }` to `src/audio/labCues.ts`, then call `audio.play('<id>')` / `audio.loop('<id>')` from the orchestrator. Render widgets never see file paths. `AudioBank.register()` / `replaceAll()` also work at runtime.

## i18n

* All user-facing text is in `src/content/i18n/zh-CN.yaml` and `en.yaml`, including the debug labels and the subject-ID format (`subject.id_format: "S-{n}"`). Nothing is hard-coded in TS.
* The default language is `config.defaultLang` (`zh-CN`). Override it with `?lang=en`.
* `{placeholders}`: `{subjectId}` is global, and `{pose}`, `{seconds}`, `{round}`, … are passed per call.
* A list value means "pick a random variant", which keeps the lab voice from repeating itself.
* A missing key falls back to `config.fallbackLang`, then to the key itself, with a one-time `console.warn`.
* Edits hot-reload without restarting the session. A test checks that both files have identical keys and that every pose and rule has copy.

---

## Metrics JSON (console, numbers only)

At the end of each round, `console.info(JSON.stringify(report))` logs:

```jsonc
{ "v":1, "round":1, "durationMs":132595, "commands":7, "success":0, "fail":7, "successRate":0,
  "leaves":0, "trackLosses":9, "trackLossMs":26669, "meanEnterLatencyMs":-1, "meanHoldRatio":0,
  "perf": { "fpsMean":2.3, "inferMsMean":439.6, "inferMsP95":545.6, "modelTier":1, "gpu":1,
            "jitterRawMm":2.1, "jitterFilteredMm":1.3, "trackLostEvents":10, "trackLostMs":39913,
            "trackedRatio":0.758, "wristHiddenRatio":0 },
  "params": { "minCutoff":1.2, "beta":0.05, "dCutoff":1, "enterFrames":10, "leaveFrames":15 },
  "attempts": [ { "pose":0, "outcome":0, "failReason":1, "enterLatencyMs":-1, "holdTargetMs":12000,
                  "holdAchievedMs":0, "leaves":0, "trackLosses":2, "trackLossMs":5321,
                  "matchRatio":0, "unknownRatio":0, "wristHiddenRatio":0, "frames":23 } ] }
```

Codes:
* `pose` = index in `poses.yaml`
* `outcome`: 1 = success, 0 = fail
* `failReason`: 0 = none, 1 = enter timeout
* `modelTier`: 0 = lite, 1 = full, 2 = heavy
* `gpu`: 1 = GPU delegate, 0 = CPU
* `-1` = never happened

(The sample above comes from the headless test described below: software GL, a still photo that matches no pose, so the FPS is low and every attempt fails.)

---

## Known limits

* **Face-first detection.** The BlazePose detector finds a person through the face/upper body, *then* tracks. Acquisition fails or is slow when you start with your back to the camera, with your face hidden, or when you're too close. Face the camera first, then move. Hard head bows or faces turned away can drop tracking during the pose.
* **Fast motion loses tracking.** Quick transitions (dropping to your knees) can lose the track for a few frames. The 400 ms loss grace period and the pause-on-loss logic keep that out of the score, but expect brief `LOST` blips.
* **Depth (z) is noisy.** Anything that relies on z, like "hands behind back" or "hands in front", is the least reliable. `at_your_service` therefore also accepts "wrists not visible".
* **Kneeling occludes the lower legs.** Ankle visibility is often low, so knee-angle rules use a lowered `minVisibility`. The camera should be low (hip height) and far enough away.
* **Head pitch** comes from the ear/nose landmarks and is only approximate. Thresholds are deliberately loose.
* **Single person** (`numPoses: 1`). Bystanders in frame can steal the track.
* **Performance:** `heavy` is too slow for many phones. Start with `full` (the default) or `lite`. The GPU delegate falls back to CPU automatically.
* The rule thresholds were checked against synthetic skeletons and a sample photo, **not** against real people doing these poses. Treat them as starting points for tuning with the debug panel.

## Findings from the spike

* `@mediapipe/tasks-vision` 1.0.1 **always tries to send usage telemetry** to `https://odml.pa.googleapis.com/v1/log`, and there is no option to turn it off. The CSP in `index.html` blocks it (only `'self'` and the PeerJS broker host are allowed in `connect-src`). You'll see a CSP error in the console for the telemetry URL — expected.
* Models, WASM, and audio load same-origin. Room mode additionally contacts `0.peerjs.com` for signaling. A headless Chrome run with a fake camera recorded **zero** off-origin requests: models and WASM came from `public/`, and the GPU delegate ran via WebGL. Under software GL (SwiftShader) the `full` model ran at about 400 ms per frame; real GPUs and phones are far faster.
* `'wasm-unsafe-eval'` is enough. `'unsafe-eval'` is not needed.

## Safety and consent

This is a role-play toy for **consenting adults**. The safeword is armed from page load and works at any moment, including during model loading, and it is final for the session. All processing is local and nothing is recorded.
