/**
 * Where the Receptionist's reply is shown as it is produced, such as a terminal.
 *
 * The rule every `ReplyStream` can rely on: when a Turn finishes, the text it was given is exactly the Turn's reply.
 * It gets there in one of two ways. Either the deltas simply add up to the reply, which includes an End state's
 * message and the safe lines for an empty reply, or the Turn's reply changed after text was shown (a refusal threw the
 * Turn away, or the request failed). Then `discard` is called first: everything shown so far for this Turn is void
 * and must be erased, and the reply that follows starts from nothing.
 */
export interface ReplyStream {
  /** Next piece of the reply, with no leading or trailing whitespace of the whole reply. Append it to what is shown. */
  text(delta: string): void;
  /** Everything shown for this Turn so far is void. Erase it. */
  discard(): void;
}

/**
 * Feeds one Turn's reply to a `ReplyStream`, enforcing the rule above. The engine reports each model reply as it
 * streams in (`beginHop`, `push`), then states the final reply with `finish`, or gives up with `abort`.
 */
export class ReplyWriter {
  readonly #stream: ReplyStream | undefined;
  #shown = "";
  /** Whitespace seen but not shown yet. Shown only if more text follows, so the reply never ends in whitespace. */
  #pending = "";
  #hopHasText = false;

  constructor(stream: ReplyStream | undefined) {
    this.#stream = stream;
  }

  /** A new model reply starts. Its text is joined to what was shown so far with a single space. */
  beginHop(): void {
    this.#pending = "";
    this.#hopHasText = false;
  }

  push(delta: string): void {
    this.#pending += delta;
    if (!this.#hopHasText) this.#pending = this.#pending.trimStart();
    const body = this.#pending.trimEnd();
    if (body === "") return;
    const separator = !this.#hopHasText && this.#shown !== "" ? " " : "";
    this.#pending = this.#pending.slice(body.length);
    this.#hopHasText = true;
    this.#show(separator + body);
  }

  /** The Turn's reply is settled. Shows whatever is missing, or discards and shows it all if what was shown is wrong. */
  finish(reply: string): void {
    if (reply === this.#shown) return;
    if (reply.startsWith(this.#shown)) {
      this.#show(reply.slice(this.#shown.length));
      return;
    }
    this.abort();
    this.#show(reply);
  }

  /** The Turn has no reply to show, so whatever was shown is erased. */
  abort(): void {
    if (this.#shown === "") return;
    this.#shown = "";
    this.#stream?.discard();
  }

  #show(text: string): void {
    this.#shown += text;
    this.#stream?.text(text);
  }
}
