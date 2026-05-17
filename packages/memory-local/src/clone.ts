/**
 * Local deep-clone helper.
 *
 * Why this exists: `@agents-js/memory` does not currently export a
 * `cloneRecord` helper, but the sqlite storage impl needs to defensively
 * clone records on the way out (so a caller mutating a returned object
 * cannot corrupt the in-memory row cache) and on the way in (so a
 * caller mutating its own input after the call cannot mutate stored
 * state via a shared reference).
 *
 * Tracked as a follow-up against the memory package: once the primitive
 * exports `cloneRecord` (or a `Clone` utility type), this file can be
 * deleted and call sites can import from `@agents-js/memory`.
 */
export function cloneRecord<T>(value: T): T {
  return structuredClone(value);
}
