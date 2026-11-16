/**
 * Stand-in for the time a phone Call runs on. `now()` reads it and `after()` schedules a callback for later, as
 * `PhoneOptions.clock` and `PhoneOptions.after` do. Time moves only when a test calls `advance()`, which runs the
 * callbacks that fall due, earliest first.
 */
export class FakeClock {
  #now: number;
  #next = 0;
  readonly #timers = new Map<number, { due: number; run: () => void }>();

  constructor(start = 1000) {
    this.#now = start;
  }

  readonly now = (): number => this.#now;

  /** Schedules `run` for `ms` from now and returns the function that cancels it. */
  readonly after = (ms: number, run: () => void): (() => void) => {
    const id = this.#next++;
    this.#timers.set(id, { due: this.#now + ms, run });
    return () => void this.#timers.delete(id);
  };

  /** How many callbacks are waiting. */
  get pending(): number {
    return this.#timers.size;
  }

  /** Moves time forward by `ms`, running every callback that falls due on the way. */
  advance(ms: number): void {
    const end = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.#now = Math.max(this.#now, due[1].due);
      due[1].run();
    }
    this.#now = end;
  }
}
