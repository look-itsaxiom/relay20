import { describe, it, expect, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { startCoordinator } from "../src/coordinator/main.js";
import { CoordinatorClient } from "../src/app/coordinator-client.js";
import { MockBrain } from "../src/app/mock-brain.js";
import { JobAssignment, ServerEvent } from "../src/shared/protocol.js";

const server = startCoordinator(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
afterAll(() => server.close());

function makePlayer(secret: string) {
  const client = new CoordinatorClient(base);
  const brain = new MockBrain();
  const events: ServerEvent[] = [];
  let nodeId = "";
  let gameId = "";
  async function runJob(job: JobAssignment) {
    const started = Date.now();
    let data;
    if (job.payload.kind === "answer") data = { kind: "answer" as const, ...(await brain.answer(secret, job.payload.question)) };
    else if (job.payload.kind === "analyze") data = { kind: "analyze" as const, ...(await brain.analyze(job.payload.history)) };
    else data = { kind: "check-guess" as const, ...(await brain.checkGuess(secret, job.payload.guess)) };
    await client.postResult(nodeId, { jobId: job.jobId, ok: true, latencyMs: Date.now() - started, data });
  }
  return {
    client,
    events,
    get nodeId() { return nodeId; },
    get gameId() { return gameId; },
    setGame(id: string) { gameId = id; },
    async register(name: string) { nodeId = (await client.register(name)).nodeId; },
    startStream(ctrl: AbortController) {
      client.openStream(gameId, nodeId, (e) => {
        events.push(e);
        if (e.type === "jobAssigned" && e.job.targetNodeId === nodeId) void runJob(e.job);
      }, ctrl.signal).catch(() => {});
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, timeout = 4000) {
  const start = Date.now();
  while (!fn() && Date.now() - start < timeout) await wait(25);
  if (!fn()) throw new Error("condition not met in time");
}
function turnIs(events: ServerEvent[], slot: "P1" | "P2") {
  const tc = [...events].reverse().find((e) => e.type === "turnChanged") as any;
  return tc && tc.turn === slot;
}

describe("end-to-end game over the coordinator", () => {
  it("routes A's question to B's node and resolves both players independently to game over", async () => {
    const ctrl = new AbortController();
    const alice = makePlayer("a red bicycle");
    const bob = makePlayer("the moon");
    await alice.register("Alice");
    await bob.register("Bob");

    const { gameId, code } = await alice.client.createGame();
    alice.setGame(gameId);
    bob.setGame(gameId);
    await alice.client.join(code, alice.nodeId);
    await bob.client.join(code, bob.nodeId);
    alice.startStream(ctrl);
    bob.startStream(ctrl);

    await until(() => alice.events.some((e) => e.type === "gameStarted"));
    await alice.client.ready(gameId, alice.nodeId);
    await bob.client.ready(gameId, bob.nodeId);
    await until(() => turnIs(alice.events, "P1"));

    // Alice (P1) asks; Bob's node (P2) answers; Alice's node analyzes; turn -> Bob.
    await alice.client.action(gameId, alice.nodeId, "ask", "Is it the moon?");
    await until(() => alice.events.some((e) => e.type === "questionAnswered"));
    const answered = alice.events.find((e) => e.type === "questionAnswered") as any;
    expect(answered.answeredBySlot).toBe("P2");

    // Bob (P2) guesses Alice's secret correctly -> P2 won, turn back to Alice.
    await until(() => turnIs(alice.events, "P2"));
    await bob.client.action(gameId, bob.nodeId, "guess", "a red bicycle");
    await until(() => alice.events.some((e) => e.type === "playerResolved" && (e as any).slot === "P2"));
    expect((alice.events.find((e) => e.type === "playerResolved") as any).result).toBe("won");

    // Alice (P1) guesses Bob's secret correctly -> both resolved -> game over.
    await until(() => turnIs(alice.events, "P1"));
    await alice.client.action(gameId, alice.nodeId, "guess", "the moon");
    await until(() => alice.events.some((e) => e.type === "gameOver"));
    const over = alice.events.find((e) => e.type === "gameOver") as any;
    expect(over.results).toEqual({ P1: "won", P2: "won" });

    ctrl.abort();
  });
});
