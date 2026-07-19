# Orion

[![Live](https://img.shields.io/badge/live-orion.arnav.network-8d73ff)](https://orion.arnav.network)
[![CI](https://github.com/arnavgupta00/orion/actions/workflows/ci.yml/badge.svg)](https://github.com/arnavgupta00/orion/actions/workflows/ci.yml)
[![Cloudflare Workers](https://img.shields.io/badge/runtime-Cloudflare_Workers-f38020)](https://workers.cloudflare.com/)

Orion is a browser-native spatial voice agent. It combines local two-hand tracking, a procedural Three.js energy field, Gemini reasoning and transcription, Deepgram speech, grounded web answers, and transparent multi-tool execution in one public demo.

**[Launch Orion](https://orion.arnav.network)** — use desktop Chrome, allow the microphone, hold `Space`, speak, then release.

## Why this project exists

Orion is a compact demonstration of the engineering behind a serious voice interface rather than a chatbot placed beside an animation:

- a latency-aware audio pipeline with capture, sealed transcription, agent reasoning, streamed dual-surface output, and interruptible TTS;
- local MediaPipe hand tracking with calibrated gesture state machines and hand-over-voice control arbitration;
- a bounded Gemini tool loop for evidence lookup, grounded search, URL inspection, orb control, and actions inside Orion's own tab;
- a stateless Cloudflare Worker that protects provider credentials, validates sessions, streams events, and serves the SPA;
- observable execution through an action trace, explicit provider errors, citations, and deterministic tests.

The most useful code-reading entry point is [`src/voice/workflow/runOrionVoiceWorkflow.ts`](src/voice/workflow/runOrionVoiceWorkflow.ts). It keeps the core path deliberately small:

```text
Receive transcript
→ Generate Gemini turn
→ Commit speech + screen channels
→ Render the screen response and play speech
```

See [`docs/architecture.md`](docs/architecture.md) for system boundaries and [`src/voice/README.md`](src/voice/README.md) for the voice module map.

## Interaction model

### Voice

- Hold `Space` to talk; release to finalize the captured audio.
- Double-tap `Space` to latch listening; press it again to finish.
- Press `Space` while Orion speaks to interrupt and immediately start a new turn.
- Press `X` or `Escape` to stop speech and the active tool chain.

Gemini produces two independent answer surfaces. `spokenText` is concise and optimized for TTS; `screenText` is richer Markdown with evidence, links, code, and citation chips. Speech can begin before the detailed display response has finished streaming.

### Hands

- One stable hand wakes the field and reveals a reticle.
- Pinch inside the orb and drag to rotate.
- Pinch with both hands to travel through the field and control roll.
- Charge and palm-spread gestures unfold, disperse, and collapse the scene.

Hand tracking is performed locally with MediaPipe. One visible stable hand immediately takes authority; incompatible voice scene commands are rejected rather than queued.

### Tools

Orion can retrieve verified career evidence, search current sources, inspect public URLs, transform the orb, show structured content, modify approved UI state, copy text, toggle fullscreen, inspect its runtime state, run bounded JavaScript in its own page, and prepare HTTP/HTTPS links in a new tab. It cannot control existing tabs or the operating system.

## Architecture

```text
Camera → local MediaPipe ─────────────────────────────┐
                                                     ├→ InputArbiter → Three.js scene
Microphone → WAV → Gemini transcription → transcript ┘
                                      │
                                      └→ Gemini agent/tool loop
                                           ├→ evidence / Search / URL Context
                                           ├→ orb and in-tab tools
                                           └→ spokenText → Deepgram TTS
                                               screenText → sanitized Markdown
```

The Worker has no database, Durable Object, remote browser, audio archive, transcript store, or server-side conversation store. Conversation history remains in browser memory and is cleared on refresh or session expiry.

## Local development

Requirements: Node.js 24+, pnpm, and desktop Chrome.

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm dev
```

For a local Turnstile site key, add an ignored `.env.local` file:

```bash
VITE_TURNSTILE_SITE_KEY=your_public_site_key
```

Localhost can create a development session without Turnstile. Camera access requires localhost or HTTPS.

## Provider and Cloudflare setup

Copy [`wrangler.example.jsonc`](wrangler.example.jsonc) to `wrangler.jsonc`, adjust account-specific bindings, and store all credentials as Wrangler secrets:

```bash
pnpm exec wrangler secret put GEMINI_API_KEY
pnpm exec wrangler secret put DEEPGRAM_API_KEY
pnpm exec wrangler secret put TURNSTILE_SECRET
pnpm exec wrangler secret put SESSION_SIGNING_KEY
```

Never place real provider keys in a committed Wrangler file. The public repository contains configuration shape only.

Public sessions normally last 15 minutes or 21 completed turns and have endpoint-specific rate limits. `ORION_OPEN_ACCESS_UNTIL` temporarily bypasses browser verification plus application-level session, turn, transcription, response, TTS, and token limits until an explicit UTC timestamp. Signed cookies, provider billing limits, and Cloudflare platform limits still apply; Turnstile resumes automatically after the window.

## Privacy and analytics

- Camera frames and hand landmarks stay in the browser.
- Audio is sent to Gemini only after a recording is finalized and is not persisted by Orion.
- Transcripts and conversation history are not stored by the application.
- Microsoft Clarity provides aggregate usage, heatmaps, and session diagnostics. Voice transcripts, agent answers, tool content, and owner inputs are explicitly masked from Clarity capture.

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Start Vite locally |
| `pnpm typecheck` | Check browser and Worker TypeScript projects |
| `pnpm test` | Run deterministic unit tests |
| `pnpm test:e2e` | Run Playwright interaction fixtures |
| `pnpm build` | Build the production SPA |
| `pnpm worker:check` | Validate a Worker deployment without publishing |
| `pnpm sync:career:check` | Verify the public career-evidence snapshot |
| `pnpm run deploy` | Build and deploy to Cloudflare Workers |

## Repository map

```text
src/
  scene/          Three.js field, geometry, particles, and post-processing
  tracking/       Camera, MediaPipe worker, calibration, and filtering
  core/           Gesture state, calibration, filtering, zoom, and hand association
  voice/
    control/      Hand/voice authority arbitration
    input/        Audio capture and transcription
    workflow/     Master workflow, Gemini stream, dual-surface parser
    output/       TTS playback and sanitized Markdown rendering
    tools/        Agent-visible browser and scene capabilities
  worker.ts       Cloudflare API boundary and Gemini tool loop
tests/
  unit/           Pure behavior tests
  e2e/            Browser fixtures and recovery flows
docs/             Architecture and security notes
```

## Accepted constraints

The model-generated page runner intentionally executes in Orion's main tab. Source and result sizes are bounded and failures are reported back to Gemini, but unrestricted main-thread JavaScript cannot be hard-isolated or interrupted if it enters a synchronous infinite loop. Reloading the page resets the session.

## License

[MIT](LICENSE) © 2026 Arnav Gupta.
