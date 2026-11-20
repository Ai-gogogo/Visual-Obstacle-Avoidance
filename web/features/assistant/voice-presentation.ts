"use client";

import { createContext, useContext, useSyncExternalStore } from "react";

type VoiceState = {
  title: string;
  prompt: string;
  label: string;
  stopLabel: string;
  canStop: boolean;
};

const initialVoice: VoiceState = {
  title: "Ready",
  prompt: "Tap to start a conversation",
  label: "Start conversation",
  stopLabel: "Stop playback",
  canStop: false,
};

export function createVoicePresentation() {
  let current = initialVoice;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read: () => current,
    initial: () => initialVoice,
    publish(state: VoiceState) {
      current = state;
      listeners.forEach((listener) => listener());
    },
  };
}

export const VoicePresentation = createContext<ReturnType<
  typeof createVoicePresentation
> | null>(null);

export function useVoicePresentation() {
  const source = useContext(VoicePresentation);
  if (!source) throw new Error("Voice presentation requires DesktopRuntime.");
  return useSyncExternalStore(source.subscribe, source.read, source.initial);
}
