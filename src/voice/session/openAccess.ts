const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function openAccessDeadline(value: string | undefined): number | null {
  const candidate = value?.trim();
  if (!candidate || !ISO_TIMESTAMP.test(candidate)) return null;
  const deadline = Date.parse(candidate);
  return Number.isFinite(deadline) ? deadline : null;
}

export function isOpenAccessActive(value: string | undefined, now = Date.now()): boolean {
  const deadline = openAccessDeadline(value);
  return deadline !== null && now < deadline;
}

export function publicSessionExpiry(
  value: string | undefined,
  now: number,
  defaultDurationMs: number,
): number {
  const deadline = openAccessDeadline(value);
  return deadline !== null && now < deadline ? deadline : now + defaultDurationMs;
}
