import { createHmac } from "node:crypto";

export const TEST_PLANE_SECRET = "plane-secret";
export const TEST_PLANE_WEBHOOK_URL = "http://127.0.0.1:9200/webhooks/plane";

export function signPlaneBody(body: string, secret: string = TEST_PLANE_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function buildPlaneRequest(
  body: string,
  signature: string = signPlaneBody(body),
  delivery: string = "delivery-123",
): Request {
  return new Request(TEST_PLANE_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-plane-delivery": delivery,
      "x-plane-event": "issue",
      "x-plane-signature": signature,
    },
    body,
  });
}
