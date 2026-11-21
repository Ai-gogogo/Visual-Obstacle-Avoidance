"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "../../components/Button";
import { createAccessibility } from "../../shared/accessibility";
import { createScope } from "../../shared/scope";
import { createCameraUpload, storedPairing } from "./camera-upload";

type CameraState =
  | { phase: "idle"; message?: string; invalid?: boolean; resumable?: boolean }
  | { phase: "connecting"; message: string }
  | { phase: "connected"; lens: string };

export function PhoneCamera() {
  const [camera, setCamera] = useState<CameraState>({ phase: "idle" });
  const [invitedSide, setInvitedSide] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const codeField = useRef<HTMLInputElement>(null);
  const active = useRef<ReturnType<typeof createCameraUpload> | null>(null);
  const wasConnected = useRef(false);
  const connected = camera.phase === "connected";
  const connecting = camera.phase === "connecting";
  const invalid = camera.phase === "idle" && Boolean(camera.invalid);
  const resumable = camera.phase === "idle" && Boolean(camera.resumable);
  const [pairedSide, setPairedSide] = useState<string | null>(null);

  useEffect(() => {
    if (!video.current || !root.current) return;
    const invitation = new URLSearchParams(window.location.hash.slice(1));
    const code = invitation.get("code");
    if (code && /^\d{6}$/.test(code) && codeField.current) {
      codeField.current.value = code;
      const side = invitation.get("side");
      if (side === "A" || side === "B") setInvitedSide(side);
      history.replaceState(history.state, "", location.pathname + location.search);
    }
    const scope = createScope();
    createAccessibility(root.current, scope);
    let mounted = true;
    const upload = createCameraUpload(video.current, (state: CameraState) => {
      if (mounted) setCamera(state);
    });
    active.current = upload;
    const saved = storedPairing();
    if (saved && !code) {
      setPairedSide(saved.slot);
      setCamera({ phase: "idle", resumable: true,
        message: `Camera ${saved.slot} is still paired. Tap Resume camera to continue.` });
    }
    const onHide = () => upload.stop();
    window.addEventListener("pagehide", onHide);
    window.addEventListener("offline", upload.networkLost);
    return () => {
      mounted = false;
      active.current = null;
      scope.dispose();
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("offline", upload.networkLost);
      upload.stop();
    };
  }, []);

  useEffect(() => {
    if (connected) {
      video.current?.focus();
      setPairedSide(storedPairing()?.slot ?? null);
    } else if (invalid || wasConnected.current) codeField.current?.focus();
    wasConnected.current = connected;
  }, [connected, invalid]);

  function resume() {
    if (connecting || connected || !active.current) return;
    void active.current.resume();
  }

  function forget() {
    active.current?.forget();
    setPairedSide(null);
    setTimeout(() => codeField.current?.focus());
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (connecting || connected || !active.current) return;
    const fields = new FormData(event.currentTarget);
    const code = String(fields.get("code") ?? "").replace(/[\s-]/g, "");
    if (!/^\d{6}$/.test(code)) {
      setCamera({
        phase: "idle",
        invalid: true,
        message: "Enter the six-digit code.",
      });
      codeField.current?.focus();
      return;
    }
    void active.current.start(code, fields.get("quality"));
  }

  return (
    <div className="phone" ref={root}>
      <main className="phone-pair" id="phone-pair" hidden={connected}>
        <div className="phone-card">
          <div className="wordmark">
            <span className="mark" aria-hidden="true">
              ◉
            </span>
            <span>VisionAssist Camera</span>
          </div>
          <h1>{resumable && pairedSide ? `Resume Camera ${pairedSide}` :
            invitedSide ? `Pair Camera ${invitedSide}` : "Enter pairing code"}</h1>
          <p>{resumable ? "This phone keeps its pairing. No new code is needed." :
            invitedSide ? "Tap Connect camera to use this phone." : "Use the six-digit code shown on the computer."}</p>
          {resumable && (
            <div className="phone-resume">
              <Button variant="primary" id="resume" onClick={resume} disabled={connecting}>
                Resume camera
              </Button>
              <Button id="forget" onClick={forget} disabled={connecting}>
                Use a new pairing code
              </Button>
            </div>
          )}
          <form
            hidden={resumable}
            id="phone-form"
            onSubmit={submit}
            noValidate
            aria-busy={connecting}
          >
            <label htmlFor="code">Pairing code</label>
            <input
              ref={codeField}
              id="code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000 000"
              maxLength={8}
              required
              aria-describedby="phone-status"
              aria-invalid={invalid || undefined}
              onChange={() => {
                if (invalid) setCamera({ phase: "idle" });
              }}
            />
            <label htmlFor="camera-quality">Camera mode</label>
            <select
              id="camera-quality"
              name="quality"
              defaultValue="webrtc"
              aria-describedby="camera-quality-note"
            >
              <option value="jpeg">Standard · JPEG, up to 640 px</option>
              <option value="webrtc">480 × 640 · WebRTC</option>
              <option value="webrtc-hd">1080 × 1920 · WebRTC</option>
              <option value="png">Original pixels · lossless PNG</option>
            </select>
            <p id="camera-quality-note">
              For stereo, keep both phones upright and choose the same resolution and rear lens.
            </p>
            <Button
              variant="primary"
              type="submit"
              id="connect"
              disabled={connecting}
            >
              Connect camera
            </Button>
          </form>
          <p id="phone-status" role="status">
            {camera.phase !== "connected" ? camera.message : ""}
          </p>
        </div>
      </main>
      <video
        ref={video}
        className="phone-preview"
        id="local-camera"
        tabIndex={-1}
        autoPlay
        muted
        playsInline
        aria-label="Camera paired. Your camera preview is active."
        hidden={!connected}
      />
      <Button
        id="stop-camera"
        className="phone-stop"
        hidden={!connected}
        onClick={() => active.current?.pause()}
      >
        Stop camera
      </Button>
      <p id="lens-status" role="status" hidden={!connected}>
        {camera.phase === "connected" ? camera.lens : ""}
      </p>
    </div>
  );
}
