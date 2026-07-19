import { ARNAV_PROFILE_CONTEXT, searchArnavEvidence } from './knowledge/arnavKnowledge';
import {
  createGeminiLiveSetup,
  GEMINI_BATCH_MODELS,
  GEMINI_LIVE_MODELS,
  geminiLiveSetupFieldMask,
  isGeminiLiveModel,
  type GeminiBatchModel,
  type GeminiLiveModel,
} from './stt-compare/geminiModels';
import { ORION_ORB_APPLICATION_CONTEXT } from './voice/intelligence/orbApplicationContext';
import { buildGeminiTranscriptionPrompt } from './voice/input/transcriptionVocabulary';
import {
  isOpenAccessActive,
  publicSessionExpiry,
} from './voice/session/openAccess';
import {
  DualSurfaceEnvelopeParser,
  formatAssistantHistory,
} from './voice/workflow/dualSurfaceEnvelope';
import type {
  ClientState,
  ClientToolName,
  ClientToolResult,
  ContinueRespondRequest,
  ProviderErrorCode,
  RespondRequest,
  SourceLink,
  StartRespondRequest,
  VoiceTurnEvent,
} from './voice/types';

const SESSION_COOKIE = '__Host-orion_session';
const LOCAL_SESSION_COOKIE = 'orion_session';
const SESSION_MS = 15 * 60 * 1_000;
const OWNER_SESSION_MS = 365 * 24 * 60 * 60 * 1_000;
const MAX_TURNS = 21;
const MAX_TRANSCRIPT = 2_000;
const MAX_HISTORY_MESSAGES = 42;
const MAX_HISTORY_CHARACTERS = 84_000;
const MAX_TOOL_ROUNDS = 6;
const MAX_TOOL_CALLS = 8;
const CONTINUATION_MS = 90_000;
const MAX_STT_AUDIO_BYTES = 6_000_000;
const APP_SHELL_RELEASE = 'dual-surface-response-v1';

interface SessionPayload {
  sid: string;
  iat: number;
  exp: number;
  turns: number;
  ip: string;
  owner?: boolean;
}

interface GeminiFunctionCall {
  name?: string;
  args?: Record<string, unknown>;
}

interface GeminiPart extends Record<string, unknown> {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface GeminiStreamResult {
  content: GeminiContent;
  functionCalls: GeminiFunctionCall[];
  sources: SourceLink[];
  emittedText: boolean;
}

interface PendingToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
}

interface ContinuationPayload {
  version: 1;
  sid: string;
  turnId: string;
  expiresAt: number;
  round: number;
  toolCalls: number;
  contents: GeminiContent[];
  pending: PendingToolCall[];
}

class ProviderHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return serveAppAsset(request, env, url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
    try {
      switch (url.pathname) {
        case '/api/session': return await createSession(request, env, ctx);
        case '/api/deepgram-token': return await issueDeepgramToken(request, env);
        case '/api/gemini-live-token': return await issueGeminiLiveTokens(request, env);
        case '/api/stt/gemini': return await transcribeGeminiAudio(request, env);
        case '/api/respond': return await respond(request, env);
        case '/api/speech': return await speech(request, env);
        case '/api/health': return json({ ok: true });
        default: return apiError('invalid_request', 'Unknown Orion API route.', 404);
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'api_failure', route: url.pathname, error: safeError(error) }));
      return apiError('unavailable', 'Orion could not complete that request.', 503);
    }
  },
} satisfies ExportedHandler<Env>;

async function serveAppAsset(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname !== '/') return env.ASSETS.fetch(request);
  const releaseUrl = new URL(url);
  releaseUrl.searchParams.set('__orion_release', APP_SHELL_RELEASE);
  const response = await env.ASSETS.fetch(new Request(releaseUrl, request));
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function createSession(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();
  const body = await readJson<{ turnstileToken?: string; ownerToken?: string }>(request, 4_000);
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const host = new URL(request.url).hostname;
  const local = host === 'localhost' || host === '127.0.0.1';
  const secret = sessionSecret(request, env);
  if (!secret) return apiError('invalid_credentials', 'Session signing is not configured.', 503);
  const ipHash = await digest(`${ip}:${secret}`);
  const ownerToken = body.ownerToken?.trim() ?? '';
  const ownerAccess = ownerToken
    ? await verifyOwnerToken(ownerToken, env.ORION_OWNER_TOKEN_HASH)
    : false;
  const now = Date.now();
  const openAccess = !ownerAccess && isOpenAccessActive(env.ORION_OPEN_ACCESS_UNTIL, now);
  if (ownerToken && !ownerAccess) {
    return apiError('invalid_credentials', 'Owner access code was not recognized.', 403);
  }

  if (!local && !ownerAccess) {
    if (!body.turnstileToken) return apiError('invalid_request', 'Verification is required.', 400);
    const valid = await verifyTurnstile(body.turnstileToken, ip, env.TURNSTILE_SECRET);
    if (!valid) return apiError('invalid_request', 'Verification could not be completed.', 403);
    if (!openAccess) {
      const burst = await env.SESSION_RATE_LIMITER.limit({ key: ipHash });
      if (!burst.success || !(await allowHourlySession(ipHash, ctx))) {
        return apiError('rate_limited', 'Two new Orion sessions are available per hour. Add ?owner=1 to use an owner access code.', 429);
      }
    }
  }

  const payload: SessionPayload = {
    sid: crypto.randomUUID(),
    iat: now,
    exp: ownerAccess
      ? now + OWNER_SESSION_MS
      : publicSessionExpiry(env.ORION_OPEN_ACCESS_UNTIL, now, SESSION_MS),
    turns: 0,
    ip: ipHash,
    ...(ownerAccess ? { owner: true } : {}),
  };
  return json(
    {
      ok: true,
      expiresAt: ownerAccess ? null : payload.exp,
      turnLimit: ownerAccess || openAccess ? null : MAX_TURNS,
      ...(openAccess ? { openAccess: true, openAccessUntil: payload.exp } : {}),
      ...(ownerAccess ? { owner: true } : {}),
    },
    200,
    { 'Set-Cookie': await sessionCookie(payload, secret, !local) },
  );
}

async function verifyOwnerToken(token: string, expectedHash: string): Promise<boolean> {
  if (!expectedHash) return false;
  return constantTimeEqual(await digest(token), expectedHash);
}

async function issueDeepgramToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  if (isRestrictedSession(session, env)) {
    const rate = await env.TOKEN_RATE_LIMITER.limit({ key: session.sid });
    if (!rate.success) return apiError('rate_limited', 'A Deepgram voice connection is being started too frequently.', 429);
  }

  const response = await fetch('https://api.deepgram.com/v1/auth/grant', {
    method: 'POST',
    headers: {
      Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl_seconds: 30 }),
  });
  if (!response.ok) return mappedProviderError(response.status, 'Deepgram');
  const payload = await response.json<Record<string, unknown>>();
  const token = payload.access_token ?? payload.token;
  if (typeof token !== 'string') return apiError('unavailable', 'Deepgram returned an incomplete voice token.', 503);
  return json({
    token,
    expiresIn: 30,
    ttsModel: env.DEEPGRAM_TTS_MODEL || 'aura-2-orion-en',
  });
}

async function issueGeminiLiveTokens(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  if (isRestrictedSession(session, env)) {
    const rate = await env.TOKEN_RATE_LIMITER.limit({ key: `${session.sid}:gemini-live` });
    if (!rate.success) return apiError('rate_limited', 'Live transcription is being started too frequently.', 429);
  }

  const body = await readJson<{ models?: unknown[] }>(request, 2_000);
  const requested = Array.isArray(body.models)
    ? [...new Set(body.models.filter(isGeminiLiveModel))]
    : [...GEMINI_LIVE_MODELS];
  if (!requested.length || requested.length > GEMINI_LIVE_MODELS.length) {
    return apiError('invalid_request', 'No supported Gemini Live model was requested.', 400);
  }

  const now = Date.now();
  const expireTime = new Date(now + 5 * 60_000).toISOString();
  const newSessionExpireTime = new Date(now + 60_000).toISOString();
  let entries: Array<[GeminiLiveModel, string]>;
  try {
    entries = await Promise.all(requested.map(async (model): Promise<[GeminiLiveModel, string]> => {
      const setup = createGeminiLiveSetup(model, buildGeminiTranscriptionPrompt());
      const response = await fetch('https://generativelanguage.googleapis.com/v1alpha/auth_tokens', {
        method: 'POST',
        headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uses: 1,
          expireTime,
          newSessionExpireTime,
          bidiGenerateContentSetup: setup,
          fieldMask: geminiLiveSetupFieldMask(),
        }),
        signal: request.signal,
      });
      if (!response.ok) throw new ProviderHttpError(response.status, 'Gemini Live token provisioning failed.');
      const payload = await response.json<Record<string, unknown>>();
      if (typeof payload.name !== 'string') throw new Error('Gemini returned an incomplete Live token.');
      return [model, payload.name];
    }));
  } catch (error) {
    if (error instanceof ProviderHttpError) return mappedProviderError(error.status, 'Gemini');
    throw error;
  }

  return json({ tokens: Object.fromEntries(entries), expiresIn: 300, newSessionExpiresIn: 60 });
}

async function transcribeGeminiAudio(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const requestedModel = new URL(request.url).searchParams.get('model');
  const model: GeminiBatchModel = GEMINI_BATCH_MODELS.includes(requestedModel as GeminiBatchModel)
    ? requestedModel as GeminiBatchModel
    : 'gemini-3.1-flash-lite';
  if (isRestrictedSession(session, env)) {
    const rate = await env.RESPONSE_RATE_LIMITER.limit({ key: `${session.sid}:gemini-stt:${model}` });
    if (!rate.success) return apiError('rate_limited', 'Speech transcription is being started too frequently.', 429);
  }

  const contentType = request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'audio/wav' && contentType !== 'audio/x-wav') {
    return apiError('invalid_request', 'Voice transcription accepts WAV audio only.', 415);
  }
  const contentLength = Number(request.headers.get('Content-Length') ?? 0);
  if (contentLength > MAX_STT_AUDIO_BYTES) {
    return apiError('invalid_request', 'The voice recording is too long.', 413);
  }
  const audio = await request.arrayBuffer();
  if (audio.byteLength < 46) return apiError('invalid_request', 'The voice recording is empty.', 400);
  if (audio.byteLength > MAX_STT_AUDIO_BYTES) {
    return apiError('invalid_request', 'The voice recording is too long.', 413);
  }

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'audio/wav', data: arrayBufferToBase64(audio) } },
          { text: buildGeminiTranscriptionPrompt() },
        ],
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 1_000 },
    }),
    signal: request.signal,
  });
  if (!response.ok) return mappedProviderError(response.status, 'Gemini');
  const payload = await response.json<GeminiResponse>();
  const transcript = (payload.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? '')
    .join('')
    .trim()
    .replace(/^(["'])|(["'])$/g, '');
  if (!transcript) return apiError('unavailable', 'Gemini returned no transcription.', 503);
  const usage = payload.usageMetadata;
  return json({
    transcript,
    model,
    usage: {
      promptTokens: usage?.promptTokenCount ?? 0,
      outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      totalTokens: usage?.totalTokenCount ?? 0,
    },
  });
}

async function respond(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const secret = sessionSecret(request, env);
  if (!secret) return apiError('invalid_credentials', 'Session signing is not configured.', 503);
  const body = await readJson<RespondRequest>(request, 180_000);
  const clientState = sanitizeClientState(body.clientState);

  if (isContinuationRequest(body)) {
    const state = await verifyContinuation(body.continuation, secret);
    if (!state || state.sid !== session.sid || state.expiresAt < Date.now()) {
      return apiError('invalid_request', 'This Orion tool continuation is invalid or expired.', 400);
    }
    const toolResponses = resolveContinuationResults(state.pending, body.toolResults);
    if (!toolResponses) return apiError('invalid_request', 'Orion received incomplete or mismatched tool results.', 400);
    const contents = [...state.contents, functionResponseContent(toolResponses)];
    return agentEventStream({
      env,
      session,
      secret,
      signal: request.signal,
      clientState,
      contents,
      turnId: state.turnId,
      round: state.round + 1,
      toolCalls: state.toolCalls,
    });
  }

  if (isRestrictedSession(session, env) && session.turns >= MAX_TURNS) return apiError('session_expired', 'This Orion session has reached its 21-turn limit.', 401);
  if (isRestrictedSession(session, env)) {
    const rate = await env.RESPONSE_RATE_LIMITER.limit({ key: session.sid });
    if (!rate.success) return apiError('rate_limited', 'Please wait a moment before asking Orion again.', 429);
  }

  const transcript = typeof body.transcript === 'string' ? body.transcript.trim() : '';
  if (!transcript || transcript.length > MAX_TRANSCRIPT) return apiError('invalid_request', 'Transcript is empty or too long.', 400);
  const history = sanitizeHistory(body.history);
  const contents: GeminiContent[] = [
    ...history.map((turn): GeminiContent => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.role === 'assistant' ? formatAssistantHistory(turn) : turn.text }],
    })),
    { role: 'user', parts: [{ text: transcript }] },
  ];

  const nextSession = isRestrictedSession(session, env) ? { ...session, turns: session.turns + 1 } : session;
  const secure = !['localhost', '127.0.0.1'].includes(new URL(request.url).hostname);
  const cookie = await sessionCookie(nextSession, secret, secure);
  return agentEventStream({
    env,
    session: nextSession,
    secret,
    signal: request.signal,
    clientState,
    contents,
    turnId: crypto.randomUUID(),
    round: 0,
    toolCalls: 0,
    responseHeaders: { 'Set-Cookie': cookie },
  });
}

interface AgentStreamOptions {
  env: Env;
  session: SessionPayload;
  secret: string;
  signal: AbortSignal;
  clientState: ClientState;
  contents: GeminiContent[];
  turnId: string;
  round: number;
  toolCalls: number;
  responseHeaders?: HeadersInit;
}

function agentEventStream(options: AgentStreamOptions): Response {
  return eventStream(async (emit) => {
    let contents = options.contents;
    let round = options.round;
    let toolCalls = options.toolCalls;

    while (round < MAX_TOOL_ROUNDS) {
      const response = await openGeminiForSession(options.env, {
        systemInstruction: { parts: [{ text: buildSystemPrompt(options.clientState) }] },
        contents,
        tools: [{ functionDeclarations: functionDeclarations() }],
        generationConfig: { temperature: 0.5, maxOutputTokens: 1_600 },
      }, options.signal, options.session.owner === true);
      if (!response.ok) {
        console.warn(JSON.stringify({ event: 'gemini_agent_call_failed', status: response.status, round }));
        emit(providerErrorEvent(response.status, 'Gemini'));
        return;
      }

      const model = await relayGeminiStream(response, emit);
      contents = [...contents, model.content];
      if (model.sources.length) emit({ type: 'sources', sources: model.sources });
      if (!model.functionCalls.length) {
        if (!model.emittedText) emit({ type: 'error', code: 'unavailable', message: 'Orion returned no answer.' });
        else emit({ type: 'done' });
        return;
      }

      toolCalls += model.functionCalls.length;
      if (toolCalls > MAX_TOOL_CALLS) {
        emit({ type: 'error', code: 'invalid_request', message: 'Orion stopped an unusually long tool chain.' });
        return;
      }

      const pending: PendingToolCall[] = model.functionCalls.map((call) => ({
        callId: crypto.randomUUID(),
        name: String(call.name ?? ''),
        args: isRecord(call.args) ? call.args : {},
      }));
      let hasClientTools = false;

      for (const call of pending) {
        const presentation = toolPresentation(call.name, call.args);
        emit({ type: 'tool-start', callId: call.callId, tool: call.name, label: presentation.label });
        emit({ type: 'progress-speech', text: presentation.speech });
        if (isClientTool(call.name)) {
          hasClientTools = true;
          continue;
        }
        try {
          const executed = await executeServerTool(call.name, call.args, options.env, options.signal);
          call.result = { status: 'completed', result: executed.result };
          if (executed.sources.length) emit({ type: 'sources', sources: executed.sources });
          emit({ type: 'tool-complete', callId: call.callId, summary: executed.summary });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'The tool could not complete.';
          call.result = { status: 'failed', error: message };
          emit({ type: 'tool-failed', callId: call.callId, message });
        }
      }

      if (hasClientTools) {
        const continuation = await signContinuation({
          version: 1,
          sid: options.session.sid,
          turnId: options.turnId,
          expiresAt: Date.now() + CONTINUATION_MS,
          round,
          toolCalls,
          contents,
          pending,
        }, options.secret);
        for (const call of pending) {
          if (!isClientTool(call.name)) continue;
          emit({
            type: 'client-tool-call',
            callId: call.callId,
            tool: call.name,
            args: call.args,
            continuation,
          });
        }
        return;
      }

      contents = [...contents, functionResponseContent(pending.map((call) => ({
        callId: call.callId,
        name: call.name,
        response: call.result ?? { status: 'failed', error: 'Missing tool result.' },
      })))];
      round += 1;
    }

    emit({ type: 'error', code: 'invalid_request', message: 'Orion stopped after six tool rounds.' });
  }, options.responseHeaders);
}

async function speech(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  if (isRestrictedSession(session, env)) {
    const rate = await env.SPEECH_RATE_LIMITER.limit({ key: session.sid });
    if (!rate.success) return apiError('rate_limited', 'Speech playback is being requested too frequently.', 429);
  }
  const body = await readJson<{ text?: string }>(request, 8_000);
  const text = body.text?.trim() ?? '';
  if (!text || text.length > 650) return apiError('invalid_request', 'Speech text is empty or too long.', 400);

  const model = env.DEEPGRAM_TTS_MODEL || 'aura-2-orion-en';
  const response = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=mp3`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({ text }),
    signal: request.signal,
  });
  if (!response.ok) return mappedProviderError(response.status, 'Deepgram');
  return new Response(response.body, {
    headers: {
      'Content-Type': response.headers.get('Content-Type') ?? 'audio/mpeg',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function openGeminiForSession(
  env: Env,
  payload: Record<string, unknown>,
  signal: AbortSignal,
  _owner: boolean,
): Promise<Response> {
  return openGeminiStream(env, payload, signal, 'gemini-3.1-flash-lite');
}

async function openGeminiStream(
  env: Env,
  payload: Record<string, unknown>,
  signal: AbortSignal,
  model: string,
): Promise<Response> {
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
}

async function relayGeminiStream(
  response: Response,
  emit: (event: VoiceTurnEvent) => void,
): Promise<GeminiStreamResult> {
  const reader = response.body?.getReader();
  if (!reader) return { content: { role: 'model', parts: [] }, functionCalls: [], sources: [], emittedText: false };
  const decoder = new TextDecoder();
  let buffer = '';
  const parts: GeminiPart[] = [];
  const functionCalls: GeminiFunctionCall[] = [];
  const chunks: Array<{ web?: { uri?: string; title?: string } }> = [];
  const envelope = new DualSurfaceEnvelopeParser({
    onSpeechDelta: (text) => emit({ type: 'speech-delta', text }),
    onScreenDelta: (text) => emit({ type: 'screen-delta', text }),
  });

  const consumeRecord = (record: string): void => {
    for (const line of record.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      const payload = JSON.parse(data) as GeminiResponse;
      const candidate = payload.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.text) {
          envelope.push(part.text);
          const previous = parts.at(-1);
          if (previous?.text !== undefined && Object.keys(part).length === 1) previous.text += part.text;
          else parts.push({ ...part });
          continue;
        }
        parts.push({ ...part });
        if (part.functionCall) functionCalls.push(part.functionCall);
      }
      chunks.push(...(candidate?.groundingMetadata?.groundingChunks ?? []));
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const records = buffer.split('\n\n');
    buffer = records.pop() ?? '';
    records.forEach(consumeRecord);
    if (done) break;
  }
  if (buffer.trim()) consumeRecord(buffer);
  const dualSurface = envelope.finish(functionCalls.length === 0);
  return {
    content: { role: 'model', parts },
    functionCalls,
    sources: uniqueSources(chunks),
    emittedText: Boolean(dualSurface.spokenText || dualSurface.screenText),
  };
}

function functionDeclarations(): Array<Record<string, unknown>> {
  return [
    {
      name: 'arnav_evidence',
      description: 'Retrieve exact evidence about Arnav Gupta: projects, roles, metrics, confidence, caveats, and public profile links. Use before making detailed career claims.',
      parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' }, maxSections: { type: 'INTEGER', minimum: 1, maximum: 6 } }, required: ['query'] },
    },
    {
      name: 'search_web',
      description: 'Research current or changing information with Google Search grounding. Put a standalone resolved search query in query.',
      parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] },
    },
    {
      name: 'read_url',
      description: 'Read and analyze one or more specific public HTTP/HTTPS URLs using Gemini URL Context.',
      parameters: {
        type: 'OBJECT',
        properties: {
          urls: { type: 'ARRAY', items: { type: 'STRING' }, minItems: 1, maxItems: 5 },
          question: { type: 'STRING' },
        },
        required: ['urls', 'question'],
      },
    },
    {
      name: 'orb_set_field',
      description: 'Open or collapse Orion’s surrounding lattice field.',
      parameters: { type: 'OBJECT', properties: { state: { type: 'STRING', enum: ['open', 'collapsed'] } }, required: ['state'] },
    },
    {
      name: 'orb_transform',
      description: 'Zoom or rotate the orb. Angles are degrees. Use factors above 1 to zoom in and below 1 to zoom out.',
      parameters: {
        type: 'OBJECT',
        properties: {
          zoomFactor: { type: 'NUMBER', minimum: 0.001 },
          yaw: { type: 'NUMBER' }, pitch: { type: 'NUMBER' }, roll: { type: 'NUMBER' },
          durationMs: { type: 'INTEGER', minimum: 100, maximum: 8000 },
        },
      },
    },
    {
      name: 'orb_set_motion',
      description: 'Start a continuous orb spin or stop all voice-driven motion.',
      parameters: { type: 'OBJECT', properties: { action: { type: 'STRING', enum: ['spin', 'stop'] }, axis: { type: 'STRING', enum: ['x', 'y', 'z'] }, speed: { type: 'NUMBER', minimum: -3, maximum: 3 } }, required: ['action'] },
    },
    {
      name: 'orb_set_core',
      description: 'Control the compact orb’s inner light system. size changes only the inner sun/light-source radius, brightness changes emission and bloom, and energy changes pulse/activity. It does not zoom or recolor the orb.',
      parameters: { type: 'OBJECT', properties: { size: { type: 'NUMBER', description: 'Inner light-source size only. Baseline 0.77.', minimum: 0.08, maximum: 25 }, brightness: { type: 'NUMBER', description: 'Emission/bloom multiplier. Baseline 1.50.', minimum: 0.1, maximum: 4 }, energy: { type: 'NUMBER', description: 'Pulse and surface activity. Baseline 0.', minimum: 0, maximum: 1.5 } } },
    },
    {
      name: 'orb_set_appearance',
      description: 'Set the color of an actual Three.js orb layer. Use shell for the compact triangular surface/aura/sparks, light-source for the inner sun, field for the dispersed lattice/skeleton/depth tunnel, or all for the complete visual. Never use UI tools for orb color.',
      parameters: {
        type: 'OBJECT',
        properties: {
          target: { type: 'STRING', enum: ['shell', 'light-source', 'field', 'all'] },
          color: { type: 'STRING', description: 'Six-digit hexadecimal color such as #35D9FF.' },
        },
        required: ['target', 'color'],
      },
    },
    {
      name: 'orb_effect',
      description: 'Trigger an orb effect. Reset restores the saved visual checkpoint.',
      parameters: { type: 'OBJECT', properties: { effect: { type: 'STRING', enum: ['charge', 'burst', 'unfold', 'collapse', 'reset'] }, strength: { type: 'NUMBER', minimum: 0, maximum: 2.5 } }, required: ['effect'] },
    },
    {
      name: 'run_page_javascript',
      description: 'Execute JavaScript inside Orion’s current browser tab. The script may use window/document or the provided orion API. Supply a complete async function body and return a useful result.',
      parameters: { type: 'OBJECT', properties: { source: { type: 'STRING' }, reason: { type: 'STRING' } }, required: ['source', 'reason'] },
    },
    {
      name: 'open_url',
      description: 'Open a public HTTP/HTTPS link in a new browser tab. Use this rather than navigating the Orion tab away.',
      parameters: { type: 'OBJECT', properties: { url: { type: 'STRING' } }, required: ['url'] },
    },
    {
      name: 'show_content',
      description: 'Show a restrained card in Orion with text, code, or a link.',
      parameters: { type: 'OBJECT', properties: { title: { type: 'STRING' }, text: { type: 'STRING' }, format: { type: 'STRING', enum: ['text', 'code'] }, url: { type: 'STRING' }, actionLabel: { type: 'STRING' } } },
    },
    {
      name: 'modify_orion_ui',
      description: 'Modify Orion interface state: show/hide answer or guide panels, set CSS variables, or focus an element.',
      parameters: {
        type: 'OBJECT',
        properties: {
          panel: { type: 'STRING', enum: ['answer', 'guide'] },
          visible: { type: 'BOOLEAN' },
          variables: {
            type: 'ARRAY',
            items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, value: { type: 'STRING' } }, required: ['name', 'value'] },
          },
          focusId: { type: 'STRING' },
        },
      },
    },
    {
      name: 'toggle_fullscreen',
      description: 'Enter, exit, or toggle fullscreen. Browser permission may require a direct click.',
      parameters: { type: 'OBJECT', properties: { state: { type: 'STRING', enum: ['enter', 'exit', 'toggle'] } } },
    },
    {
      name: 'copy_text',
      description: 'Copy text to the visitor clipboard. Browser permission may require a direct click.',
      parameters: { type: 'OBJECT', properties: { text: { type: 'STRING' } }, required: ['text'] },
    },
    {
      name: 'inspect_orion_state',
      description: 'Read the current control authority, orb transform state, microphone state, fullscreen state, and visible panel before deciding an action.',
      parameters: { type: 'OBJECT', properties: {} },
    },
  ];
}

function buildSystemPrompt(clientState: ClientState): string {
  return `You are Orion, the conversational intelligence inside Arnav Gupta's spatial orb experience.

IDENTITY AND HONESTY
- You are a polished public demonstration of a capable, budget-conscious voice agent: local hand tracking, streaming speech, Gemini reasoning, grounded web knowledge, multi-step tools, and direct control of this Orion tab.
- You can act only through the declared tools. Page JavaScript runs in Orion's current tab; it does not control other existing tabs, the visitor's operating system, or their local files.
- Never invent an action, tool result, source, memory, or capability. If a tool fails or hand authority rejects an orb action, say so plainly.
- Conversation memory exists only in this page session.

CONVERSATIONAL STYLE
- Sound intelligent, composed, candid, and naturally witty. One precise dry line is enough; never force swagger, flattery, sci-fi roleplay, or call the visitor “Commander.”
- Answer directly, maintain the thread across follow-ups, correct false premises cleanly, and have a reasoned point of view when judgment is requested.
- Ask one short clarification only when it would materially change the result. Otherwise make the smallest reasonable assumption.
- Avoid generic openings, repetitive self-description, bloated lists, and narration of internal reasoning.

VOICE AND DISPLAY
- Treat speech and Orion's answer panel as two distinct communication surfaces. Every final answer must use the exact envelope below, with speech first:
<<<ORION_SPEECH>>>
Concise text written to be spoken aloud.
<<<ORION_SCREEN>>>
Useful screen text in restrained Markdown.
<<<ORION_END>>>
- Never place these marker strings inside either response body, and never wrap the envelope in a code block.
- The speech section must be self-contained, conversational, free of Markdown, raw URLs, code, and citation narration. Keep it to one to three sentences and no more than roughly 520 characters.
- The screen section is always required. For simple answers it may closely match speech; for substantial answers it should carry the useful detail, evidence, headings, bullets, links, code, and source-aware caveats that would sound clumsy aloud.
- Mention the screen naturally only when it contains meaningful extra detail, for example “I’ve put the evidence and project breakdown on screen.” Do not use that line as repetitive boilerplate.
- For a purely visual orb command, leave the speech section empty and put a terse acknowledgement in the screen section.
- Call tools before producing the envelope. When calling tools, emit function calls only; do not combine a final envelope with tool calls in the same model response.
- The interface already displays and, when work is slow, speaks concise progress. Do not emit filler before calling tools.

TOOL POLICY
- All spoken visual requests must use the granular orb tools. Never merely describe a requested scene change.
- Hand control has priority. Use inspect_orion_state when authority matters, and accept a rejected result without retrying or queuing it.
- Use arnav_evidence for detailed claims about Arnav, especially metrics, confidence, timelines, and project proof.
- Use search_web whenever accuracy depends on current or changing information. Never claim to have searched unless the tool ran.
- Use read_url when the visitor provides or refers to a specific public page.
- Use typed tab tools for ordinary actions. Use run_page_javascript only for a requested in-page action that typed tools cannot express, or when the visitor explicitly asks to run JavaScript.
- Never navigate the Orion tab away. Use open_url for external pages. Popup blocking is a normal tool result, not success.
- Call tools before writing the final answer. You may call independent tools in parallel and compose tools across multiple rounds.

${ORION_ORB_APPLICATION_CONTEXT}

ARNAV KNOWLEDGE
${ARNAV_PROFILE_CONTEXT}

CURRENT ORION STATE
${JSON.stringify(clientState)}

Keep Orion classy: capable enough to be memorable, honest enough to be credible.`;
}

const CLIENT_TOOLS = new Set<ClientToolName>([
  'orb_set_field', 'orb_transform', 'orb_set_motion', 'orb_set_core', 'orb_set_appearance', 'orb_effect',
  'run_page_javascript', 'open_url', 'show_content', 'modify_orion_ui',
  'toggle_fullscreen', 'copy_text', 'inspect_orion_state',
]);

function isClientTool(name: string): name is ClientToolName {
  return CLIENT_TOOLS.has(name as ClientToolName);
}

interface ExecutedServerTool {
  result: unknown;
  sources: SourceLink[];
  summary: string;
}

async function executeServerTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  signal: AbortSignal,
): Promise<ExecutedServerTool> {
  if (name === 'arnav_evidence') {
    const query = String(args.query ?? '').trim().slice(0, 500);
    if (!query) throw new Error('Arnav evidence query is empty.');
    return {
      result: { evidence: searchArnavEvidence(query, clampNumber(args.maxSections, 5, 1, 6)), snapshot: '2026-07-08' },
      sources: [],
      summary: 'Arnav evidence checked',
    };
  }
  if (name === 'search_web') {
    const query = String(args.query ?? '').trim().slice(0, 700);
    if (!query) throw new Error('Search query is empty.');
    const grounded = await groundedGeminiTool(env, query, 'search', signal);
    return { result: { notes: grounded.text, sources: grounded.sources }, sources: grounded.sources, summary: 'Current sources checked' };
  }
  if (name === 'read_url') {
    const urls = sanitizePublicUrls(args.urls);
    const question = String(args.question ?? '').trim().slice(0, 1_000);
    if (!urls.length || !question) throw new Error('URL Context requires a public URL and a question.');
    const grounded = await groundedGeminiTool(env, `${question}\n\nURLs:\n${urls.join('\n')}`, 'url', signal);
    const sources = grounded.sources.length ? grounded.sources : urls.map((url) => ({ title: new URL(url).hostname, url }));
    return { result: { notes: grounded.text, sources }, sources, summary: 'Page context read' };
  }
  throw new Error(`Unknown server tool: ${name}`);
}

async function groundedGeminiTool(
  env: Env,
  input: string,
  kind: 'search' | 'url',
  signal: AbortSignal,
): Promise<{ text: string; sources: SourceLink[] }> {
  const model = 'gemini-3.1-flash-lite';
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: 'Return compact factual research notes for another agent. Preserve uncertainty and never add conversational filler.' }] },
      contents: [{ role: 'user', parts: [{ text: input }] }],
      tools: [kind === 'search' ? { googleSearch: {} } : { urlContext: {} }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 900 },
    }),
    signal,
  });
  if (!response.ok) throw new Error(kind === 'search' ? 'Live search is unavailable.' : 'That page could not be read.');
  const payload = await response.json<GeminiResponse>();
  const candidate = payload.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join('').trim();
  if (!text) throw new Error(kind === 'search' ? 'Live search returned no usable result.' : 'URL Context returned no usable content.');
  return { text: text.slice(0, 12_000), sources: uniqueSources(candidate?.groundingMetadata?.groundingChunks ?? []) };
}

function toolPresentation(name: string, args: Record<string, unknown>): { label: string; speech: string } {
  if (name === 'arnav_evidence') return { label: 'Checking Arnav’s evidence', speech: 'I’m checking Arnav’s project evidence.' };
  if (name === 'search_web') return { label: 'Searching current sources', speech: 'I’m checking the latest sources.' };
  if (name === 'read_url') return { label: 'Reading the referenced page', speech: 'I’m reading that page now.' };
  if (name === 'open_url') return { label: `Opening ${safeHostname(args.url)}`, speech: 'I found it. I’m bringing it up.' };
  if (name.startsWith('orb_')) return { label: 'Adjusting core geometry', speech: 'I’m adjusting the core.' };
  if (name === 'run_page_javascript') return { label: 'Running an Orion page command', speech: 'I’m applying that inside Orion.' };
  if (name === 'inspect_orion_state') return { label: 'Reading Orion state', speech: 'I’m checking the current control state.' };
  return { label: 'Updating the Orion interface', speech: 'I’m applying that now.' };
}

function functionResponseContent(results: Array<{ name: string; response: Record<string, unknown> }>): GeminiContent {
  return {
    role: 'user',
    parts: results.map(({ name, response }) => ({ functionResponse: { name, response } })),
  };
}

function resolveContinuationResults(
  pending: PendingToolCall[],
  received: ClientToolResult[],
): Array<{ callId: string; name: string; response: Record<string, unknown> }> | null {
  if (!Array.isArray(received)) return null;
  const unique = new Map<string, ClientToolResult>();
  for (const result of received) {
    if (!result || unique.has(result.callId)) return null;
    unique.set(result.callId, result);
  }
  const clientCount = pending.filter((call) => !call.result).length;
  if (unique.size !== clientCount) return null;
  const responses: Array<{ callId: string; name: string; response: Record<string, unknown> }> = [];
  for (const call of pending) {
    if (call.result) {
      responses.push({ callId: call.callId, name: call.name, response: call.result });
      continue;
    }
    const result = unique.get(call.callId);
    if (!result || result.tool !== call.name || !['completed', 'failed', 'popup_blocked', 'rejected'].includes(result.status)) return null;
    responses.push({
      callId: call.callId,
      name: call.name,
      response: {
        status: result.status,
        ...(result.result !== undefined ? { result: result.result } : {}),
        ...(result.error ? { error: result.error.slice(0, 2_000) } : {}),
      },
    });
  }
  return responses;
}

async function signContinuation(payload: ContinuationPayload, secret: string): Promise<string> {
  const data = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${data}.${await hmac(`orion-tool:${data}`, secret)}`;
}

async function verifyContinuation(value: string, secret: string): Promise<ContinuationPayload | null> {
  const [data, signature] = value.split('.');
  if (!data || !signature || !constantTimeEqual(signature, await hmac(`orion-tool:${data}`, secret))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(data))) as ContinuationPayload;
    return payload.version === 1
      && typeof payload.sid === 'string'
      && typeof payload.turnId === 'string'
      && typeof payload.expiresAt === 'number'
      && Number.isInteger(payload.round)
      && payload.round >= 0
      && payload.round < MAX_TOOL_ROUNDS
      && Number.isInteger(payload.toolCalls)
      && payload.toolCalls > 0
      && payload.toolCalls <= MAX_TOOL_CALLS
      && Array.isArray(payload.contents)
      && Array.isArray(payload.pending)
      ? payload
      : null;
  } catch {
    return null;
  }
}

function isContinuationRequest(body: RespondRequest): body is ContinueRespondRequest {
  return body.kind === 'continue';
}

function sanitizeClientState(value: unknown): ClientState {
  const input = isRecord(value) ? value : {};
  const orb = isRecord(input.orb) ? input.orb : {};
  const authority = ['ambient', 'voice', 'hand'].includes(String(input.authority)) ? input.authority as ClientState['authority'] : 'ambient';
  const microphone = ['idle', 'hold', 'latched', 'finalizing', 'thinking', 'speaking', 'error'].includes(String(input.microphone))
    ? input.microphone as ClientState['microphone'] : 'idle';
  const screen = isRecord(input.screen) ? input.screen : {};
  return {
    authority,
    microphone,
    fullscreen: input.fullscreen === true,
    ...(typeof input.visiblePanel === 'string' ? { visiblePanel: input.visiblePanel.slice(0, 80) } : {}),
    screen: {
      visible: screen.visible === true,
      text: typeof screen.text === 'string' ? screen.text.trim().slice(0, 2_000) : '',
    },
    orb: {
      mode: typeof orb.mode === 'string' ? orb.mode.slice(0, 40) : 'ready',
      fieldOpen: orb.fieldOpen === true,
      zoomLog: clampNumber(orb.zoomLog, 0, -100, 100),
      sourceSize: clampNumber(orb.sourceSize, 0.77, 0.08, 25),
      brightness: clampNumber(orb.brightness, 1.5, 0.1, 4),
      energy: clampNumber(orb.energy, 0, 0, 1.5),
      appearance: sanitizeOrbAppearance(orb.appearance),
    },
  };
}

function sanitizeOrbAppearance(value: unknown): ClientState['orb']['appearance'] {
  const appearance = isRecord(value) ? value : {};
  const color = (candidate: unknown): string | null =>
    typeof candidate === 'string' && /^#[\da-f]{6}$/i.test(candidate) ? candidate.toUpperCase() : null;
  return {
    shell: color(appearance.shell),
    lightSource: color(appearance.lightSource),
    field: color(appearance.field),
  };
}

function sanitizePublicUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5).flatMap((item) => {
    try {
      const url = new URL(String(item));
      return ['http:', 'https:'].includes(url.protocol) && !isPrivateHostname(url.hostname) ? [url.toString()] : [];
    } catch {
      return [];
    }
  });
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts as [number, number, number, number];
  return first === 0 || first === 10 || first === 127 || first === 169 && second === 254
    || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168
    || first === 100 && second >= 64 && second <= 127;
}

function providerErrorEvent(status: number, provider: string): Extract<VoiceTurnEvent, { type: 'error' }> {
  if (status === 401 || status === 403) return { type: 'error', code: 'invalid_credentials', message: `${provider} authentication is unavailable.` };
  if (status === 402 || status === 429) return { type: 'error', code: 'quota_exhausted', message: `${provider} capacity has been reached.` };
  return { type: 'error', code: 'unavailable', message: `${provider} is temporarily unavailable.` };
}

function safeHostname(value: unknown): string {
  try { return new URL(String(value)).hostname || 'page'; } catch { return 'page'; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function requireSession(request: Request, env: Env): Promise<SessionPayload | Response> {
  const cookie = request.headers.get('Cookie');
  const encoded = cookieValue(cookie, SESSION_COOKIE) ?? cookieValue(cookie, LOCAL_SESSION_COOKIE);
  if (!encoded) return apiError('session_expired', 'Start a new verified Orion session.', 401);
  const secret = sessionSecret(request, env);
  if (!secret) return apiError('invalid_credentials', 'Session signing is not configured.', 503);
  const session = await verifySession(encoded, secret);
  if (!session || (!session.owner && session.exp <= Date.now())) return apiError('session_expired', 'This Orion session has expired.', 401);
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const ipHash = await digest(`${ip}:${secret}`);
  if (session.ip !== ipHash) return apiError('session_expired', 'This Orion session is no longer valid.', 401);
  return session;
}

function isRestrictedSession(session: SessionPayload, env: Env): boolean {
  return !session.owner && !isOpenAccessActive(env.ORION_OPEN_ACCESS_UNTIL);
}

function sessionSecret(request: Request, env: Env): string | null {
  if (env.SESSION_SIGNING_KEY) return env.SESSION_SIGNING_KEY;
  const host = new URL(request.url).hostname;
  return host === 'localhost' || host === '127.0.0.1' ? 'orion-local-development-only' : null;
}

async function sessionCookie(payload: SessionPayload, secret: string, secure: boolean): Promise<string> {
  const value = await signSession(payload, secret);
  const name = secure ? SESSION_COOKIE : LOCAL_SESSION_COOKIE;
  const maxAge = Math.max(1, Math.floor((payload.exp - Date.now()) / 1_000));
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const data = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmac(data, secret);
  return `${data}.${signature}`;
}

async function verifySession(value: string, secret: string): Promise<SessionPayload | null> {
  const [data, signature] = value.split('.');
  if (!data || !signature || !constantTimeEqual(signature, await hmac(data, secret))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(data))) as SessionPayload;
    return typeof payload.sid === 'string'
      && typeof payload.exp === 'number'
      && typeof payload.turns === 'number'
      && typeof payload.ip === 'string'
      && (payload.owner === undefined || typeof payload.owner === 'boolean')
      ? payload
      : null;
  } catch {
    return null;
  }
}

async function hmac(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}

async function verifyTurnstile(token: string, ip: string, secret: string): Promise<boolean> {
  const form = new FormData();
  form.set('secret', secret);
  form.set('response', token);
  if (ip !== 'local') form.set('remoteip', ip);
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  if (!response.ok) return false;
  const result = await response.json<{ success?: boolean }>();
  return result.success === true;
}

async function allowHourlySession(ipHash: string, ctx: ExecutionContext): Promise<boolean> {
  const key = new Request(`https://orion-rate.invalid/session/${ipHash}`);
  const cache = await caches.open('orion-session-rate');
  const cached = await cache.match(key);
  const count = cached ? Number(await cached.text()) : 0;
  if (count >= 2) return false;
  ctx.waitUntil(cache.put(key, new Response(String(count + 1), { headers: { 'Cache-Control': 'max-age=3600' } })));
  return true;
}

function eventStream(
  produce: (emit: (event: VoiceTurnEvent) => void) => Promise<void>,
  extraHeaders: HeadersInit = {},
): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: VoiceTurnEvent): void => {
        if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        await produce(emit);
      } catch (error) {
        if (!cancelled && !(error instanceof DOMException && error.name === 'AbortError')) {
          console.error(JSON.stringify({ event: 'gemini_stream_failure', error: safeError(error) }));
          emit({ type: 'error', code: 'unavailable', message: 'Orion could not complete that response.' });
        }
      } finally {
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function mappedProviderError(status: number, provider: string): Response {
  if (status === 401 || status === 403) return apiError('invalid_credentials', `${provider} authentication is unavailable.`, 503);
  if (status === 402) return apiError('quota_exhausted', `${provider} billing capacity has been reached.`, 503);
  if (status === 429) return apiError('quota_exhausted', `${provider} capacity has been reached.`, 503);
  return apiError('unavailable', `${provider} is temporarily unavailable.`, 503);
}

function apiError(code: ProviderErrorCode, message: string, status: number): Response {
  return json({ ok: false, code, message }, status);
}

function methodNotAllowed(): Response {
  return apiError('invalid_request', 'Method not allowed.', 405);
}

function json(value: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders },
  });
}

async function readJson<T>(request: Request, maxBytes: number): Promise<T> {
  const length = Number(request.headers.get('Content-Length') ?? 0);
  if (length > maxBytes) throw new Error('Request body is too large.');
  const text = await request.text();
  if (text.length > maxBytes) throw new Error('Request body is too large.');
  return JSON.parse(text || '{}') as T;
}

function sanitizeHistory(history: unknown): StartRespondRequest['history'] {
  if (!Array.isArray(history)) return [];
  const valid: StartRespondRequest['history'] = [];
  for (const turn of history.slice(-MAX_HISTORY_MESSAGES)) {
    if (!turn || typeof turn !== 'object') continue;
    const candidate = turn as { role?: unknown; text?: unknown; spokenText?: unknown; screenText?: unknown };
    if (candidate.role === 'user' && typeof candidate.text === 'string') {
      const text = candidate.text.trim().slice(0, MAX_TRANSCRIPT);
      if (text) valid.push({ role: 'user', text });
      continue;
    }
    if (candidate.role !== 'assistant') continue;
    const legacy = typeof candidate.text === 'string' ? candidate.text.trim() : '';
    const spokenText = (typeof candidate.spokenText === 'string' ? candidate.spokenText.trim() : legacy).slice(0, 650);
    const screenText = (typeof candidate.screenText === 'string' ? candidate.screenText.trim() : legacy).slice(0, 12_000);
    if (spokenText || screenText) valid.push({ role: 'assistant', spokenText, screenText });
  }
  const result: StartRespondRequest['history'] = [];
  let characters = 0;
  for (let index = valid.length - 1; index >= 0; index -= 1) {
    const turn = valid[index]!;
    const turnCharacters = turn.role === 'user'
      ? turn.text.length
      : turn.spokenText.length + turn.screenText.length;
    if (!turnCharacters || characters + turnCharacters > MAX_HISTORY_CHARACTERS) break;
    result.unshift(turn);
    characters += turnCharacters;
  }
  return result;
}

function uniqueSources(chunks: Array<{ web?: { uri?: string; title?: string } }>): SourceLink[] {
  const seen = new Set<string>();
  return chunks.flatMap(({ web }) => {
    if (!web?.uri || seen.has(web.uri)) return [];
    seen.add(web.uri);
    return [{ url: web.uri, title: web.title || new URL(web.uri).hostname }];
  }).slice(0, 6);
}

function cookieValue(header: string | null, name: string): string | null {
  const item = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return item ? item.slice(name.length + 1) : null;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(number) ? number : fallback));
}

async function digest(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
