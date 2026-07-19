import { TURNSTILE_SITE_KEY } from '../../config';

export async function turnstileToken(): Promise<string | undefined> {
  if (!TURNSTILE_SITE_KEY) return undefined;
  await loadTurnstile();
  return new Promise((resolve, reject) => {
    const id = window.turnstile!.render('#turnstile-anchor', {
      sitekey: TURNSTILE_SITE_KEY,
      size: 'invisible',
      execution: 'execute',
      callback: (token: string) => resolve(token),
      'error-callback': () => reject(new Error('Browser verification failed.')),
      'expired-callback': () => reject(new Error('Browser verification expired.')),
    });
    window.turnstile!.execute(id);
  });
}

async function loadTurnstile(): Promise<void> {
  if (window.turnstile) return;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Browser verification could not load.'));
    document.head.append(script);
  });
}

declare global {
  interface Window {
    turnstile?: {
      render(container: string, options: Record<string, unknown>): string;
      execute(widgetId: string): void;
    };
  }
}
