import { expect, test } from '@playwright/test';

test('presents the local camera onboarding clearly', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /ori\s*on/i })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enter Orion' })).toBeVisible();
  await expect(page.getByText('Camera stays on this device')).toBeVisible();
});

test('keeps the first-visit capability invitation visible until explicitly dismissed', async ({ page }) => {
  await page.goto('/?demo=ready&freeze=1&voice=mock&discover=1');
  await expect(page.locator('#capability-runway')).toBeVisible();
  await expect(page.getByLabel('Hold Space, speak, then release to send')).toBeVisible();
  await page.evaluate(() => window.__orionTest?.transcribe('What can you do?'));
  await expect(page.locator('#capability-runway')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss suggested prompts' }).click();
  await expect(page.locator('#capability-runway')).toBeHidden();
});

test('reveals the owner access prompt only from the owner URL', async ({ page }) => {
  await page.goto('/?owner=1');
  await expect(page.locator('#owner-access')).toBeVisible();
  await page.getByRole('button', { name: 'Enter Orion' }).click();
  await expect(page.locator('#model-status')).toContainText('Owner access code is required');
  await expect(page.locator('#setup-overlay')).toBeVisible();
});

test('loads the local hand model and reaches calibration with a camera stream', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Enter Orion' }).click();
  await expect(page.locator('#calibration-panel')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#error-panel')).toBeHidden();
  await expect(page.getByText('MIRRORED CAMERA')).toBeVisible();
});

test('supports push-to-talk and double-tap latch states', async ({ page }) => {
  await page.goto('/?demo=ready&freeze=1&voice=mock');
  await expect(page.locator('#voice-ribbon')).toBeVisible();
  await expect(page.locator('#space-prompt')).toBeVisible();
  await expect(page.locator('#microphone-button')).toHaveCount(0);
  await page.keyboard.down('Space');
  await expect(page.locator('body')).toHaveAttribute('data-mic', 'hold');
  await expect(page.locator('#space-prompt')).toBeHidden();
  await expect(page.locator('#close-listening')).toBeHidden();
  await expect(page.locator('#finish-listening')).toBeHidden();
  await page.waitForTimeout(260);
  await page.keyboard.up('Space');
  await expect(page.locator('body')).toHaveAttribute('data-mic', 'idle');

  await page.keyboard.press('Space');
  await page.waitForTimeout(100);
  await page.keyboard.down('Space');
  await expect(page.locator('body')).toHaveAttribute('data-mic', 'latched');
  await page.keyboard.up('Space');
  await expect(page.locator('#close-listening')).toBeVisible();
  await expect(page.locator('#finish-listening')).toBeVisible();
  await page.locator('#finish-listening').click();
  await expect(page.locator('body')).toHaveAttribute('data-mic', 'idle');
});

test('opens the complete control guide from the top-right information button', async ({ page }) => {
  await page.goto('/?demo=ready&freeze=1');
  await page.getByRole('button', { name: 'Open Orion guide' }).click();
  await expect(page.locator('#guide-panel')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.getByRole('heading', { name: 'Control the core.' })).toBeVisible();
  await expect(page.getByText('Fist → rapid open')).toBeVisible();
  await expect(page.getByText('Double-tap')).toBeVisible();
});

test('discards a visual voice command while hand control is active', async ({ page }) => {
  await page.route('**/api/respond', async (route) => {
    const body = route.request().postDataJSON() as { kind?: string; toolResults?: Array<{ status?: string }> };
    if (body.kind === 'continue') {
      expect(body.toolResults?.[0]?.status).toBe('rejected');
      await route.fulfill({
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ type: 'screen-delta', text: '**Hand control is active**, so I left the field alone.' })}\n\ndata: ${JSON.stringify({ type: 'done' })}\n\n`,
      });
      return;
    }
    await route.fulfill({
      contentType: 'text/event-stream',
      body: [
        { type: 'tool-start', callId: 'orb-1', tool: 'orb_set_field', label: 'Adjusting core geometry' },
        { type: 'progress-speech', text: 'I’m adjusting the core.' },
        { type: 'client-tool-call', callId: 'orb-1', tool: 'orb_set_field', args: { state: 'open' }, continuation: 'mock-continuation' },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    });
  });
  await page.goto('/?demo=awake&freeze=1&voice=mock');
  await expect(page.locator('#authority-status')).toContainText('HAND CONTROL');
  await page.evaluate(() => window.__orionTest?.transcribe('open the field'));
  await expect(page.locator('#orion-toast')).toContainText('HAND CONTROL ACTIVE · AGENT COMMAND REJECTED');
  await expect(page.locator('#answer-text')).toContainText('left the field alone');
});

test('renders rich screen responses while removing unsafe model markup', async ({ page }) => {
  await page.route('**/api/respond', async (route) => {
    const screenText = [
      '## Arnav at a glance',
      '',
      '- **Production AI** at the edge',
      '- [Public GitHub](https://github.com/arnavgupta00)',
      '- [Unsafe link](javascript:alert(1))',
      '<script>document.body.dataset.compromised = "true"</script>',
      '<img src=x onerror="document.body.dataset.compromised = true">',
    ].join('\n');
    await route.fulfill({
      contentType: 'text/event-stream',
      body: [
        { type: 'screen-delta', text: screenText },
        { type: 'done' },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    });
  });
  await page.goto('/?demo=ready&freeze=1&voice=mock');
  await page.evaluate(() => window.__orionTest?.transcribe('Tell me about Arnav'));

  const answer = page.locator('#answer-text');
  await expect(answer.getByRole('heading', { name: 'Arnav at a glance' })).toBeVisible();
  const github = answer.getByRole('link', { name: 'Public GitHub' });
  await expect(github).toHaveAttribute('target', '_blank');
  await expect(github).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(answer.locator('script, img')).toHaveCount(0);
  await expect(answer.getByRole('link', { name: 'Unsafe link' })).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveAttribute('data-compromised', 'true');
});

test('runs a Gemini page command in Orion and reports visible progress', async ({ page }) => {
  await page.route('**/api/respond', async (route) => {
    const body = route.request().postDataJSON() as { kind?: string; toolResults?: Array<{ status?: string }> };
    if (body.kind === 'continue') {
      expect(body.toolResults?.[0]?.status).toBe('completed');
      await route.fulfill({
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ type: 'done' })}\n\n`,
      });
      return;
    }
    await route.fulfill({
      contentType: 'text/event-stream',
      body: [
        { type: 'tool-start', callId: 'js-1', tool: 'run_page_javascript', label: 'Running an Orion page command' },
        { type: 'progress-speech', text: 'I’m applying that inside Orion.' },
        {
          type: 'client-tool-call', callId: 'js-1', tool: 'run_page_javascript', continuation: 'mock-continuation',
          args: { source: "document.body.dataset.agentTest = 'complete'; return document.body.dataset.agentTest;" },
        },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    });
  });
  await page.goto('/?demo=ready&freeze=1&voice=mock');
  await page.evaluate(() => window.__orionTest?.transcribe('mark this Orion tab as complete'));
  await expect(page.locator('body')).toHaveAttribute('data-agent-test', 'complete');
  await expect(page.locator('#action-trace')).toBeVisible();
  await expect(page.locator('#action-trace-summary')).toHaveText('1 action completed');
});

test('stops Orion speech with X without opening the microphone', async ({ page }) => {
  await page.goto('/?demo=ready&freeze=1&voice=mock');
  await page.evaluate(() => window.__orionTest?.startSpeaking());
  await expect(page.locator('body')).toHaveAttribute('data-mic', 'speaking');
  await expect(page.locator('#stop-speaking')).toBeVisible();
  await page.keyboard.press('x');
  await expect(page.locator('body')).toHaveAttribute('data-mic', 'idle');
  await expect(page.locator('#live-transcript')).toContainText('Voice stopped');
});

test('keeps hand control available when a voice session expires', async ({ page }) => {
  await page.goto('/?demo=awake&freeze=1&voice=mock');
  await page.evaluate(() => window.__orionTest?.expireSession());
  await expect(page.locator('#voice-status')).toHaveText('SESSION EXPIRED');
  await expect(page.locator('#authority-status')).toContainText('HAND CONTROL');
});

for (const [mode, word] of [
  ['ready', 'READY'],
  ['awake', 'AWAKE'],
  ['grab', 'GRAB'],
  ['dual', 'DUAL CONTROL'],
  ['charge', 'CHARGE'],
  ['burst', 'DISPERSE'],
  ['expanded', 'FIELD OPEN'],
] as const) {
  test(`renders the ${mode} control state`, async ({ page }) => {
    await page.goto(`/?demo=${mode}&freeze=1`);
    await expect(page.locator('body')).toHaveAttribute('data-state', mode);
    await expect(page.locator('#status-word')).toHaveText(word);
    await page.waitForTimeout(600);
    await expect(page).toHaveScreenshot(`${mode}-1470x956.png`, {
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
    });
  });
}

test('keeps the dual-control composition legible at 1280×720', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?demo=dual&freeze=1');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'dual');
  await page.waitForTimeout(600);
  await expect(page).toHaveScreenshot('dual-1280x720.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.02,
  });
});

test('crosses the triangle shell and reveals the internal light source', async ({ page }) => {
  await page.goto('/?demo=dual&zoom=8&freeze=1');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'dual');
  await page.waitForTimeout(800);
  await expect(page).toHaveScreenshot('source-1470x956.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.02,
  });
});

test('crosses the light source into the infinite depth field', async ({ page }) => {
  await page.goto('/?demo=dual&zoom=80&freeze=1');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'dual');
  await page.waitForTimeout(800);
  await expect(page).toHaveScreenshot('immersive-1470x956.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.02,
  });
});
