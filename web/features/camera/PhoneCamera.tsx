"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "../../components/Button";
import { createAccessibility } from "../../shared/accessibility";
import { createScope } from "../../shared/scope";
import { createCameraUpload } from "./camera-upload";

type CameraState =
  | { phase: "idle"; message?: string; invalid?: boolean }
  | { phase: "connecting"; message: string }
  | { phase: "connected"; lens: string };

export function PhoneCamera() {
  const [camera, setCamera] = useState<CameraState>({ phase: "idle" });
  const root = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const codeField = useRef<HTMLInputElement>(null);
  const active = useRef<ReturnType<typeof createCameraUpload> | null>(null);
  const wasConnected = useRef(false);
  const connected = camera.phase === "connected";
  const connecting = camera.phase === "connecting";
  const invalid = camera.phase === "idle" && Boolean(camera.invalid);

  useEffect(() => {
    if (!video.current || !root.current) return;
    const scope = createScope();
    createAccessibility(root.current, scope);
    let mounted = true;
    const upload = createCameraUpload(video.current, (state: CameraState) => {
      if (mounted) setCamera(state);
    });
    active.current = upload;
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
    if (connected) video.current?.focus();
    else if (invalid || wasConnected.current) codeField.current?.focus();
    wasConnected.current = connected;
  }, [connected, invalid]);

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
          <h1>Enter pairing code</h1>
          <p>Use the six-digit code shown on the computer.</p>
          <form
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
            <label htmlFor="camera-quality">Upload quality</label>
            <select
              id="camera-quality"
              name="quality"
              defaultValue="jpeg"
              aria-describedby="camera-quality-note"
            >
              <option value="jpeg">Standard · JPEG, up to 640 px</option>
              <option value="png">Original pixels · lossless PNG</option>
            </select>
            <p id="camera-quality-note">
              For stereo, choose the same mode on both phones and calibrate at
              that size.
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
      <p id="lens-status" role="status" hidden={!connected}>
        {camera.phase === "connected" ? camera.lens : ""}
      </p>
    </div>
  );
}
