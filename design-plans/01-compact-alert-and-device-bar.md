# Put each page's heading and primary action back in the first screen

Status: implemented in https://github.com/Ai-gogogo/Visual-Obstacle-Avoidance/pull/9

Written against: `556af43` (local branch `local/demo-integrated` = `origin/main` `751b3e0` + PRs #5–#8). The affected markup is identical on `origin/main`.

## Evidence chain

- Surface: desktop dashboard `/`, both pages: Judge view (`#monitor`) and Voice assistant (`#assist`).
- Problem: `web/app/page.tsx` renders two blocks inside `main.shell` **before** `<MonitorPanel />` and `<AssistantPanel />`, so they appear above both page headings:
  1. `div.voice-options.model-compute`: the "Spoken alerts" select, a two-sentence help paragraph (`#spoken-alert-help`), the status line (`#spoken-alert-status`) and the "Test warning audio" button.
  2. `aside.model-compute` (`aria-label="Model compute"`): three lines "YOLO … / Agent … / Voice …".
  Measured in the running app at a 1440×900 viewport on `#assist`: the page `h1` starts at y = 439 px, the microphone button (`.mic`) ends at y = 799 px, and the prompt "Tap to start a conversation" (`.voice-prompt`) ends at y = 885 px. The primary action barely fits on the first screen at 900 px, and at a 768 px laptop height the microphone falls below the fold. On `#monitor` the "Live perception" heading also starts below these blocks.
- Design evidence: every page section starts with `.page-head` holding the page `h1` (`web/features/perception/MonitorPanel.tsx`, `web/features/assistant/AssistantPanel.tsx`). The product already has a pattern for "one always-visible control row + secondary details in a disclosure" inside a card: `web/features/perception/StereoRecordings.tsx` (`section.stereo-recordings` → `header` with `h2`, a primary control and a `role="status"` span → `<details>` with `<summary>` holding the rest), styled in `web/styles/features.css` (`.stereo-recordings`, `.stereo-recordings header`, `.stereo-recordings details`, `.stereo-recordings summary`).
- Owner: `web/app/page.tsx` (markup); `web/styles/features.css` (card rules).
- Scope and affected surfaces: both desktop pages (the blocks are shared). JavaScript owners that look up these elements by id: `web/features/alerts/alerts-controller.js` (`#spoken-alert-mode`, `#spoken-alert-status`), `web/features/assistant/desktop-controller.js` (`#warning-audio`, `#warning-audio-status`), `web/features/assistant/model-compute.js` (`#yolo-compute`, `#agent-compute`).
- Uncertainty: none about the cause. Exact wording of the new summary label is a copy choice; use the label given below.

## Design decision

Merge the two blocks into **one compact card that follows the StereoRecordings pattern**: a single header row that keeps what an operator must see and change during a demo (the alert mode select and its live status), and a collapsed `<details>` that holds everything secondary (the help text, the test button and the model/device lines). This shrinks the area above the page heading from two tall blocks to one row, so each page's `h1` and primary action return to the first screen, while the alert mode stays one click away on both pages.

## Reuse

- Card and disclosure styling: extend the existing `.stereo-recordings` rules in `web/styles/features.css` to also match the new card class (add `.alert-settings` to those selectors) instead of writing new rules.
- Controls keep their existing classes: `.quiet` button, global `select` styling from `web/styles/components.css`.
- Exemplar: `web/features/perception/StereoRecordings.tsx`.

No new primitive is needed.

## Changes

1. `web/app/page.tsx`
   - Change: replace `div.voice-options.model-compute` and `aside.model-compute` with one block:
     ```tsx
     <section className="alert-settings" aria-labelledby="alert-settings-heading">
       <header>
         <h2 id="alert-settings-heading">
           <label htmlFor="spoken-alert-mode">Spoken alerts</label>
         </h2>
         <select id="spoken-alert-mode" defaultValue="desk" aria-describedby="spoken-alert-help spoken-alert-status">…same three options…</select>
         <span id="spoken-alert-status" role="status">Automatic alert speech is off.</span>
       </header>
       <details>
         <summary>Alert help and devices</summary>
         <p id="spoken-alert-help">…same text…</p>
         <button className="quiet" id="warning-audio" type="button" aria-describedby="warning-audio-status">Test warning audio</button>
         <div className="model-compute" aria-label="Model compute">…the same three <p> lines with #yolo-compute and #agent-compute…</div>
       </details>
     </section>
     ```
     Keep the block where it is now (inside `main.shell`, after the alert/toast paragraphs and before `<MonitorPanel />`).
   - Preserve: every element id listed under "Owner/Scope"; the select's three option values (`desk`, `stationary`, `walking`) and labels; `aria-describedby` targets; the `role="status"` on `#spoken-alert-status`; the `#obstacle-alert`, `#warning-audio-status`, `#connection-alert` and toast paragraphs above it.
   - Verify: on both pages the header row shows "Spoken alerts", the select and the status text in one line at ≥ 1060 px width; the details are collapsed on load.
2. `web/styles/features.css`
   - Change: add `.alert-settings` alongside `.stereo-recordings` in the existing rules for the card, its `header`, `h2`, `details` and `summary`. Remove the outer card styling that only applied because the old block carried `.model-compute`; the inner `.model-compute` keeps its existing flex layout but inside the card it should not draw a second border (set `border:0;padding:0;margin:0` for `.alert-settings .model-compute`).
   - Preserve: `.stereo-recordings` appearance; `.model-compute` styling anywhere else.
   - Verify: the alert card and the "Stereo recordings" card look like siblings (same border, radius, padding, summary style).

## Scope

- Inherit: both desktop pages.
- Verify: high-contrast theme (`:root[data-contrast]`), reduced motion, narrow widths (≤ 760 px and ≤ 400 px media queries in `web/styles/layout.css`) where the header row must wrap without overflow.
- Exclude: the content of the "Voice" device line (it is hard-coded and currently inaccurate on NVIDIA machines, but fixing it needs runtime reporting, which is functional work); the phone page `/camera`.

## Validation

- Product: an operator opens Voice assistant, sees the page title and the microphone without scrolling, switches Spoken alerts to "Walking alerts" from the header row, and reads the status change ("Walking alerts selected…" or "Spoken alerts paused…") next to it.
- Interface: `#assist` and `#monitor` at 1440×900 and 1366×768 (the `.mic` button fully visible on `#assist` at 768 px height); open/close the details; "Test warning audio" still plays and its message appears in `#warning-audio-status`; YOLO/Agent lines still update inside the details; high-contrast on/off; 390 px width.
- System: confirm no new card rules were written in parallel to `.stereo-recordings`.
- Repository: `cd web && npm test && npm run typecheck && npm run build -- --webpack && npm run test:frontend` → all pass (the spoken-alerts frontend test looks the controls up by id).

## Stop conditions

- Stop if any controller selects these elements by class or by position instead of by id, or if a test depends on the old `.voice-options` wrapper; report it instead of rewriting the controller.
- Stop if the team decides spoken-alert mode should only live on one page; that changes the scope from layout to product structure.

## Design documentation

- After acceptance and validation: none (the repository has no design documentation for this surface).
