import { NodeId } from "../shared/protocol.js";
import { Effect, GameRoom } from "./game.js";

let counter = 0;
function genId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function makeCode(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 4; i += 1) s += letters[Math.floor(Math.random() * letters.length)];
  return s;
}

export class Lobby {
  private byId = new Map<string, GameRoom>();
  private byCode = new Map<string, GameRoom>();
  private names = new Map<NodeId, string>();
  private nodeGame = new Map<NodeId, string>();

  register(name: string): { nodeId: NodeId } {
    const nodeId = genId("node");
    this.names.set(nodeId, name);
    return { nodeId };
  }

  createGame(): { gameId: string; code: string } {
    const gameId = genId("game");
    let code = makeCode();
    while (this.byCode.has(code)) code = makeCode();
    const room = new GameRoom({ gameId, code, nextId: () => genId("job") });
    this.byId.set(gameId, room);
    this.byCode.set(code, room);
    return { gameId, code };
  }

  join(code: string, nodeId: NodeId): { room: GameRoom; slot: "P1" | "P2"; effects: Effect[] } {
    const room = this.byCode.get(code);
    if (!room) throw new Error("no such game");
    if (room.players.P1 && room.players.P2) throw new Error("game full");
    const name = this.names.get(nodeId) ?? "Player";
    const effects = room.addPlayer(nodeId, name);
    const slot = room.players.P2?.nodeId === nodeId ? "P2" : "P1";
    this.nodeGame.set(nodeId, room.gameId);
    return { room, slot, effects };
  }

  get(gameId: string): GameRoom | undefined {
    return this.byId.get(gameId);
  }

  gameIdForNode(nodeId: NodeId): string | undefined {
    return this.nodeGame.get(nodeId);
  }

  nameOf(nodeId: NodeId): string | undefined {
    return this.names.get(nodeId);
  }
}
