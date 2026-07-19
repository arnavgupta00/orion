export type ControlAuthority = 'ambient' | 'voice' | 'hand';

export type MicState =
  | 'idle'
  | 'hold'
  | 'latched'
  | 'finalizing'
  | 'thinking'
  | 'speaking'
  | 'error';

export type OrbCommand =
  | { kind: 'field'; state: 'open' | 'collapsed' }
  | { kind: 'burst'; strength: number }
  | { kind: 'zoom'; factor: number }
  | { kind: 'rotate'; yaw: number; pitch: number; roll: number; durationMs: number }
  | { kind: 'spin'; axis: 'x' | 'y' | 'z'; speed: number }
  | { kind: 'stop-motion' }
  | { kind: 'core'; size?: number; brightness?: number; energy?: number }
  | { kind: 'appearance'; target: OrbAppearanceTarget; color: string }
  | { kind: 'reset' };

export type OrbAppearanceTarget = 'shell' | 'light-source' | 'field' | 'all';

export interface OrbAppearanceState {
  shell: string | null;
  lightSource: string | null;
  field: string | null;
}

export type ConversationTurn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; spokenText: string; screenText: string };

export interface OrbRuntimeState {
  mode: string;
  fieldOpen: boolean;
  zoomLog: number;
  sourceSize: number;
  brightness: number;
  energy: number;
  appearance: OrbAppearanceState;
}

export interface ClientState {
  authority: ControlAuthority;
  orb: OrbRuntimeState;
  microphone: MicState;
  fullscreen: boolean;
  visiblePanel?: string;
  screen?: {
    visible: boolean;
    text: string;
  };
}

export type ClientToolName =
  | 'orb_set_field'
  | 'orb_transform'
  | 'orb_set_motion'
  | 'orb_set_core'
  | 'orb_set_appearance'
  | 'orb_effect'
  | 'run_page_javascript'
  | 'open_url'
  | 'show_content'
  | 'modify_orion_ui'
  | 'toggle_fullscreen'
  | 'copy_text'
  | 'inspect_orion_state';

export interface ClientToolResult {
  callId: string;
  tool: string;
  status: 'completed' | 'failed' | 'popup_blocked' | 'rejected';
  result?: unknown;
  error?: string;
}

export interface PageScriptResult {
  status: 'completed' | 'failed' | 'popup_blocked';
  value?: unknown;
  logs: string[];
  error?: string;
  durationMs: number;
  openedUrls: string[];
}

export interface SourceLink {
  title: string;
  url: string;
}

export type ProviderErrorCode =
  | 'quota_exhausted'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_credentials'
  | 'session_expired'
  | 'invalid_request';

export type VoiceTurnEvent =
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'tool-start'; callId: string; tool: string; label: string }
  | { type: 'tool-complete'; callId: string; summary: string }
  | { type: 'tool-failed'; callId: string; message: string }
  | { type: 'client-tool-call'; callId: string; tool: ClientToolName; args: Record<string, unknown>; continuation: string }
  | { type: 'progress-speech'; text: string }
  | { type: 'scene-command'; command: OrbCommand; callId: string; label?: string }
  | { type: 'speech-delta'; text: string }
  | { type: 'screen-delta'; text: string }
  | { type: 'sources'; sources: SourceLink[] }
  | { type: 'done' }
  | { type: 'error'; code: ProviderErrorCode; message: string };

export interface StartRespondRequest {
  kind?: 'start';
  transcript: string;
  history: ConversationTurn[];
  clientState: ClientState;
}

export interface ContinueRespondRequest {
  kind: 'continue';
  continuation: string;
  toolResults: ClientToolResult[];
  clientState: ClientState;
}

export type RespondRequest = StartRespondRequest | ContinueRespondRequest;

export interface SessionResponse {
  ok: true;
  expiresAt: number | null;
  turnLimit: number | null;
  owner?: boolean;
  openAccess?: boolean;
  openAccessUntil?: number;
}
