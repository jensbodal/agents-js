/**
 * Shared constants for the mock ACP runtime.
 *
 * Keeping the canned reply string in a module-level export lets the unit test
 * assert on the exact text without duplicating the literal.
 */

/**
 * Canned reply text emitted by the mock-acp runtime for every session/prompt.
 *
 * @internal
 */
export const MOCK_ACP_REPLY = "Hello from mock-acp runtime.";
