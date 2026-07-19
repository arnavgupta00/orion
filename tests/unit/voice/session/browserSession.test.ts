import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserSession } from '../../../../src/voice/session/browserSession';

describe('browser session bootstrap', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts open access without loading browser verification', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      ok: true,
      expiresAt: 1_785_176_999_000,
      turnLimit: null,
      openAccess: true,
      openAccessUntil: 1_785_176_999_000,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const session = await createBrowserSession();

    expect(session.openAccess).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/session', expect.objectContaining({ body: '{}' }));
  });
});
