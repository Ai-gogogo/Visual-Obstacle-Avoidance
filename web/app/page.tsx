import { DesktopHeader } from "../components/DesktopHeader";
import { DesktopRuntime } from "../features/assistant/DesktopRuntime";
import { AssistantPanel } from "../features/assistant/AssistantPanel";
import { CalibrationDialog } from "../features/calibration/CalibrationDialog";
import { PairDialog } from "../features/pairing/PairDialog";
import { MonitorPanel } from "../features/perception/MonitorPanel";

export default function DesktopPage() {
  return (
    <DesktopRuntime>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <DesktopHeader />
      <main id="main" className="shell" tabIndex={-1}>
        <p className="obstacle-alert" id="obstacle-alert" role="alert" />
        <p className="toast" id="warning-audio-status" role="status" />
        <p className="toast" id="warning-timing" hidden />
        <p className="connection-alert" id="connection-alert" role="alert" />
        <p className="toast" id="ui-feedback" role="status" />
        <section className="alert-settings" aria-labelledby="alert-settings-heading">
          <header>
            <h2 id="alert-settings-heading">
              <label htmlFor="spoken-alert-mode">Spoken alerts</label>
            </h2>
            <select id="spoken-alert-mode" defaultValue="desk" aria-describedby="spoken-alert-help spoken-alert-status">
              <option value="desk">Desk · quiet</option>
              <option value="stationary">Stationary monitoring · fixed rig</option>
              <option value="walking">Walking alerts · moving rig</option>
            </select>
            <span id="spoken-alert-status" role="status">Automatic alert speech is off.</span>
          </header>
          <details>
            <summary>Alert help and devices</summary>
            <p id="spoken-alert-help">
              Controlled testing only. Stationary mode monitors the first 1.5 m of the fixed rig’s forward corridor.
              Walking mode requires a calibrated rig aligned with your direction of travel. Select Desk when you stop.
            </p>
            <button className="quiet" id="warning-audio" type="button" aria-describedby="warning-audio-status">
              Test warning audio
            </button>
            <div className="model-compute" aria-label="Model compute">
              <p><strong>YOLO</strong> <span id="yolo-compute">Checking worker…</span></p>
              <p><strong>Agent</strong> <span id="agent-compute">Checking loaded models…</span></p>
              <p><strong>Voice</strong> <span>CPU · transcription and synthesis</span></p>
            </div>
          </details>
        </section>
        <MonitorPanel />
        <AssistantPanel />
      </main>
      <PairDialog />
      <CalibrationDialog />
    </DesktopRuntime>
  );
}
