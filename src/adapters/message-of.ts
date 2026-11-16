/** The error's message, or the thrown value as text when it is not an `Error`. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
