import { apiError, providerError } from '../api/providerErrors';
import type { SessionResponse } from '../types';
import { turnstileToken } from './turnstile';

export async function createBrowserSession(ownerToken = ''): Promise<SessionResponse> {
  let response = await postSession(ownerToken);
  if (response.ok) return response.json() as Promise<SessionResponse>;

  const initialError = await apiError(response);
  if (initialError.code !== 'verification_required' || ownerToken) throw initialError;

  let token: string | undefined;
  try {
    token = await turnstileToken();
  } catch {
    throw providerError('unavailable', 'Voice session could not start. Press Space to retry.');
  }
  if (!token) throw providerError('unavailable', 'Voice session could not start. Press Space to retry.');

  response = await postSession(ownerToken, token);
  if (!response.ok) throw await apiError(response);
  return response.json() as Promise<SessionResponse>;
}

function postSession(ownerToken: string, turnstileToken?: string): Promise<Response> {
  return fetch('/api/session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(turnstileToken ? { turnstileToken } : {}),
      ...(ownerToken ? { ownerToken } : {}),
    }),
  });
}
