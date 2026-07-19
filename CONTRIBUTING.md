# Contributing

## Development workflow

1. Create a focused branch from `main`.
2. Keep provider credentials in `.dev.vars`, `.env.local`, or Wrangler secrets only.
3. Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before opening a pull request.
4. Add deterministic fixtures for gesture, voice-state, tool-loop, or parser behavior changes.
5. Describe user-visible latency, authority, privacy, and failure-mode changes in the pull request.

## Design constraints

- Keep the orb center unobstructed.
- Hand tracking and scene rendering stay local.
- Do not persist audio, transcripts, or conversation history.
- Hand authority always outranks voice authority.
- Every long-running tool operation must remain visible through the action trace.
- Do not add a backend service when the existing stateless Worker boundary is sufficient.

## Code organization

The master voice path belongs in `src/voice/workflow/runOrionVoiceWorkflow.ts`. Provider transport, state machines, rendering, and tools should remain in their focused modules rather than growing the orchestrator.
