"use client";

import { Button } from "../../components/Button";
import { useVoicePresentation } from "./voice-presentation";

export function StopPlayback() {
  const voice = useVoicePresentation();
  return (
    <Button id="stop" className="stop" disabled={!voice.canStop}>
      {voice.stopLabel}
    </Button>
  );
}
