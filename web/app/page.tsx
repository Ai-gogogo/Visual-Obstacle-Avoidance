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
        <aside className="model-compute" aria-label="Model compute">
          <p><strong>YOLO</strong> <span id="yolo-compute">Checking worker…</span></p>
          <p><strong>Agent</strong> <span id="agent-compute">Checking loaded models…</span></p>
          <p><strong>Voice</strong> <span>CPU · transcription and synthesis</span></p>
        </aside>
        <MonitorPanel />
        <AssistantPanel />
      </main>
      <PairDialog />
      <CalibrationDialog />
    </DesktopRuntime>
  );
}
