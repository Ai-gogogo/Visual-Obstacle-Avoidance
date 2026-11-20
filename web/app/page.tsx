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
        <MonitorPanel />
        <AssistantPanel />
      </main>
      <PairDialog />
      <CalibrationDialog />
    </DesktopRuntime>
  );
}
