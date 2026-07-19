# Security policy

## Reporting

Please report security issues privately to Arnav Gupta through the contact link at [arnav.network](https://arnav.network). Do not open a public issue containing credentials, session material, or a working exploit.

## Security model

- Provider credentials stay in Cloudflare Worker secrets.
- Public API routes require signed, IP-bound HttpOnly sessions.
- Turnstile and endpoint-specific limits protect normal public access.
- Audio, transcripts, and conversation history are not persisted by Orion.
- Clarity-captured DOM regions containing voice or answer content are explicitly masked.

The in-tab JavaScript tool is an intentional exception to strong isolation. It can mutate or freeze the current Orion page, but it has no privileged operating-system bridge and does not control existing browser tabs.
