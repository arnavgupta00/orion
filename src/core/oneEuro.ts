const TWO_PI = Math.PI * 2;

class LowPassFilter {
  private initialized = false;
  private value = 0;

  filter(next: number, alpha: number): number {
    if (!this.initialized) {
      this.initialized = true;
      this.value = next;
      return next;
    }

    this.value = alpha * next + (1 - alpha) * this.value;
    return this.value;
  }

  reset(): void {
    this.initialized = false;
    this.value = 0;
  }
}

function smoothingFactor(dtSeconds: number, cutoff: number): number {
  const ratio = TWO_PI * cutoff * dtSeconds;
  return ratio / (ratio + 1);
}

export class OneEuroFilter {
  private readonly signal = new LowPassFilter();
  private readonly derivative = new LowPassFilter();
  private lastTimestamp?: number;
  private lastRaw?: number;

  constructor(
    private readonly minCutoff = 1.1,
    private readonly beta = 0.018,
    private readonly derivativeCutoff = 1,
  ) {}

  filter(value: number, timestampMs: number): number {
    if (this.lastTimestamp === undefined || this.lastRaw === undefined) {
      this.lastTimestamp = timestampMs;
      this.lastRaw = value;
      return this.signal.filter(value, 1);
    }

    const dt = Math.max((timestampMs - this.lastTimestamp) / 1000, 1 / 240);
    const rawDerivative = (value - this.lastRaw) / dt;
    const filteredDerivative = this.derivative.filter(
      rawDerivative,
      smoothingFactor(dt, this.derivativeCutoff),
    );
    const cutoff = this.minCutoff + this.beta * Math.abs(filteredDerivative);
    const result = this.signal.filter(value, smoothingFactor(dt, cutoff));

    this.lastTimestamp = timestampMs;
    this.lastRaw = value;
    return result;
  }

  reset(): void {
    this.lastTimestamp = undefined;
    this.lastRaw = undefined;
    this.signal.reset();
    this.derivative.reset();
  }
}
