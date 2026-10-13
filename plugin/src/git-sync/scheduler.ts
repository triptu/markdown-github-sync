export interface SchedulerClock {
  now(): number;
  setTimeout(
    callback: () => void,
    milliseconds: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
}
const clock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: id => clearTimeout(id),
};
/** One foreground worker, coalesced edits, and bounded exponential backoff. */
export class ForegroundScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private pending = false;
  private failures = 0;
  private retryAfter = 0;
  constructor(
    private run: () => Promise<void>,
    private enabled: () => boolean,
    private visible: () => boolean,
    private onError: (error: unknown) => void,
    private time: SchedulerClock = clock,
  ) {}
  schedule(delay = 3000): void {
    if (this.stopped || !this.enabled() || !this.visible()) return;
    if (this.running) {
      this.pending = true;
      return;
    }
    if (this.timer !== null) this.time.clearTimeout(this.timer);
    const wait = Math.max(delay, this.retryAfter - this.time.now());
    this.timer = this.time.setTimeout(() => {
      this.timer = null;
      void this.execute(false);
    }, wait);
  }
  async now(): Promise<void> {
    await this.execute(true);
  }
  private async execute(manual: boolean): Promise<void> {
    if (
      this.stopped ||
      this.running ||
      (!manual && (!this.enabled() || !this.visible()))
    )
      return;
    if (this.time.now() < this.retryAfter) {
      if (manual)
        this.onError(
          new Error(
            "Sync is backing off after a network error. It will retry shortly.",
          ),
        );
      this.schedule();
      return;
    }
    if (this.timer !== null) {
      this.time.clearTimeout(this.timer);
      this.timer = null;
    }
    this.running = true;
    this.pending = false;
    try {
      await this.run();
      this.failures = 0;
      this.retryAfter = 0;
    } catch (error) {
      this.failures++;
      this.retryAfter =
        this.time.now() +
        Math.min(300000, 5000 * 2 ** Math.min(this.failures - 1, 6));
      if (
        typeof error === "object" &&
        error !== null &&
        "retryAt" in error &&
        typeof error.retryAt === "number" &&
        Number.isFinite(error.retryAt)
      )
        this.retryAfter = Math.max(this.retryAfter, error.retryAt);
      this.onError(error);
    } finally {
      this.running = false;
      this.schedule(this.pending ? 3000 : 300000);
    }
  }
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.time.clearTimeout(this.timer);
    this.timer = null;
  }
}
