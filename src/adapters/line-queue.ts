/**
 * The Caller's typed lines, in the order they arrived. A line is kept until it is asked for, so input that arrives
 * early (a pipe) is not lost. A wait can be called off without taking a line, which a pending read on readline cannot
 * do: that read would swallow whatever the Caller types next.
 */
export class LineQueue {
  readonly #lines: string[] = [];
  readonly #waiting: Array<(line: string | undefined) => void> = [];
  #closed = false;

  /** A line has arrived. */
  push(line: string): void {
    const waiter = this.#waiting.shift();
    if (waiter) waiter(line);
    else this.#lines.push(line);
  }

  /** The input has ended (Ctrl-D, end of a pipe). Lines already held are still handed out. */
  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiting.splice(0)) waiter(undefined);
  }

  /**
   * The next line, or `undefined` once the input has ended. When `signal` aborts first, the wait ends with `undefined`
   * and takes no line. It never rejects.
   */
  next(signal?: AbortSignal): Promise<string | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    const line = this.#lines.shift();
    if (line !== undefined || this.#closed) return Promise.resolve(line);
    return new Promise((resolve) => {
      const waiter = (arrived: string | undefined) => {
        signal?.removeEventListener("abort", callOff);
        resolve(arrived);
      };
      const callOff = () => {
        this.#waiting.splice(this.#waiting.indexOf(waiter), 1);
        resolve(undefined);
      };
      this.#waiting.push(waiter);
      signal?.addEventListener("abort", callOff, { once: true });
    });
  }
}
