import { expect, test } from "bun:test";
import { parseHostRoster, parsePlaneProjects, setupA2Canvas } from "../a2canvas-setup.ts";

test("disabled (returns null) when MATRIX_ACCESS_TOKEN is absent", () => {
  expect(setupA2Canvas({ env: {} })).toBeNull();
  expect(setupA2Canvas({ env: { MATRIX_HOMESERVER_URL: "https://hs" } })).toBeNull();
});

test("enabled with Matrix env → exposes an /events handler + start()", () => {
  const setup = setupA2Canvas({
    env: {
      MATRIX_HOMESERVER_URL: "https://hs.example",
      MATRIX_ACCESS_TOKEN: "tok",
      MATRIX_ROOM_ID: "!room:hs",
    },
  });
  expect(setup).not.toBeNull();
  expect(typeof setup?.eventsHandler).toBe("function");
  expect(typeof setup?.start).toBe("function");
});

test("the wired /events handler serves the (initially empty) board", async () => {
  const setup = setupA2Canvas({
    env: {
      MATRIX_ACCESS_TOKEN: "tok",
      MATRIX_ROOM_ID: "!r:hs",
      MATRIX_HOMESERVER_URL: "https://hs",
    },
  });
  const res = await setup?.eventsHandler(new Request("http://localhost/a2canvas/events"));
  expect(res?.status).toBe(200);
  expect(res?.headers.get("Content-Type")).toBe("text/event-stream");
  await res?.body?.cancel();
});

test("parseHostRoster: valid JSON → map; absent/invalid → empty", () => {
  expect(parseHostRoster('{"agent:ajs":"malar"}')).toEqual({ "agent:ajs": "malar" });
  expect(parseHostRoster(undefined)).toEqual({});
  expect(parseHostRoster("not json")).toEqual({});
});

test("parsePlaneProjects: 'DOT:uuid1,AJS:uuid2' → refs; blank → []", () => {
  expect(parsePlaneProjects("DOT:uuid1, AJS:uuid2")).toEqual([
    { identifier: "DOT", id: "uuid1" },
    { identifier: "AJS", id: "uuid2" },
  ]);
  expect(parsePlaneProjects(undefined)).toEqual([]);
  expect(parsePlaneProjects("garbage")).toEqual([]);
});
