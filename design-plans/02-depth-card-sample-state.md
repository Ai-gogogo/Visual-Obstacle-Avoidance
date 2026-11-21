# Explain the depth card in sample mode

Status: implemented in https://github.com/Ai-gogogo/Visual-Obstacle-Avoidance/pull/9

Written against: `556af43` (local branch `local/demo-integrated` = `origin/main` `751b3e0` + PRs #5–#8). The affected code is identical on `origin/main`.

## Evidence chain

- Surface: desktop dashboard `/#monitor` (Judge view), sample mode, which is the default state when the page opens and the state the "Show sample feeds" button returns to.
- Problem: in sample mode the "Stereo depth map" card (`#stereo-view`) shows a large dark frame with no explanation, or a misleading one:
  - On first load, `#stereo-caption` is empty. Measured in the running app: caption text `""`, frame `#live-depth-frame` about 300 px tall at 1440×900, so the card is a blank dark box.
  - After "Show live cameras" → "Show sample feeds", the caption reads "Waiting for a processed Camera A frame.", although sample mode never processes frames.
- Design evidence: in the same view and state, every sibling element states that it is sample content: each camera card's chip reads "Sample feed" and its footer "2 sample detections" (`web/features/perception/perception-controller.js:18` and `:54`, `setFeed`), and the detections table note reads "Sample annotations · distances are illustrative." (`perception-controller.js:153`, `renderMode`). The depth card is the only card in the view without a sample-state message.
- Owner: `web/features/perception/perception-view.js` → `showDepth(snapshot, preview, sampleMode)`, which already receives `sampleMode` and writes `#stereo-caption` from the `messages` table (line ≈125); the table has no sample entry, so with `snapshot === null` it falls through to `waiting_for_a`. Initial state: `web/features/perception/perception-controller.js` initialization (lines ≈218–219) calls `makeAnnotations` and `renderDetections` but never `showDepth`, which is why the caption is empty on first load.
- Scope and affected surfaces: `#stereo-view` on `#monitor` in sample mode only.
- Uncertainty: none. The message wording below follows the existing sample-mode copy.

## Design decision

When `sampleMode` is true and there is no depth preview, the depth card shows a sample-state caption in the existing `.no-feed` caption element, stating that sample feeds have no depth and how to see live depth. The caption is also rendered on first load, so the card is never blank. This brings the depth card in line with the other sample-mode cards.

## Reuse

- Existing caption element `#stereo-caption` (class `.no-feed`, styled by `.frame`/`.no-feed` in `web/styles/features.css`).
- Existing function `showDepth(snapshot, preview, sampleMode)` and its `sampleMode` argument.
- Copy exemplar: `#detection-note` sample text in `renderMode` ("Sample annotations · distances are illustrative.").

No new primitive is needed.

## Changes

1. `web/features/perception/perception-view.js`, in `showDepth`
   - Change: when `sampleMode && !preview`, set `#stereo-caption` text to `Sample feeds have no depth. Select Show live cameras to see depth aligned to Camera A.` instead of the `messages[status]` lookup; keep the caption visible (`hidden = false`) and leave the rest of the function unchanged.
   - Preserve: all existing live-mode messages and their status keys; the hold/“Last depth frame” logic, which already runs only when `!sampleMode`; canvas, palette and meter handling.
   - Verify: with `sampleMode` true the caption shows the sample sentence; with `sampleMode` false and no camera it still shows "Waiting for a processed Camera A frame."
2. `web/features/perception/perception-controller.js`, initialization
   - Change: after `VisionPerceptionView.renderDetections(sampleMode, feeds);` call `VisionPerceptionView.showDepth(null, null, sampleMode);` so the first render of the depth card goes through the same path as a mode switch.
   - Preserve: polling start-up and the `paired()` transition to live mode.
   - Verify: on first load the depth card shows the sample sentence without any user action.

## Scope

- Inherit: `#stereo-view` in sample mode.
- Verify: live mode with no cameras, with Camera A only, with a calibration error status (each still shows its existing message); saved-depth replay (`#depth-source` set to a saved recording) is unaffected because it uses `#saved-depth` and `#saved-depth-status`.
- Exclude: camera cards, the detections table, depth controls below the frame (their visibility in sample mode is a separate question).

## Validation

- Product: a judge opening the dashboard sees two sample camera cards and a depth card that says why it is empty and what to click.
- Interface: `/#monitor` on first load; after toggling live → sample; after pairing a phone (switches to live); high-contrast theme (caption text uses `.frame` color `#e3ecf8` on `--frame`).
- System: confirm the sample sentence lives only in `showDepth` (no second copy of the caption logic in the controller).
- Repository: `cd web && npm test && npm run typecheck && npm run build -- --webpack && npm run test:frontend` → all pass.

## Stop conditions

- Stop if `showDepth` turns out to be called with `sampleMode = true` while a saved or live depth preview is being displayed; then the condition needs product input instead of this change.

## Design documentation

- After acceptance and validation: none.
