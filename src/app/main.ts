import express, { Request, Response } from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import open from "open";
import { CoordinatorClient } from "./coordinator-client.js";
import { SecretStore } from "./secret-store.js";
import { Brain } from "./brain.js";
import { MockBrain } from "./mock-brain.js";
import { JobAssignment, JobResultData, ServerEvent } from "../shared/protocol.js";

const USE_MOCK = process.argv.includes("--mock");
const portArg = process.argv.find((a) => a.startsWith("--port="));
const LOCAL_PORT = Number(portArg?.split("=")[1] ?? 5173);

const here = path.dirname(fileURLToPath(import.meta.url));
const secrets = new SecretStore();

// Per-process session state.
const state: {
  serverUrl: string;
  nodeId: string;
  gameId: string;
  slot: "P1" | "P2" | null;
  client: CoordinatorClient | null;
  abort: AbortController | null;
} = { serverUrl: "", nodeId: "", gameId: "", slot: null, client: null, abort: null };

const browserClients = new Set<Response>();
function toBrowser(event: ServerEvent | { type: "local"; [k: string]: unknown }) {
  for (const res of browserClients) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function loadBrain(): Promise<Brain> {
  if (USE_MOCK) return new MockBrain();
  const { ClaudeBrain } = await import("./brain.js");
  return new ClaudeBrain();
}
let brainPromise: Promise<Brain> | null = null;
const getBrain = () => (brainPromise ??= loadBrain());

async function runJob(job: JobAssignment): Promise<void> {
  const brain = await getBrain();
  const started = Date.now();
  const p = job.payload;
  if (p.kind === "answer") {
    console.log(`\n[brain] ❓ Your opponent asked: "${p.question}"`);
    console.log(`[brain]    → running it on this machine's Claude…`);
  } else if (p.kind === "analyze") {
    const n = p.history.length;
    console.log(`\n[brain] 🧠 Your Claude is reviewing the answers so far (${n} exchange${n === 1 ? "" : "s"})…`);
  } else {
    console.log(`\n[brain] 🎯 Your opponent guessed: "${p.guess}" — your Claude is checking…`);
  }
  try {
    let data: JobResultData;
    if (p.kind === "answer") {
      data = { kind: "answer", ...(await brain.answer(secrets.get() ?? "", p.question)) };
      console.log(`[brain] ↳ answered "${data.answer}" (${Date.now() - started}ms)`);
    } else if (p.kind === "analyze") {
      data = { kind: "analyze", ...(await brain.analyze(p.history)) };
      console.log(`[brain] ↳ suggested ${data.candidates.length} candidate(s) (${Date.now() - started}ms)`);
    } else {
      data = { kind: "check-guess", ...(await brain.checkGuess(secrets.get() ?? "", p.guess)) };
      console.log(`[brain] ↳ guess is ${data.correct ? "CORRECT ✅" : "wrong"} (${Date.now() - started}ms)`);
    }
    await state.client!.postResult(state.nodeId, { jobId: job.jobId, ok: true, latencyMs: Date.now() - started, data });
  } catch (e) {
    const msg = (e as Error).message;
    const hint = /auth|login|credential|api[_ ]?key|unauthor|forbidden|401|403/i.test(msg)
      ? " — is Claude Code logged in on this machine? (or restart the app with --mock)"
      : "";
    console.error(`[brain] ⚠️ Claude failed: ${msg}`);
    await state.client!.postResult(state.nodeId, { jobId: job.jobId, ok: false, latencyMs: Date.now() - started, error: msg + hint });
  }
}

function onCoordinatorEvent(event: ServerEvent) {
  if (event.type === "jobAssigned" && event.job.targetNodeId === state.nodeId) {
    toBrowser({ type: "local", note: "your AI is working…" } as any);
    void runJob(event.job);
  }
  toBrowser(event); // forward everything; coordinator never sends secrets
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(here, "web")));

// Browser SSE bridge.
app.get("/local/stream", (_req: Request, res: Response) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(`data: ${JSON.stringify({ type: "local", note: "connected" })}\n\n`);
  browserClients.add(res);
  res.on("close", () => browserClients.delete(res));
});

app.post("/local/ping", async (req: Request, res: Response) => {
  const url = String(req.body?.serverUrl ?? "").replace(/\/$/, "");
  if (!url) {
    res.status(400).json({ ok: false, error: "no server URL" });
    return;
  }
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 70000);
    const r = await fetch(`${url}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    // Any HTTP response means the host is reachable — even a 404 from an older
    // deploy that predates /health. Only a network error/timeout (the catch
    // below) counts as not reachable.
    res.json({ ok: true, status: r.status, ms: Date.now() - started });
  } catch (e) {
    res.json({ ok: false, error: (e as Error).message, ms: Date.now() - started });
  }
});

app.post("/local/connect", async (req: Request, res: Response) => {
  try {
    state.serverUrl = String(req.body?.serverUrl);
    state.client = new CoordinatorClient(state.serverUrl);
    state.nodeId = (await state.client.register(String(req.body?.name ?? "Player"))).nodeId;
    res.json({ ok: true, nodeId: state.nodeId });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

function startStream() {
  state.abort?.abort();
  const ctrl = new AbortController();
  state.abort = ctrl;
  void (async () => {
    let attempts = 0;
    while (!ctrl.signal.aborted) {
      try {
        console.log("[app] connecting to coordinator stream…");
        await state.client!.openStream(state.gameId, state.nodeId, onCoordinatorEvent, ctrl.signal);
      } catch (e) {
        if (!ctrl.signal.aborted) console.warn(`[app] stream error: ${(e as Error).message}`);
      }
      if (ctrl.signal.aborted) break;
      attempts += 1;
      const delay = Math.min(5000, 1000 * attempts);
      console.log(`[app] coordinator stream dropped — reconnecting in ${delay}ms…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  })();
}

app.post("/local/game/create", async (_req: Request, res: Response) => {
  const { gameId, code } = await state.client!.createGame();
  state.gameId = gameId;
  const joined = await state.client!.join(code, state.nodeId);
  state.slot = joined.slot;
  startStream();
  res.json({ gameId, code });
});

app.post("/local/game/join", async (req: Request, res: Response) => {
  try {
    const r = await state.client!.join(String(req.body?.code), state.nodeId);
    state.gameId = r.gameId;
    state.slot = r.slot;
    startStream();
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/local/secret", async (req: Request, res: Response) => {
  secrets.set(String(req.body?.secret ?? "")); // stays local
  await state.client!.ready(state.gameId, state.nodeId);
  res.json({ ok: true });
});

app.post("/local/action", async (req: Request, res: Response) => {
  try {
    await state.client!.action(state.gameId, state.nodeId, req.body?.type, String(req.body?.text));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/local/reveal", async (_req: Request, res: Response) => {
  const s = secrets.get();
  if (s) await state.client!.reveal(state.gameId, state.nodeId, s);
  res.json({ ok: true });
});

app.post("/local/rematch", async (_req: Request, res: Response) => {
  await state.client!.rematch(state.gameId);
  res.json({ ok: true });
});

const url = `http://localhost:${LOCAL_PORT}`;
app.listen(LOCAL_PORT, () => {
  console.log(`[app] UI on ${url}${USE_MOCK ? " (mock brain)" : ""}`);
  if (!USE_MOCK) {
    console.log(
      "[app] AI runs on this machine's authenticated Claude Code. If you see \"AI unavailable\" errors, run `claude` and log in — or restart with --mock for a no-LLM demo.",
    );
  }
  if (!process.argv.includes("--no-open")) void open(url);
});
