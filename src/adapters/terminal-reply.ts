import type { ReplyStream } from "../engine/reply-stream.js";

/**
 * Shows the Receptionist's reply on a terminal as it streams in, under a label such as `Receptionist: `.
 *
 * On a real terminal (`columns` known) a discarded reply is erased: the cursor moves up over every row the reply took,
 * counting rows that wrapped, and clears from there down. Piped output cannot be erased, so the withdrawn text is
 * marked instead. Either way the label is only printed once there is text to show, so a reply that never arrives
 * leaves nothing behind.
 */
export class TerminalReply implements ReplyStream {
  readonly #write: (text: string) => void;
  readonly #columns: number | undefined;
  readonly #label: string;
  /** Everything shown on the current line group, label included. Empty when nothing is showing. */
  #shown = "";

  constructor(write: (text: string) => void, label: string, columns?: number) {
    this.#write = write;
    this.#label = label;
    this.#columns = columns;
  }

  text(delta: string): void {
    if (this.#shown === "") this.#emit(this.#label);
    this.#emit(delta);
  }

  discard(): void {
    if (this.#shown === "") return;
    if (this.#columns !== undefined) {
      const up = this.#rows() - 1;
      this.#write(`${up > 0 ? `\x1b[${up}A` : ""}\r\x1b[J`);
    } else {
      this.#write(" [withdrawn]\n");
    }
    this.#shown = "";
  }

  /** Finishes the reply's line. Call once the Turn is over. */
  end(): void {
    if (this.#shown === "") return;
    this.#write("\n");
    this.#shown = "";
  }

  #emit(text: string): void {
    this.#shown += text;
    this.#write(text);
  }

  /** Rows the shown text takes, where a row is cut at the window width. */
  #rows(): number {
    const columns = this.#columns ?? Infinity;
    return this.#shown.split("\n").reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / columns)), 0);
  }
}
