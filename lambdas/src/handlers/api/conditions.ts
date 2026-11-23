/**
 * True when DynamoDB refused a write because its condition no longer held:
 * another request changed the item first. A handler answers 409 or its own
 * status; it is never a server fault.
 */
export function isConditionFailure(error: unknown): boolean {
  return error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");
}
