"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { mountDesktop } from "./desktop-controller";
import {
  createVoicePresentation,
  VoicePresentation,
} from "./voice-presentation";

export function DesktopRuntime({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [voice] = useState(createVoicePresentation);

  useEffect(() => {
    if (root.current) return mountDesktop(root.current, voice);
  }, [voice]);

  return (
    <VoicePresentation.Provider value={voice}>
      <div ref={root}>{children}</div>
    </VoicePresentation.Provider>
  );
}
