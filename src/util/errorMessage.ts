/**
 * The message of a caught value: `Error#message` for errors, the string
 * form of anything else that was thrown (strings, numbers, plain objects).
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
