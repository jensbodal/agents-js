import { describe, expect, test } from "bun:test";
import { HTTP_STATUS } from "../src/index.ts";

/**
 * HTTP_STATUS sanity test — pins the numeric values declared in
 * `packages/a2a/src/http-status.ts`.
 *
 * The constants are read by every package in the monorepo that
 * constructs a `Response` (a2a server, a2a-client/sync,
 * gateway/agui-endpoint, gateway/ws-bridge), so a silent off-by-one
 * tweak — e.g. someone copy-pasting `404` into the `NOT_ACCEPTABLE`
 * slot during a future edit — would corrupt every consumer
 * uniformly without any single call site lighting up. Pin each entry
 * to its IANA value so the test fails before the regression escapes
 * review.
 *
 * The file also documents an explicit inclusion policy ("only codes
 * the monorepo actually emits in production responses"). This suite
 * pins both axes: per-entry numeric equality AND the cardinality of
 * the declared set, so a future edit that adds an unused code or
 * deletes a load-bearing one fails the suite.
 */
describe("packages/a2a/tests/http-status.test.ts", () => {
  /**
   * WHAT: `HTTP_STATUS.OK` equals 200.
   * WHY: Canonical 2xx-success code; consumed by every successful
   *      JSON-RPC response in a2a/server.ts (six call sites), the
   *      AG-UI SSE handshake, and the WS bridge. A stray edit changing
   *      this number silently breaks every successful Response in the
   *      monorepo without lighting up at any single call site.
   */
  test("HTTP_STATUS.OK is 200", () => {
    expect(HTTP_STATUS.OK).toBe(200);
  });

  /**
   * WHAT: `HTTP_STATUS.NO_CONTENT` equals 204.
   * WHY: Returned by the CORS preflight short-circuit in a2a/server.ts.
   *      Same blast-radius concern as OK — silently miscoded preflights
   *      would still appear to "work" to the browser but log an
   *      unexpected non-204 in observability tools.
   */
  test("HTTP_STATUS.NO_CONTENT is 204", () => {
    expect(HTTP_STATUS.NO_CONTENT).toBe(204);
  });

  /**
   * WHAT: `HTTP_STATUS.BAD_REQUEST` equals 400.
   * WHY: Pins the request-validation 4xx used by the AG-UI endpoint
   *      (invalid `RunAgentInput`) and JSON-RPC envelope parsing.
   *      Confusing 400 with 422 or 412 here would change the contract
   *      consumers (browsers, agent-card-aware clients) rely on.
   */
  test("HTTP_STATUS.BAD_REQUEST is 400", () => {
    expect(HTTP_STATUS.BAD_REQUEST).toBe(400);
  });

  /**
   * WHAT: `HTTP_STATUS.NOT_FOUND` equals 404.
   * WHY: Returned by the catch-all branch in a2a/server.ts when a
   *      request matches no known route. Tools that gate retries on 404
   *      vs other 4xx (e.g. agent-card discovery probes) depend on the
   *      exact value.
   */
  test("HTTP_STATUS.NOT_FOUND is 404", () => {
    expect(HTTP_STATUS.NOT_FOUND).toBe(404);
  });

  /**
   * WHAT: `HTTP_STATUS.METHOD_NOT_ALLOWED` equals 405.
   * WHY: Returned for non-OPTIONS / non-POST requests against the
   *      JSON-RPC endpoint. Pinning the value protects the documented
   *      transport contract (POST-only).
   */
  test("HTTP_STATUS.METHOD_NOT_ALLOWED is 405", () => {
    expect(HTTP_STATUS.METHOD_NOT_ALLOWED).toBe(405);
  });

  /**
   * WHAT: `HTTP_STATUS.NOT_ACCEPTABLE` equals 406.
   * WHY: AG-UI endpoint returns 406 when the client omits
   *      `Accept: text/event-stream`. Documented in
   *      apps/internal-gateway/agui-endpoint.ts file-header. A drift
   *      here would corrupt the SSE-handshake contract.
   */
  test("HTTP_STATUS.NOT_ACCEPTABLE is 406", () => {
    expect(HTTP_STATUS.NOT_ACCEPTABLE).toBe(406);
  });

  /**
   * WHAT: `HTTP_STATUS.PAYLOAD_TOO_LARGE` equals 413.
   * WHY: Returned when a request body exceeds
   *      `DEFAULT_MAX_REQUEST_BODY_SIZE` (4 MB). The constant name
   *      follows the legacy RFC 7231 spelling per the file's header
   *      comment — pinning the number protects against a future RFC
   *      9110 rename ("Content Too Large") accidentally bumping the
   *      value too.
   */
  test("HTTP_STATUS.PAYLOAD_TOO_LARGE is 413", () => {
    expect(HTTP_STATUS.PAYLOAD_TOO_LARGE).toBe(413);
  });

  /**
   * WHAT: `HTTP_STATUS.UPGRADE_REQUIRED` equals 426.
   * WHY: Used by the WS bridge when an HTTP request hits the WS-only
   *      port. Clients that automatically upgrade vs. retry depend on
   *      the exact 426 to differentiate from 4xx that signal real
   *      client errors.
   */
  test("HTTP_STATUS.UPGRADE_REQUIRED is 426", () => {
    expect(HTTP_STATUS.UPGRADE_REQUIRED).toBe(426);
  });

  /**
   * WHAT: `HTTP_STATUS.INTERNAL_SERVER_ERROR` equals 500.
   * WHY: Catch-all for unexpected server-side failures. Bumping this
   *      to 503 (or similar) would change observability gates that
   *      pivot on "5xx but not 503" for retry semantics.
   */
  test("HTTP_STATUS.INTERNAL_SERVER_ERROR is 500", () => {
    expect(HTTP_STATUS.INTERNAL_SERVER_ERROR).toBe(500);
  });

  /**
   * WHAT: `HTTP_STATUS` declares exactly the documented set of codes
   *       (no extras, no omissions).
   * WHY: The file's header comment establishes a "narrow inclusion
   *      policy" — codes are added only when emitted from a `Response`
   *      somewhere in the monorepo. A future edit adding a code "for
   *      consistency" without a real consumer (or deleting a
   *      load-bearing one) would silently violate the policy. Pin the
   *      cardinality of the declared keys.
   */
  test("HTTP_STATUS declares exactly the documented set of codes", () => {
    expect(Object.keys(HTTP_STATUS).sort()).toEqual([
      "BAD_REQUEST",
      "CONFLICT",
      "INTERNAL_SERVER_ERROR",
      "METHOD_NOT_ALLOWED",
      "NOT_ACCEPTABLE",
      "NOT_FOUND",
      "NO_CONTENT",
      "OK",
      "PAYLOAD_TOO_LARGE",
      "UPGRADE_REQUIRED",
    ]);
  });

  /**
   * WHAT: `HTTP_STATUS.CONFLICT` equals 409.
   * WHY: AG-UI single-active-run gate emits 409 when a second
   *      `POST /agent` collides with an in-flight run. Pinning the
   *      numeric value catches accidental drift to a different
   *      "busy"-shaped code.
   */
  test("HTTP_STATUS.CONFLICT is 409", () => {
    expect(HTTP_STATUS.CONFLICT).toBe(409);
  });
});
