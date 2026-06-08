import { describe, it, expect } from "vitest";
import { GameRoom, Effect } from "../src/coordinator/game.js";

function makeRoom(budget?: number) {
  let n = 0;
  return new GameRoom({ gameId: "g1", code: "ABCD", budget, nextId: () => `job${++n}` });
}
function broadcasts(fx: Effect[]) {
  return fx.filter((e) => e.kind === "broadcast").map((e) => (e as any).event);
}
function routes(fx: Effect[]) {
  return fx.filter((e) => e.kind === "routeJob").map((e) => (e as any).job);
}
function start(budget?: number) {
  const room = makeRoom(budget);
  room.addPlayer("nodeA", "Alice"); // P1
  room.addPlayer("nodeB", "Bob"); // P2
  room.markReady("nodeA");
  room.markReady("nodeB");
  return room;
}
function completeGuess(room: GameRoom, nodeId: string, guess: string, correct: boolean) {
  const guessFx = room.action(nodeId, "guess", guess);
  const jobId = routes(guessFx)[0].jobId;
  return room.jobResult({ jobId, ok: true, latencyMs: 1, data: { kind: "check-guess", correct } });
}

describe("GameRoom", () => {
  it("starts the game when both players join", () => {
    const room = makeRoom();
    room.addPlayer("nodeA", "Alice");
    const fx = room.addPlayer("nodeB", "Bob");
    expect(room.phase).toBe("waiting-ready");
    const types = broadcasts(fx).map((e) => e.type);
    expect(types).toContain("gameStarted");
    expect(types).toContain("enterSecret");
  });

  it("rejects a third player joining a full room", () => {
    const room = makeRoom();
    room.addPlayer("nodeA", "Alice");
    room.addPlayer("nodeB", "Bob");
    expect(() => room.addPlayer("nodeC", "Carol")).toThrow();
  });

  it("begins P1's turn with full budgets when both ready", () => {
    const room = makeRoom();
    room.addPlayer("nodeA", "Alice");
    room.addPlayer("nodeB", "Bob");
    room.markReady("nodeA");
    const fx = room.markReady("nodeB");
    expect(room.phase).toBe("in-progress");
    expect(room.turn).toBe("P1");
    const tc = broadcasts(fx).find((e) => e.type === "turnChanged");
    expect(tc).toMatchObject({ turn: "P1", remaining: { P1: 20, P2: 20 } });
  });

  it("routes a question to the OPPONENT node and decrements the asker's budget", () => {
    const room = start();
    const fx = room.action("nodeA", "ask", "Is it alive?");
    const job = routes(fx)[0];
    expect(job.targetNodeId).toBe("nodeB");
    expect(job.payload).toEqual({ kind: "answer", question: "Is it alive?" });
    expect(room.remaining.P1).toBe(19);
  });

  it("locks out further actions until the current question resolves", () => {
    const room = start();
    room.action("nodeA", "ask", "Is it alive?"); // busy now
    expect(() => room.action("nodeA", "ask", "Second question?")).toThrow();
  });

  it("after the answer, routes analyze to the asker and passes the turn to the opponent", () => {
    const room = start();
    const askFx = room.action("nodeA", "ask", "Is it alive?");
    const answerJobId = routes(askFx)[0].jobId;
    const afterAnswer = room.jobResult({ jobId: answerJobId, ok: true, latencyMs: 1, data: { kind: "answer", answer: "Yes" } });
    const analyzeJob = routes(afterAnswer)[0];
    expect(analyzeJob.targetNodeId).toBe("nodeA");
    expect(broadcasts(afterAnswer).map((e) => e.type)).toContain("questionAnswered");
    const afterAnalyze = room.jobResult({ jobId: analyzeJob.jobId, ok: true, latencyMs: 1, data: { kind: "analyze", candidates: ["a dog"], followups: ["Is it a pet?"], note: "" } });
    expect(room.turn).toBe("P2");
    expect(room.history).toHaveLength(1);
    expect(broadcasts(afterAnalyze).map((e) => e.type)).toEqual(expect.arrayContaining(["analysis", "turnChanged"]));
  });

  it("a correct guess marks that player WON but does not end the game while the other is unresolved", () => {
    const room = start();
    const fx = completeGuess(room, "nodeA", "a dog", true);
    expect(room.results.P1).toBe("won");
    expect(room.phase).toBe("in-progress");
    expect(room.turn).toBe("P2");
    const ev = broadcasts(fx);
    expect(ev.map((e) => e.type)).toContain("playerResolved");
    expect(ev.find((e) => e.type === "playerResolved")).toMatchObject({ slot: "P1", result: "won" });
    expect(ev.map((e) => e.type)).not.toContain("gameOver");
  });

  it("ends the game with independent results once BOTH players resolve", () => {
    const room = start();
    completeGuess(room, "nodeA", "a dog", true); // P1 won, turn -> P2
    const fx = completeGuess(room, "nodeB", "the moon", true); // P2 won -> both resolved
    expect(room.phase).toBe("over");
    const over = broadcasts(fx).find((e) => e.type === "gameOver");
    expect(over).toMatchObject({ results: { P1: "won", P2: "won" } });
  });

  it("a player who exhausts the budget without guessing correctly LOSES", () => {
    const room = start(1); // 1 question each
    const fx = completeGuess(room, "nodeA", "wrong", false);
    expect(room.remaining.P1).toBe(0);
    expect(room.results.P1).toBe("lost");
    expect(room.turn).toBe("P2");
    expect(room.phase).toBe("in-progress");
    expect(broadcasts(fx).find((e) => e.type === "playerResolved")).toMatchObject({ slot: "P1", result: "lost" });
  });

  it("both players can lose (double loss) when neither guesses within budget", () => {
    const room = start(1);
    completeGuess(room, "nodeA", "wrong", false); // P1 lost
    const fx = completeGuess(room, "nodeB", "wrong", false); // P2 lost -> over
    expect(room.phase).toBe("over");
    const over = broadcasts(fx).find((e) => e.type === "gameOver");
    expect(over).toMatchObject({ results: { P1: "lost", P2: "lost" } });
  });

  it("surfaces an error, refunds the question, and keeps the turn when the keeper's AI fails", () => {
    const room = start();
    const askFx = room.action("nodeA", "ask", "Is it alive?");
    expect(room.remaining.P1).toBe(19);
    const jobId = routes(askFx)[0].jobId;
    const fx = room.jobResult({ jobId, ok: false, latencyMs: 1, error: "not logged in" });
    expect(room.remaining.P1).toBe(20); // refunded
    expect(room.turn).toBe("P1"); // still the asker's turn
    expect(broadcasts(fx).find((e) => e.type === "actionFailed")).toMatchObject({ slot: "P1" });
    // turn-lock released — the asker can act again
    expect(() => room.action("nodeA", "ask", "another?")).not.toThrow();
  });

  it("still passes the turn if only the analyze step fails (the answer already happened)", () => {
    const room = start();
    const askFx = room.action("nodeA", "ask", "Is it alive?");
    const answerJob = routes(askFx)[0].jobId;
    const afterAnswer = room.jobResult({ jobId: answerJob, ok: true, latencyMs: 1, data: { kind: "answer", answer: "Yes" } });
    const analyzeJob = routes(afterAnswer)[0].jobId;
    const fx = room.jobResult({ jobId: analyzeJob, ok: false, latencyMs: 1, error: "boom" });
    expect(room.turn).toBe("P2"); // turn still passes
    expect(room.history).toHaveLength(1); // answer committed
    expect(broadcasts(fx).map((e) => e.type)).toContain("analysis"); // soft analysis emitted
  });

  it("rejects an action when it is not your turn", () => {
    const room = start();
    expect(() => room.action("nodeB", "ask", "Is it alive?")).toThrow();
  });
});
