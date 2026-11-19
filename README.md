# Visual Obstacle Avoidance

> **Status:** This branch runs the desktop Dashboard, paired JPEG camera preview and local LLM Agent. Live YOLO results come from a separate CV process using the adapter documented below.

## Overview

Visual Obstacle Avoidance is an experimental AI visual assistance system for people with visual impairments. The proposed demo uses two smartphones as cameras, streams video to a local computer, detects common objects and potential obstacles using YOLO, and connects an LLM agent to voice interaction and personalized memory.

**Goal:** Demonstrate a working, controlled-environment prototype for real-time perception, spoken assistance, and memory of user-registered belongings.

## Planned System Architecture

```text
Smartphone A + Smartphone B
        | Browser camera (getUserMedia) + WebRTC
        v
   Local computer / backend
        |
        +--> YOLO / CV --> object detections + basic obstacle alerts
        |                       |
        |                       +--> Web dashboard
        |                       +--> LLM agent + personal-item memory
        |                                        |
        +----------------------------------> STT / TTS voice feedback
```

All components above describe the **planned architecture**, not completed functionality. Low-latency obstacle warnings should follow defined CV rules rather than waiting for an LLM response.

## Teams and Branches

| Team | Branch | Folder | Main responsibilities |
| --- | --- | --- | --- |
| Web UI | [`web-ui`](../../tree/web-ui) | [`web/`](./web) | Smartphone camera pages, WebRTC streaming, two-camera dashboard, API integration |
| Computer Vision | [`cv`](../../tree/cv) | [`cv/`](./cv) | YOLO inference, tracking, detection JSON, basic obstacle warnings, performance tests |
| LLM Agent | [`llm-agent`](../../tree/llm-agent) | [`llm/`](./llm) | Voice interaction, scene questions, personal-item registration, SQLite memory |
| Research & Presentation | [`presentation`](../../tree/presentation) | [`presentation/`](../../tree/presentation/presentation) | User research, diagrams, presentation, demo script, testing evidence |

Research spreadsheets for the presentation team are kept **only on the `presentation` branch** under `presentation/`; they are intentionally not part of `main` or the development branches.

## MVP Priorities

**P0 — End-to-end demonstration:** One phone streaming video, real-time YOLO detections, a dashboard displaying results, and basic voice questions answered from current detection data.

**P1 — Core features:** Basic obstacle alerts, user-registered item matching, persistent personal-item memory, and voice queries about saved items.

**P2 — Stretch goals:** Two concurrent cameras, optional depth estimation, advanced memory controls, and additional response personalization.

## Development Phases (Proposed)

1. **Days 1–3: Setup.** Build basic UI, run a YOLO model on test input, start agent/STT/TTS experiments, and agree on interfaces.
2. **Days 4–7: Integration.** Stream one camera, process video, return detections, and answer a visual question aloud.
3. **Days 8–11: Core AI.** Add tracking and obstacle-warning rules; register personal objects and save/retrieve memory.
4. **Days 12–15: Dual camera and optimization.** Add a second camera and evaluate latency, FPS, reliability, and error handling.
5. **Days 16–18: Testing and presentation.** Rehearse a controlled demo, document measured performance, limitations, and a backup video.

These time ranges are planning estimates, not confirmed event deadlines.

## Proposed Interfaces (Not Yet Implemented)

| Interface | Purpose |
| --- | --- |
| `POST /webrtc/offer` | WebRTC signaling |
| `WS /ws/detections` | Stream CV detections |
| `WS /ws/alerts` | Stream obstacle-alert events |
| `POST /agent/chat` | Agent questions and responses |
| `GET /memory/items` | List registered belongings |
| `POST /memory/items` | Register a personal item |

Each detection event should contain a camera ID, timestamp, object label, confidence, bounding box, optional track ID, and warning level. The teams should confirm these interfaces before writing integration code.

## Collaboration Workflow

1. Work on your assigned branch: `web-ui`, `cv`, `llm-agent`, or `presentation`.
2. Keep implementation within the team's folder where practical. Coordinate shared API/backend changes in advance.
3. Commit small, descriptive changes and push to your team branch.
4. Open a pull request for code intended for `main`; have another team member review and test it before merging.
5. **Do not merge presentation-only research spreadsheets into `main`.** Keep them on the presentation branch when preparing cross-team changes.
6. Avoid force-pushing shared branches. Update from `main` carefully and resolve conflicts before pushing.

## Running the Project

See [Web setup](web/README.md) for the Dashboard and phone pairing, and [Agent setup and CV adapter](llm/README.md) for local models, the memory demo and the same-frame CV contract. The Dashboard uses the current JPEG transport. The WebRTC routes above are the team's planned transport.

## Safety and Privacy

This is a research/hackathon demonstration **not a validated mobility aid**. YOLO detections alone do not provide reliable physical distance or guarantee a safe path. Test warnings only in a controlled environment; do not rely on them for real-world navigation. Obtain consent before recording or saving video, voice, or personal-item information, and do not commit secrets or private user data.
