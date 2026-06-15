import { expect, test } from "bun:test";
// Relative import of the model so the suite runs without a workspace install.
import {
  applyA2CanvasUpdate,
  emptyBoard,
  isVerified,
  toA2CanvasView,
} from "../../a2canvas/src/index.ts";
import {
  type MatrixRoomEvent,
  matrixEventToUpdate,
  type PlaneWorkItemUpdate,
  planeWorkItemToUpdate,
} from "../src/index.ts";

const ROOM = "!cJxcDspkqBHcoALJCy:matrix.tail019e7.ts.net";
const HS = "matrix.tail019e7.ts.net";

const mev = (o: Partial<MatrixRoomEvent> = {}): MatrixRoomEvent => ({
  event_id: "$evt1",
  sender: "cognee-claude",
  timestamp: "2026-06-15T14:55:30Z",
  body: "shipping the producers",
  ...o,
});

test("matrix mapper: shortname sender -> agent principal, parsed fields", () => {
  const u = matrixEventToUpdate(mev(), { roomId: ROOM, homeserver: HS });
  expect(u.kind).toBe("agent.update");
  expect(u.principal.id).toBe("agent:cognee-claude");
  expect(u.principal.mxid).toBe("@cognee-claude:matrix.tail019e7.ts.net");
  expect(u.change.summary).toBe("shipping the producers");
  expect(u.ts).toBe(Date.parse("2026-06-15T14:55:30Z"));
  expect(u.correlationId).toBe("$evt1");
  expect(u.next?.actions[0]?.ref).toBe(`https://matrix.to/#/${ROOM}/$evt1`);
});

test("matrix mapper: full MXID sender is parsed to shortname + mxid", () => {
  const u = matrixEventToUpdate(mev({ sender: "@ajs-claude:matrix.tail019e7.ts.net" }));
  expect(u.principal.id).toBe("agent:ajs-claude");
  expect(u.principal.mxid).toBe("@ajs-claude:matrix.tail019e7.ts.net");
});

test("matrix mapper: M0 is honest-unverified and host is injected, never guessed", () => {
  const noRoster = matrixEventToUpdate(mev());
  expect(noRoster.principal.signed).toBe(false);
  expect(noRoster.authority.assertedVia).toBe("none");
  expect(noRoster.host).toBe("unknown"); // honest, NOT inferred from the name prefix

  const withRoster = matrixEventToUpdate(mev(), {
    roster: { "agent:cognee-claude": "malar" },
  });
  expect(withRoster.host).toBe("malar");
});

test("matrix mapper: long body is summarized to a single line", () => {
  const u = matrixEventToUpdate(mev({ body: `${"x ".repeat(200)}` }));
  expect(u.change.summary.length).toBeLessThanOrEqual(140);
  expect(u.change.summary).not.toContain("\n");
});

const pwi = (o: Partial<PlaneWorkItemUpdate> = {}): PlaneWorkItemUpdate => ({
  sequenceId: 533,
  projectIdentifier: "DOT",
  issueName: "ecosystem page Vite shell",
  actor: "cognee-claude",
  fromState: "Backlog",
  toState: "In Progress",
  createdAt: "2026-06-15T15:00:00Z",
  issueUrl: "https://plane.q4m.dev/dot/projects/p/issues/i",
  ...o,
});

test("plane mapper: state transition -> task id + policy-governed ref", () => {
  const u = planeWorkItemToUpdate(pwi());
  expect(u.task.id).toBe("DOT-533");
  expect(u.task.label).toBe("ecosystem page Vite shell");
  expect(u.change.kind).toBe("state-change");
  expect(u.change.summary).toBe("Backlog → In Progress");
  expect(u.next?.actions[0]?.ref).toBe("https://plane.q4m.dev/dot/projects/p/issues/i");
  expect(u.principal.id).toBe("agent:cognee-claude");
  expect(u.principal.signed).toBe(false);
});

test("plane mapper: human actor -> human principal; first assignment has no from-state", () => {
  const u = planeWorkItemToUpdate(
    pwi({ actor: "Jens Bodal", actorKind: "human", fromState: undefined }),
  );
  expect(u.principal.id).toBe("human:jens-bodal");
  expect(u.change.summary).toBe("— → In Progress");
});

test("integration: both producers feed the reducer -> two unverified lanes (M0 demo shape)", () => {
  let board = emptyBoard();
  board = applyA2CanvasUpdate(
    board,
    matrixEventToUpdate(mev({ sender: "ajs-claude", event_id: "$a" })),
  );
  board = applyA2CanvasUpdate(board, planeWorkItemToUpdate(pwi({ actor: "cognee-claude" })));
  const view = toA2CanvasView(board);
  expect(view.lanes.map((l) => l.lane).sort()).toEqual(["agent:ajs-claude", "agent:cognee-claude"]);
  for (const lane of view.lanes) {
    for (const card of lane.cards) {
      expect(isVerified(card)).toBe(false); // pre-verifier: everything renders unverified
    }
  }
});
