# Orion voice architecture

Start with [`workflow/runOrionVoiceWorkflow.ts`](./workflow/runOrionVoiceWorkflow.ts). Its exported
`runOrionVoiceWorkflow` function is the complete product flow in four stages:

1. Receive and prepare the finalized, displayed transcript.
2. Run the Gemini and tool-calling turn.
3. Commit the completed spoken and screen response.
4. Present the final screen response and complete spoken playback.

The details behind those stages are intentionally separated:

```text
input/       microphone PCM, silence checks, and compact WAV encoding for Gemini STT
workflow/    master flow, Gemini/tool loop, conversation memory
tools/       safe Orion-tab and orb tool execution
output/      streamed speech playback and waveform data
control/     microphone state and hand/voice authority
session/     Turnstile-backed browser session setup
api/         stable provider error mapping
```

`orionVoiceController.ts` wires those modules to the DOM and keyboard controls. Shared contracts live
in `types.ts`. Unit tests mirror this structure under `tests/unit/voice`; browser tests remain under
`tests/e2e`.

Gemini's final response has two independent surfaces: `spokenText` is concise and optimized for TTS,
while `screenText` is sanitized Markdown for the answer rail. The Worker separates both streams in
`workflow/dualSurfaceEnvelope.ts`; `workflow/geminiTurnClient.ts` delivers them without making audio
wait for the detailed screen response.

Main microphone turns are transcribed first by Gemini 3.1 Flash-Lite. The finalized transcript is
shown in Orion and then enters the four-stage master workflow above. Deepgram remains only for Orion's
speech output and the isolated `/stt-compare` lab.
