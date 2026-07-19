declare global {
  interface Window {
    clarity?: ClarityQueue;
  }
}

const CLARITY_HOST = 'orion.arnav.network';
type ClarityQueue = ((...args: unknown[]) => void) & { q?: unknown[][] };

export function initializeClarity(): void {
  if (window.location.hostname !== CLARITY_HOST || window.clarity) return;
  const projectId = document
    .querySelector<HTMLMetaElement>('meta[name="ms-clarity-project-id"]')
    ?.content.trim();
  if (!projectId || !/^[a-z0-9]{6,32}$/i.test(projectId)) return;

  const clarity: ClarityQueue = (...args: unknown[]): void => {
    (clarity.q ??= []).push(args);
  };
  window.clarity = clarity;

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.clarity.ms/tag/${encodeURIComponent(projectId)}`;
  script.dataset.analytics = 'microsoft-clarity';
  document.head.append(script);
}

export {};
