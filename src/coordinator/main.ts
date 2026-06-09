import express, { Request, Response } from "express";
import { Effect, GameRoom } from "./game.js";
import { Lobby } from "./lobby.js";
import { JobResult, NodeId, ServerEvent } from "../shared/protocol.js";

const PORT = Number(process.env.PORT ?? 8787);
const lobby = new Lobby();
const streams = new Map<NodeId, Response>(); // open SSE connections by node

function send(nodeId: NodeId, event: ServerEvent): void {
  const res = streams.get(nodeId);
  if (res) res.write(`data: ${JSON.stringify(event)}\n\n`);
}
function applyEffects(room: GameRoom, effects: Effect[]): void {
  for (const fx of effects) {
    if (fx.kind === "routeJob") {
      const open = streams.has(fx.job.targetNodeId);
      console.log(`[coordinator] → job ${fx.job.payload.kind} to ${fx.job.targetNodeId} (stream ${open ? "open" : "MISSING"})`);
      send(fx.job.targetNodeId, { type: "jobAssigned", job: fx.job });
    } else {
      const targets = room.nodeIds();
      console.log(`[coordinator] ⇉ ${fx.event.type} → ${targets.length} player(s)`);
      for (const nodeId of targets) send(nodeId, fx.event);
    }
  }
}

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.post("/register", (req: Request, res: Response) => {
  const name = String(req.body?.name ?? "Player");
  res.json(lobby.register(name));
});

app.post("/games", (_req: Request, res: Response) => {
  res.json(lobby.createGame());
});

app.post("/games/join", (req: Request, res: Response) => {
  try {
    const { code, nodeId } = req.body ?? {};
    const { room, slot, effects } = lobby.join(String(code), String(nodeId));
    res.json({ gameId: room.gameId, slot });
    applyEffects(room, effects); // best-effort live nudge; snapshot covers late streams
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

function roomFor(req: Request, res: Response): GameRoom | null {
  const room = lobby.get(String(req.params.id));
  if (!room) {
    res.status(404).json({ error: "no such game" });
    return null;
  }
  return room;
}

app.post("/games/:id/ready", (req: Request, res: Response) => {
  const room = roomFor(req, res);
  if (!room) return;
  const fx = room.markReady(String(req.body?.nodeId));
  res.json({ ok: true });
  applyEffects(room, fx);
});

app.post("/games/:id/action", (req: Request, res: Response) => {
  const room = roomFor(req, res);
  if (!room) return;
  try {
    const { nodeId, type, text } = req.body ?? {};
    const fx = room.action(String(nodeId), type, String(text));
    res.json({ ok: true });
    applyEffects(room, fx);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/games/:id/reveal", (req: Request, res: Response) => {
  const room = roomFor(req, res);
  if (!room) return;
  const fx = room.reveal(String(req.body?.nodeId), String(req.body?.secret));
  res.json({ ok: true });
  applyEffects(room, fx);
});

app.post("/games/:id/rematch", (req: Request, res: Response) => {
  const room = roomFor(req, res);
  if (!room) return;
  res.json({ ok: true });
  applyEffects(room, room.rematch());
});

app.post("/jobs/:jobId/result", (req: Request, res: Response) => {
  const result = req.body as JobResult;
  result.jobId = String(req.params.jobId);
  const nodeId = String(req.body?.nodeId);
  const gameId = lobby.gameIdForNode(nodeId);
  const room = gameId ? lobby.get(gameId) : undefined;
  const kind = (result.data as { kind?: string } | undefined)?.kind ?? "?";
  console.log(`[coordinator] ← result job=${result.jobId} from=${nodeId} ok=${result.ok} kind=${kind} room=${room ? "found" : "NOT FOUND (state lost?)"}`);
  res.json({ ok: true });
  if (room) applyEffects(room, room.jobResult(result));
});

app.get("/games/:id/stream", (req: Request, res: Response) => {
  const room = lobby.get(String(req.params.id));
  const nodeId = String(req.query.nodeId);
  if (!room) {
    res.status(404).end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const snapshot = room.snapshot();
  res.write(`data: ${JSON.stringify({ type: "snapshot", snapshot })}\n\n`);
  // Late joiner still in secret-entry: replay gameStarted to THIS stream only so
  // it receives the signal that was broadcast before the stream was open. Gate
  // narrowly on "waiting-ready" to avoid bouncing an in-progress reconnect back to
  // the secret-entry screen (reconnect-mid-game is out of scope).
  if (snapshot.phase === "waiting-ready") {
    res.write(`data: ${JSON.stringify({ type: "gameStarted" })}\n\n`);
  }
  streams.set(nodeId, res);
  console.log(`[coordinator] stream connected: ${nodeId} (game ${room.gameId}, phase ${snapshot.phase})`);

  // Keepalive: stop proxies (e.g. Render) from culling an idle SSE connection.
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      /* connection already gone */
    }
  }, 15000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  req.on("close", () => {
    clearInterval(heartbeat);
    // Only remove if this is still the current stream for the node — a reconnect
    // may have already registered a fresh one. Do NOT end the game on a transient
    // close; the client auto-reconnects and re-syncs from the snapshot.
    if (streams.get(nodeId) === res) {
      streams.delete(nodeId);
    }
    console.log(`[coordinator] stream closed: ${nodeId}`);
  });
});

export function startCoordinator(port = PORT) {
  return app.listen(port, () => console.log(`[coordinator] listening on :${port}`));
}

// Run directly (tsx src/coordinator/main.ts) — normalize separators for Windows.
const entry = (process.argv[1] ?? "").replace(/\\/g, "/");
if (entry.endsWith("coordinator/main.ts")) {
  startCoordinator();
}
