import { describe, it, expect } from "vitest";
import { Lobby } from "../src/coordinator/lobby.js";

describe("Lobby", () => {
  it("registers a node and returns an id", () => {
    const lobby = new Lobby();
    const { nodeId } = lobby.register("Alice");
    expect(typeof nodeId).toBe("string");
    expect(nodeId.length).toBeGreaterThan(0);
  });

  it("creates a game with a join code and joins by that code", () => {
    const lobby = new Lobby();
    const host = lobby.register("Alice").nodeId;
    const guest = lobby.register("Bob").nodeId;
    const { gameId, code } = lobby.createGame();
    expect(code).toMatch(/^[A-Z]{4}$/);

    const r1 = lobby.join(code, host);
    expect(r1.slot).toBe("P1");
    const r2 = lobby.join(code, guest);
    expect(r2.slot).toBe("P2");
    expect(lobby.get(gameId)).toBe(r1.room);
    expect(r1.room.phase).toBe("waiting-ready");
  });

  it("rejects joining an unknown code", () => {
    const lobby = new Lobby();
    const n = lobby.register("Alice").nodeId;
    expect(() => lobby.join("ZZZZ", n)).toThrow();
  });

  it("rejects a third player joining a full game", () => {
    const lobby = new Lobby();
    const a = lobby.register("A").nodeId;
    const b = lobby.register("B").nodeId;
    const c = lobby.register("C").nodeId;
    const { code } = lobby.createGame();
    lobby.join(code, a);
    lobby.join(code, b);
    expect(() => lobby.join(code, c)).toThrow();
  });
});
