/**
 * A set that remembers only the most recent `limit` values, so that what a long-running program notes (event ids, the
 * ids of Calls that are over) does not grow without end. Once it holds more than `limit`, the value added longest ago
 * is forgotten. A value added again is not counted twice and is not made newer.
 */
export class RecentSet<T> {
  readonly #limit: number;
  readonly #values = new Set<T>();

  constructor(limit: number) {
    this.#limit = limit;
  }

  get size(): number {
    return this.#values.size;
  }

  has(value: T): boolean {
    return this.#values.has(value);
  }

  add(value: T): void {
    this.#values.add(value);
    if (this.#values.size > this.#limit) this.#values.delete(this.#values.values().next().value as T);
  }
}
