/**
 * The one error-to-sentence rule.
 *
 * `(e as Error).message` was the house pattern at ~30 call sites, and it lies
 * twice: a rejected string yields `undefined` (rendered as the word
 * "undefined" in a banner), and a non-Error object yields `undefined` the
 * same way. Everything that turns a caught value into a user-visible sentence
 * goes through here.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || 'unknown error';
  if (typeof error === 'string') return error || 'unknown error';
  // Error-likes from other realms (a vm's Error, a structured-clone shell):
  // duck-type the one field the sentence needs.
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = error.message;
    if (typeof message === 'string' && message) return message;
  }
  return 'unknown error';
}
