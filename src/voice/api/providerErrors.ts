import type { ProviderErrorCode } from '../types';

interface ApiErrorBody {
  code?: ProviderErrorCode;
  message?: string;
}

export async function apiError(response: Response): Promise<Error & { code?: ProviderErrorCode }> {
  let body: ApiErrorBody = {};
  try { body = await response.json() as ApiErrorBody; } catch { /* no provider details */ }
  return providerError(body.code ?? 'unavailable', body.message ?? 'Orion is temporarily unavailable.');
}

export function providerError(
  code: ProviderErrorCode,
  message: string,
): Error & { code?: ProviderErrorCode } {
  return Object.assign(new Error(message), { code });
}
