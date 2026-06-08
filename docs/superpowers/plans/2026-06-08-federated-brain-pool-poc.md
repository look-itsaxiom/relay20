# Federated Brain-Pool POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a 2-player "20 Questions" game proving the federated brain-pool architecture: a stateless coordinator with no LLM, plus participant-run player apps that each contribute their own authenticated Claude, where one player's question executes on the other player's machine and each player's secret never leaves their machine.

**Architecture:** Two layers. A **remote coordinator** (Express) owns the lobby (join-by-code), the public game state machine, and routing of typed "jobs" between the two nodes — it holds no secrets and never calls an LLM. A **player app** (one per participant) serves a local game UI on localhost, stands up a brain node (Claude Agent SDK), stores that participant's secret locally, and keeps one outbound SSE connection to the coordinator. All coordinator↔app traffic is outbound from the app (SSE in, POST out), so it works over the internet or a Cloudflare One overlay with no inbound connections.

**Tech Stack:** TypeScript (ESM, NodeNext) on Node 22, run with `tsx`; Express for both servers; SSE for coordinator→app and app→browser; Vitest for tests; `@anthropic-ai/claude-agent-sdk` for the brain; `open` to launch the browser.

**Note on git:** The project is not yet a git repository. The `git commit` steps below are optional — either run `git init` first and use them as written, or skip them and treat each "Commit" step as a checkpoint.

**Note on Node version (Windows/nvm):** A background process on this machine keeps resetting the global nvm symlink to Node 16, which breaks the toolchain (deps need ≥18). Don't rely on `nvm use`. Instead, prepend the absolute Node 22 directory to `PATH` at the start of any PowerShell session before running `npm`/`tsx`:

```powershell
$env:Path = "C:\Users\ChaseSkibeness\AppData\Local\nvm\v22.22.1;" + $env:Path
node -v   # should print v22.22.1
```

This makes `node`, `npm`, `npx`, and `tsx` all resolve to v22 regardless of the symlink. (Adjust the version directory if you upgrade Node.)

**Spec:** `docs/superpowers/specs/2026-06-08-federated-brain-pool-poc-design.md`

---

## File Structure

```
src/
├── shared/
│   └── protocol.ts          # all wire types: jobs, SSE events, snapshot
├── coordinator/
│   ├── game.ts              # GameRoom — pure state machine, returns Effect[]
│   ├── lobby.ts             # Lobby — register, create/join-by-code, room lookup
│   └── main.ts              # Express: REST + per-node SSE; applies Effects (routing fold-in)
└── app/
    ├── secret-store.ts      # in-process secret; never transmitted
    ├── brain.ts             # Brain interface + real Claude Agent SDK impl
    ├── mock-brain.ts        # deterministic Brain impl for --mock / tests
    ├── coordinator-client.ts# register, POST actions/results, consume coordinator SSE
    ├── main.ts              # local UI server + SSE bridge + job loop; opens browser
    └── web/
        ├── index.html       # screens: connect → lobby → secret → chat → result
        └── app.js           # vanilla JS; talks to localhost only
tests/
├── game.test.ts
├── lobby.test.ts
├── secret-store.test.ts
└── integration.test.ts      # coordinator + two simulated mock-brain players
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "relay-poc",
  "private": true,
  "type": "module",
  "scripts": {
    "coordinator": "tsx src/coordinator/main.ts",
    "app": "tsx src/app/main.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.1.0",
    "express": "^4.21.2",
    "open": "^10.1.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.10.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
*.log
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: dependencies install with no errors; `node_modules/` appears.

> If `@anthropic-ai/claude-agent-sdk@^0.1.0` fails to resolve, run `npm view @anthropic-ai/claude-agent-sdk version` and pin the latest published version in `package.json`, then re-run `npm install`. The brain wrapper (Task 11) is the only place that imports it.

- [ ] **Step 6: Commit (optional — see git note)**

```bash
git init && git add -A && git commit -m "chore: scaffold relay POC"
```

---

### Task 2: Wire protocol types

**Files:**
- Create: `src/shared/protocol.ts`

- [ ] **Step 1: Write `src/shared/protocol.ts`**

```ts
export type NodeId = string;
export type PlayerSlot = "P1" | "P2";
export type GamePhase = "lobby" | "waiting-ready" | "in-progress" | "over";

export interface QnA {
  askedBy: PlayerSlot;
  question: string;
  answer: string;
}

// ---- Jobs the coordinator routes to ONE specific node ----
export type JobPayload =
  | { kind: "answer"; question: string } // keeper uses its LOCAL secret
  | { kind: "analyze"; history: QnA[] } // strategist; no secret
  | { kind: "check-guess"; guess: string }; // keeper uses its LOCAL secret

export interface JobAssignment {
  jobId: string;
  targetNodeId: NodeId;
  payload: JobPayload;
}

export type JobResultData =
  | { kind: "answer"; answer: string }
  | { kind: "analyze"; candidates: string[]; followups: string[]; note: string }
  | { kind: "check-guess"; correct: boolean };

export interface JobResult {
  jobId: string;
  ok: boolean;
  latencyMs: number;
  data?: JobResultData;
  error?: string;
}

// ---- Public snapshot sent when a stream connects ----
export interface GameSnapshot {
  phase: GamePhase;
  players: { slot: PlayerSlot; name: string; ready: boolean }[];
  turn: PlayerSlot;
  history: QnA[];
  winner: PlayerSlot | null;
}

// ---- Coordinator -> app SSE events ----
export type ServerEvent =
  | { type: "snapshot"; snapshot: GameSnapshot }
  | { type: "playerJoined"; slot: PlayerSlot; name: string }
  | { type: "gameStarted" }
  | { type: "enterSecret"; category: string }
  | { type: "jobAssigned"; job: JobAssignment }
  | {
      type: "questionAnswered";
      askedBy: PlayerSlot;
      question: string;
      answer: string;
      answeredBySlot: PlayerSlot;
    }
  | { type: "analysis"; forSlot: PlayerSlot; candidates: string[]; followups: string[] }
  | { type: "guessResult"; bySlot: PlayerSlot; guess: string; correct: boolean }
  | { type: "turnChanged"; turn: PlayerSlot }
  | { type: "gameOver"; winner: PlayerSlot }
  | { type: "secretRevealed"; slot: PlayerSlot; secret: string }
  | { type: "rematch" }
  | { type: "playerLeft"; slot: PlayerSlot };
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit (optional)**

```bash
git add src/shared/protocol.ts && git commit -m "feat: wire protocol types"
```

---

### Task 3: GameRoom — the pure game state machine

**Files:**
- Create: `src/coordinator/game.ts`
- Test: `tests/game.test.ts`

- [ ] **Step 1: Write the failing test `tests/game.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { GameRoom, Effect } from "../src/coordinator/game.js";
import { JobResult } from "../src/shared/protocol.js";

function makeRoom() {
  let n = 0;
  return new GameRoom({ gameId: "g1", code: "ABCD", nextId: () => `job${++n}` });
}
function broadcasts(fx: Effect[]) {
  return fx.filter((e) => e.kind === "broadcast").map((e) => (e as any).event);
}
function routes(fx: Effect[]) {
  return fx.filter((e) => e.kind === "routeJob").map((e) => (e as any).job);
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

  it("begins P1's turn when both ready", () => {
    const room = makeRoom();
    room.addPlayer("nodeA", "Alice");
    room.addPlayer("nodeB", "Bob");
    room.markReady("nodeA");
    const fx = room.markReady("nodeB");
    expect(room.phase).toBe("in-progress");
    expect(room.turn).toBe("P1");
    expect(broadcasts(fx)).toContainEqual({ type: "turnChanged", turn: "P1" });
  });

  it("routes a question to the OPPONENT node (keeper)", () => {
    const room = makeRoom();
    room.addPlayer("nodeA", "Alice"); // P1
    room.addPlayer("nodeB", "Bob"); // P2
    room.markReady("nodeA");
    room.markReady("nodeB");
    const fx = room.action("nodeA", "ask", "Is it alive?");
    const job = routes(fx)[0];
    expect(job.targetNodeId).toBe("nodeB"); // opponent answers
    expect(job.payload).toEqual({ kind: "answer", question: "Is it alive?" });
  });

  it("after the answer, routes analyze to the ASKER node (strategist) and passes the turn", () => {
    const room = makeRoom();
    room.addPlayer("nodeA", "Alice");
    room.addPlayer("nodeB", "Bob");
    room.markReady("nodeA");
    room.markReady("nodeB");
    const askFx = room.action("nodeA", "ask", "Is it alive?");
    const answerJobId = routes(askFx)[0].jobId;

    const answerRes: JobResult = {
      jobId: answerJobId,
      ok: true,
      latencyMs: 1,
      data: { kind: "answer", answer: "Yes" },
    };
    const afterAnswer = room.jobResult(answerRes);
    const analyzeJob = routes(afterAnswer)[0];
    expect(analyzeJob.targetNodeId).toBe("nodeA"); // asker's own node analyzes
    expect(analyzeJob.payload.kind).toBe("analyze");
    expect(broadcasts(afterAnswer).map((e) => e.type)).toContain("questionAnswered");

    const analyzeRes: JobResult = {
      jobId: analyzeJob.jobId,
      ok: true,
      latencyMs: 1,
      data: { kind: "analyze", candidates: ["a dog"], followups: ["Is it a pet?"], note: "" },
    };
    const afterAnalyze = room.jobResult(analyzeRes);
    expect(room.turn).toBe("P2"); // turn passed
    expect(room.history).toHaveLength(1);
    expect(broadcasts(afterAnalyze).map((e) => e.type)).toEqual(
      expect.arrayContaining(["analysis", "turnChanged"]),
    );
  });

  it("ends the game when the keeper confirms a correct guess", () => {
    const room = makeRoom();
    room.addPlayer("nodeA", "Alice");
    room.addPlayer("nodeB", "Bob");
    room.markReady("nodeA");
    room.markReady("nodeB");
    const guessFx = room.action("nodeA", "guess", "a dog");
    const job = guessFx.find((e) => e.kind === "routeJob") as any;
    expect(job.job.targetNodeId).toBe("nodeB");
    const res: JobResult = {
      jobId: job.job.jobId,
      ok: true,
      latencyMs: 1,
      data: { kind: "check-guess", correct: true },
    };
    const over = room.jobResult(res);
    expect(room.phase).toBe("over");
    expect(room.winner).toBe("P1");
    expect(broadcasts(over)).toContainEqual({ type: "gameOver", winner: "P1" });
  });

  it("rejects an action when it is not your turn", () => {
    const room = makeRoom();
    room.addPlayer("nodeA", "Alice");
    room.addPlayer("nodeB", "Bob");
    room.markReady("nodeA");
    room.markReady("nodeB");
    expect(() => room.action("nodeB", "ask", "Is it alive?")).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/game.test.ts`
Expected: FAIL — cannot find module `../src/coordinator/game.js`.

- [ ] **Step 3: Write `src/coordinator/game.ts`**

```ts
import {
  GamePhase,
  GameSnapshot,
  JobAssignment,
  JobResult,
  NodeId,
  PlayerSlot,
  QnA,
  ServerEvent,
} from "../shared/protocol.js";

export type Effect =
  | { kind: "routeJob"; job: JobAssignment }
  | { kind: "broadcast"; event: ServerEvent };

interface PlayerState {
  nodeId: NodeId;
  name: string;
  ready: boolean;
}
interface PendingJob {
  kind: "answer" | "analyze" | "check-guess";
  askerSlot: PlayerSlot;
  text?: string; // the question or guess
}

const CATEGORY = "person, place, or thing";

export class GameRoom {
  readonly gameId: string;
  readonly code: string;
  private readonly nextId: () => string;

  phase: GamePhase = "lobby";
  players: Partial<Record<PlayerSlot, PlayerState>> = {};
  turn: PlayerSlot = "P1";
  history: QnA[] = [];
  winner: PlayerSlot | null = null;

  private pending = new Map<string, PendingJob>();
  private pendingHistory?: QnA[];

  constructor(opts: { gameId: string; code: string; nextId: () => string }) {
    this.gameId = opts.gameId;
    this.code = opts.code;
    this.nextId = opts.nextId;
  }

  private slotOf(nodeId: NodeId): PlayerSlot | null {
    if (this.players.P1?.nodeId === nodeId) return "P1";
    if (this.players.P2?.nodeId === nodeId) return "P2";
    return null;
  }
  private opp(slot: PlayerSlot): PlayerSlot {
    return slot === "P1" ? "P2" : "P1";
  }

  addPlayer(nodeId: NodeId, name: string): Effect[] {
    const slot: PlayerSlot = this.players.P1 ? "P2" : "P1";
    this.players[slot] = { nodeId, name, ready: false };
    const fx: Effect[] = [{ kind: "broadcast", event: { type: "playerJoined", slot, name } }];
    if (this.players.P1 && this.players.P2) {
      this.phase = "waiting-ready";
      fx.push({ kind: "broadcast", event: { type: "gameStarted" } });
      fx.push({ kind: "broadcast", event: { type: "enterSecret", category: CATEGORY } });
    }
    return fx;
  }

  markReady(nodeId: NodeId): Effect[] {
    const slot = this.slotOf(nodeId);
    if (!slot) return [];
    this.players[slot]!.ready = true;
    if (this.players.P1?.ready && this.players.P2?.ready) {
      this.phase = "in-progress";
      this.turn = "P1";
      return [{ kind: "broadcast", event: { type: "turnChanged", turn: "P1" } }];
    }
    return [];
  }

  action(nodeId: NodeId, type: "ask" | "guess", text: string): Effect[] {
    const slot = this.slotOf(nodeId);
    if (this.phase !== "in-progress" || slot !== this.turn) {
      throw new Error("not your turn");
    }
    const keeper = this.players[this.opp(slot)]!;
    const jobId = this.nextId();
    if (type === "ask") {
      this.pending.set(jobId, { kind: "answer", askerSlot: slot, text });
      return [
        { kind: "routeJob", job: { jobId, targetNodeId: keeper.nodeId, payload: { kind: "answer", question: text } } },
      ];
    }
    this.pending.set(jobId, { kind: "check-guess", askerSlot: slot, text });
    return [
      { kind: "routeJob", job: { jobId, targetNodeId: keeper.nodeId, payload: { kind: "check-guess", guess: text } } },
    ];
  }

  jobResult(res: JobResult): Effect[] {
    const p = this.pending.get(res.jobId);
    if (!p) return [];
    this.pending.delete(res.jobId);
    const asker = p.askerSlot;
    const keeperSlot = this.opp(asker);

    if (p.kind === "answer" && res.data?.kind === "answer") {
      const answer = res.data.answer;
      this.pendingHistory = [...this.history, { askedBy: asker, question: p.text!, answer }];
      const jobId = this.nextId();
      this.pending.set(jobId, { kind: "analyze", askerSlot: asker });
      return [
        {
          kind: "broadcast",
          event: { type: "questionAnswered", askedBy: asker, question: p.text!, answer, answeredBySlot: keeperSlot },
        },
        {
          kind: "routeJob",
          job: { jobId, targetNodeId: this.players[asker]!.nodeId, payload: { kind: "analyze", history: this.pendingHistory } },
        },
      ];
    }

    if (p.kind === "analyze" && res.data?.kind === "analyze") {
      this.history = this.pendingHistory ?? this.history;
      this.pendingHistory = undefined;
      this.turn = this.opp(asker);
      return [
        { kind: "broadcast", event: { type: "analysis", forSlot: asker, candidates: res.data.candidates, followups: res.data.followups } },
        { kind: "broadcast", event: { type: "turnChanged", turn: this.turn } },
      ];
    }

    if (p.kind === "check-guess" && res.data?.kind === "check-guess") {
      if (res.data.correct) {
        this.phase = "over";
        this.winner = asker;
        return [{ kind: "broadcast", event: { type: "gameOver", winner: asker } }];
      }
      this.turn = this.opp(asker);
      return [
        { kind: "broadcast", event: { type: "guessResult", bySlot: asker, guess: p.text!, correct: false } },
        { kind: "broadcast", event: { type: "turnChanged", turn: this.turn } },
      ];
    }

    return [];
  }

  reveal(nodeId: NodeId, secret: string): Effect[] {
    const slot = this.slotOf(nodeId);
    if (!slot) return [];
    return [{ kind: "broadcast", event: { type: "secretRevealed", slot, secret } }];
  }

  rematch(): Effect[] {
    this.phase = "waiting-ready";
    this.history = [];
    this.winner = null;
    this.pending.clear();
    this.pendingHistory = undefined;
    if (this.players.P1) this.players.P1.ready = false;
    if (this.players.P2) this.players.P2.ready = false;
    return [
      { kind: "broadcast", event: { type: "rematch" } },
      { kind: "broadcast", event: { type: "enterSecret", category: CATEGORY } },
    ];
  }

  playerLeft(nodeId: NodeId): Effect[] {
    const slot = this.slotOf(nodeId);
    if (!slot || this.phase === "over") return [];
    this.phase = "over";
    return [{ kind: "broadcast", event: { type: "playerLeft", slot } }];
  }

  nodeIds(): NodeId[] {
    return (["P1", "P2"] as PlayerSlot[]).filter((s) => this.players[s]).map((s) => this.players[s]!.nodeId);
  }

  snapshot(): GameSnapshot {
    return {
      phase: this.phase,
      players: (["P1", "P2"] as PlayerSlot[])
        .filter((s) => this.players[s])
        .map((s) => ({ slot: s, name: this.players[s]!.name, ready: this.players[s]!.ready })),
      turn: this.turn,
      history: this.history,
      winner: this.winner,
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/game.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit (optional)**

```bash
git add src/coordinator/game.ts tests/game.test.ts && git commit -m "feat: GameRoom state machine"
```

---

### Task 4: Lobby — register, create/join-by-code

**Files:**
- Create: `src/coordinator/lobby.ts`
- Test: `tests/lobby.test.ts`

- [ ] **Step 1: Write the failing test `tests/lobby.test.ts`**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lobby.test.ts`
Expected: FAIL — cannot find module `../src/coordinator/lobby.js`.

- [ ] **Step 3: Write `src/coordinator/lobby.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lobby.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit (optional)**

```bash
git add src/coordinator/lobby.ts tests/lobby.test.ts && git commit -m "feat: Lobby with join-by-code"
```

---

### Task 5: Coordinator HTTP server (REST + per-node SSE)

**Files:**
- Create: `src/coordinator/main.ts`

This folds the spec's `relay.ts` responsibility (job routing + SSE fan-out) into the entry file via the `applyEffects` helper. Verified end-to-end by the integration test in Task 12.

- [ ] **Step 1: Write `src/coordinator/main.ts`**

```ts
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
      send(fx.job.targetNodeId, { type: "jobAssigned", job: fx.job });
    } else {
      for (const nodeId of room.nodeIds()) send(nodeId, fx.event);
    }
  }
}

const app = express();
app.use(express.json());

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
  const gameId = lobby.gameIdForNode(String(req.body?.nodeId));
  const room = gameId ? lobby.get(gameId) : undefined;
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
  });
  res.write(`data: ${JSON.stringify({ type: "snapshot", snapshot: room.snapshot() })}\n\n`);
  streams.set(nodeId, res);
  req.on("close", () => {
    streams.delete(nodeId);
    applyEffects(room, room.playerLeft(nodeId));
  });
});

export function startCoordinator(port = PORT) {
  return app.listen(port, () => console.log(`[coordinator] listening on :${port}`));
}

// Run directly (tsx src/coordinator/main.ts)
if (process.argv[1] && process.argv[1].endsWith("coordinator/main.ts")) {
  startCoordinator();
}
```

- [ ] **Step 2: Smoke-test the coordinator boots**

Run: `npm run coordinator`
Expected: prints `[coordinator] listening on :8787`. Stop it with Ctrl-C.

- [ ] **Step 3: Commit (optional)**

```bash
git add src/coordinator/main.ts && git commit -m "feat: coordinator REST + SSE"
```

---

### Task 6: Secret store (local, never transmitted)

**Files:**
- Create: `src/app/secret-store.ts`
- Test: `tests/secret-store.test.ts`

- [ ] **Step 1: Write the failing test `tests/secret-store.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { SecretStore } from "../src/app/secret-store.js";

describe("SecretStore", () => {
  it("stores and returns the secret", () => {
    const s = new SecretStore();
    expect(s.get()).toBeNull();
    s.set("a red bicycle");
    expect(s.get()).toBe("a red bicycle");
  });

  it("is not serialized into JSON payloads (guard)", () => {
    const s = new SecretStore();
    s.set("top secret");
    // Anything we POST to the coordinator must not accidentally include the secret.
    const payload = { nodeId: "n1", type: "ask", text: "Is it alive?" };
    expect(JSON.stringify(payload)).not.toContain("top secret");
    // The store itself must not leak via JSON.stringify either.
    expect(JSON.stringify(s)).not.toContain("top secret");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/secret-store.test.ts`
Expected: FAIL — cannot find module `../src/app/secret-store.js`.

- [ ] **Step 3: Write `src/app/secret-store.ts`**

```ts
// Holds this participant's secret in process memory only. Never sent to the
// coordinator. Uses a private field (#) so JSON.stringify cannot serialize it.
export class SecretStore {
  #secret: string | null = null;
  set(value: string): void {
    this.#secret = value.trim();
  }
  get(): string | null {
    return this.#secret;
  }
  clear(): void {
    this.#secret = null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/secret-store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit (optional)**

```bash
git add src/app/secret-store.ts tests/secret-store.test.ts && git commit -m "feat: local secret store"
```

---

### Task 7: Brain interface + mock brain

**Files:**
- Create: `src/app/brain.ts` (interface + a stub real impl; real SDK wired in Task 11)
- Create: `src/app/mock-brain.ts`

- [ ] **Step 1: Write `src/app/brain.ts` (interface only for now)**

```ts
import { QnA } from "../shared/protocol.js";

export interface Brain {
  answer(secret: string, question: string): Promise<{ answer: string }>;
  analyze(history: QnA[]): Promise<{ candidates: string[]; followups: string[]; note: string }>;
  checkGuess(secret: string, guess: string): Promise<{ correct: boolean }>;
}
```

- [ ] **Step 2: Write `src/app/mock-brain.ts`**

```ts
import { QnA } from "../shared/protocol.js";
import { Brain } from "./brain.js";

// Deterministic, token-free brain for --mock and tests.
export class MockBrain implements Brain {
  async answer(secret: string, question: string): Promise<{ answer: string }> {
    const q = question.toLowerCase();
    const yes = secret.toLowerCase().split(/\s+/).some((w) => w.length > 2 && q.includes(w));
    return { answer: yes ? "Yes." : "No." };
  }
  async analyze(history: QnA[]): Promise<{ candidates: string[]; followups: string[]; note: string }> {
    return {
      candidates: ["(mock) something matching the answers so far"],
      followups: ["Is it man-made?", "Is it bigger than a breadbox?"],
      note: `analyzed ${history.length} prior Q&A`,
    };
  }
  async checkGuess(secret: string, guess: string): Promise<{ correct: boolean }> {
    return { correct: guess.trim().toLowerCase() === secret.trim().toLowerCase() };
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit (optional)**

```bash
git add src/app/brain.ts src/app/mock-brain.ts && git commit -m "feat: brain interface + mock brain"
```

---

### Task 8: Coordinator client (used by the app)

**Files:**
- Create: `src/app/coordinator-client.ts`

- [ ] **Step 1: Write `src/app/coordinator-client.ts`**

```ts
import { JobResult, ServerEvent } from "../shared/protocol.js";

// Thin client for the coordinator. All inbound data arrives over one SSE stream;
// everything else is an outbound POST. Uses global fetch (Node 22).
export class CoordinatorClient {
  constructor(private baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  register(name: string) {
    return this.post<{ nodeId: string }>("/register", { name });
  }
  createGame() {
    return this.post<{ gameId: string; code: string }>("/games", {});
  }
  join(code: string, nodeId: string) {
    return this.post<{ gameId: string; slot: "P1" | "P2" }>("/games/join", { code, nodeId });
  }
  ready(gameId: string, nodeId: string) {
    return this.post(`/games/${gameId}/ready`, { nodeId });
  }
  action(gameId: string, nodeId: string, type: "ask" | "guess", text: string) {
    return this.post(`/games/${gameId}/action`, { nodeId, type, text });
  }
  reveal(gameId: string, nodeId: string, secret: string) {
    return this.post(`/games/${gameId}/reveal`, { nodeId, secret });
  }
  rematch(gameId: string) {
    return this.post(`/games/${gameId}/rematch`, {});
  }
  postResult(nodeId: string, result: JobResult) {
    return this.post(`/jobs/${result.jobId}/result`, { ...result, nodeId });
  }

  // Opens the SSE stream and calls onEvent for each ServerEvent until aborted.
  async openStream(gameId: string, nodeId: string, onEvent: (e: ServerEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch(`${this.baseUrl}/games/${gameId}/stream?nodeId=${encodeURIComponent(nodeId)}`, { signal });
    if (!res.body) throw new Error("no SSE body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()) as ServerEvent);
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit (optional)**

```bash
git add src/app/coordinator-client.ts && git commit -m "feat: coordinator client (SSE + POST)"
```

---

### Task 9: Integration test (coordinator + two mock-brain players)

This validates the coordinator, game machine, routing, and client end-to-end with mock brains and no browser — by simulating each player app's job loop inline. Done before the real UI/brain so the protocol is proven first.

**Files:**
- Test: `tests/integration.test.ts`

- [ ] **Step 1: Write `tests/integration.test.ts`**

```ts
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

// Simulate one player app: holds a local secret + runs jobs with the mock brain.
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
    get nodeId() {
      return nodeId;
    },
    get gameId() {
      return gameId;
    },
    setGame(id: string) {
      gameId = id;
    },
    async register(name: string) {
      nodeId = (await client.register(name)).nodeId;
    },
    startStream(ctrl: AbortController) {
      client
        .openStream(gameId, nodeId, (e) => {
          events.push(e);
          if (e.type === "jobAssigned" && e.job.targetNodeId === nodeId) void runJob(e.job);
        }, ctrl.signal)
        .catch(() => {});
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!fn() && Date.now() - start < timeout) await wait(25);
  if (!fn()) throw new Error("condition not met in time");
}

describe("end-to-end game over the coordinator", () => {
  it("routes A's question to B's node, analyzes on A's node, and ends on a correct guess", async () => {
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

    // Both enter secrets locally (already set in makePlayer) and ready up.
    await alice.client.ready(gameId, alice.nodeId);
    await bob.client.ready(gameId, bob.nodeId);
    await until(() => alice.events.some((e) => e.type === "turnChanged"));

    // Alice (P1) asks; B's node answers; A's node analyzes.
    await alice.client.action(gameId, alice.nodeId, "ask", "Is it the moon?");
    await until(() => alice.events.some((e) => e.type === "questionAnswered"));
    await until(() => alice.events.some((e) => e.type === "analysis" && e.forSlot === "P1"));
    const answered = alice.events.find((e) => e.type === "questionAnswered") as any;
    expect(answered.answeredBySlot).toBe("P2"); // Bob's node answered Alice's question

    // Turn passes to Bob; Bob guesses Alice's secret correctly -> game over.
    await until(() => alice.events.some((e) => e.type === "turnChanged" && e.turn === "P2"));
    await bob.client.action(gameId, bob.nodeId, "guess", "a red bicycle");
    await until(() => alice.events.some((e) => e.type === "gameOver"));
    const over = alice.events.find((e) => e.type === "gameOver") as any;
    expect(over.winner).toBe("P2");

    ctrl.abort();
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run tests/integration.test.ts`
Expected: PASS (1 test). If it times out, check that `startCoordinator(0)` returns a server whose `.address()` has a numeric `port`.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS — game, lobby, secret-store, integration all green.

- [ ] **Step 4: Commit (optional)**

```bash
git add tests/integration.test.ts && git commit -m "test: end-to-end game over coordinator with mock brains"
```

---

### Task 10: Player app — local server, SSE bridge, job loop

**Files:**
- Create: `src/app/main.ts`

- [ ] **Step 1: Write `src/app/main.ts`**

```ts
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
  try {
    let data: JobResultData;
    if (job.payload.kind === "answer") {
      const secret = secrets.get() ?? "";
      data = { kind: "answer", ...(await brain.answer(secret, job.payload.question)) };
    } else if (job.payload.kind === "analyze") {
      data = { kind: "analyze", ...(await brain.analyze(job.payload.history)) };
    } else {
      const secret = secrets.get() ?? "";
      data = { kind: "check-guess", ...(await brain.checkGuess(secret, job.payload.guess)) };
    }
    await state.client!.postResult(state.nodeId, { jobId: job.jobId, ok: true, latencyMs: Date.now() - started, data });
  } catch (e) {
    await state.client!.postResult(state.nodeId, { jobId: job.jobId, ok: false, latencyMs: Date.now() - started, error: (e as Error).message });
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
  state.abort = new AbortController();
  state.client!.openStream(state.gameId, state.nodeId, onCoordinatorEvent, state.abort.signal).catch(() => {});
}

app.post("/local/game/create", async (_req: Request, res: Response) => {
  const { gameId, code } = await state.client!.createGame();
  state.gameId = gameId;
  await state.client!.join(code, state.nodeId);
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
  if (!process.argv.includes("--no-open")) void open(url);
});
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (It will reference `ClaudeBrain` from `./brain.js` — added in Task 11. If you run this task before Task 11, temporarily expect a type error on the dynamic import; resolve it by completing Task 11.)

- [ ] **Step 3: Commit (optional)**

```bash
git add src/app/main.ts && git commit -m "feat: player app local server + job loop"
```

---

### Task 11: Real Claude brain (Claude Agent SDK)

**Files:**
- Modify: `src/app/brain.ts` (add `ClaudeBrain`)

- [ ] **Step 1: Add `ClaudeBrain` to `src/app/brain.ts`**

Append below the existing `Brain` interface:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

// Collects the final assistant text from one Agent SDK query.
async function runClaude(prompt: string): Promise<string> {
  let text = "";
  for await (const message of query({ prompt })) {
    // The SDK emits a final "result" message with the full text. Concatenate
    // any assistant text we see; prefer the explicit result if present.
    const anyMsg = message as any;
    if (anyMsg.type === "result" && typeof anyMsg.result === "string") return anyMsg.result;
    if (anyMsg.type === "assistant" && anyMsg.message?.content) {
      for (const block of anyMsg.message.content) {
        if (block.type === "text") text += block.text;
      }
    }
  }
  return text.trim();
}

function extractJson(s: string): any {
  const match = s.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export class ClaudeBrain implements Brain {
  async answer(secret: string, question: string): Promise<{ answer: string }> {
    const out = await runClaude(
      `You are the secret-keeper in a game of 20 Questions. Your secret is "${secret}". ` +
        `Answer the following question truthfully and briefly (a yes/no plus at most one short clause). ` +
        `Never reveal or spell out the secret itself. Question: ${question}`,
    );
    return { answer: out || "I'm not sure." };
  }
  async analyze(history: { askedBy: string; question: string; answer: string }[]) {
    const lines = history.map((h) => `Q: ${h.question}\nA: ${h.answer}`).join("\n");
    const out = await runClaude(
      `You are helping a player guess the opponent's secret (a person, place, or thing) in 20 Questions. ` +
        `Here is the Q&A so far:\n${lines}\n\n` +
        `Reply with ONLY JSON of the form ` +
        `{"candidates": string[], "followups": string[], "note": string} ` +
        `where candidates are the most plausible remaining answers and followups are 2-3 strong next questions.`,
    );
    const json = extractJson(out);
    return {
      candidates: Array.isArray(json?.candidates) ? json.candidates.map(String) : [],
      followups: Array.isArray(json?.followups) ? json.followups.map(String) : [],
      note: typeof json?.note === "string" ? json.note : "",
    };
  }
  async checkGuess(secret: string, guess: string): Promise<{ correct: boolean }> {
    const out = await runClaude(
      `Your secret is "${secret}". A player guessed "${guess}". ` +
        `Is the guess correct (allow reasonable synonyms / close phrasing)? Reply with ONLY the word yes or no.`,
    );
    return { correct: /\byes\b/i.test(out) };
  }
}
```

- [ ] **Step 2: Verify the Agent SDK import shape against the installed version**

Run: `node -e "import('@anthropic-ai/claude-agent-sdk').then(m => console.log(Object.keys(m)))"`
Expected: the printed keys include `query`. If the export name or `query()` message shape differs in the installed version, adjust `runClaude` accordingly (this wrapper is the only place that touches the SDK). Confirm ambient auth works by ensuring `claude` (Claude Code) is logged in on this machine.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit (optional)**

```bash
git add src/app/brain.ts && git commit -m "feat: Claude Agent SDK brain"
```

---

### Task 12: The web UI

**Files:**
- Create: `src/app/web/index.html`
- Create: `src/app/web/app.js`

- [ ] **Step 1: Write `src/app/web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Relay — 20 Questions over a brain pool</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 820px; margin: 2rem auto; padding: 0 1rem; }
      .hidden { display: none; }
      input, button { font-size: 1rem; padding: 0.4rem 0.6rem; }
      .feed { border: 1px solid #ccc; border-radius: 8px; padding: 0.5rem; min-height: 240px; }
      .row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
      .msg { margin: 0.35rem 0; padding: 0.4rem 0.6rem; border-radius: 6px; background: #f3f3f3; }
      .who { font-size: 0.75rem; color: #666; text-transform: uppercase; letter-spacing: 0.04em; }
      .ai { background: #eef6ff; }
      #status { font-weight: 600; margin: 0.5rem 0; }
      .code { font-size: 1.5rem; letter-spacing: 0.2em; font-weight: 700; }
    </style>
  </head>
  <body>
    <h1>Relay</h1>
    <p>20 Questions where every answer runs on the <em>other</em> player's machine.</p>

    <section id="connect">
      <h2>Connect</h2>
      <p>Coordinator URL: <input id="serverUrl" placeholder="https://…" size="40" /></p>
      <p>Your name: <input id="name" placeholder="Alice" /></p>
      <button id="connectBtn">Connect</button>
    </section>

    <section id="lobby" class="hidden">
      <h2>Lobby</h2>
      <button id="createBtn">Create game</button>
      <span> or join by code: </span>
      <input id="joinCode" placeholder="ABCD" maxlength="4" />
      <button id="joinBtn">Join</button>
      <p id="codeLine" class="hidden">Share this code: <span id="code" class="code"></span></p>
    </section>

    <section id="secret" class="hidden">
      <h2>Pick your secret</h2>
      <p>Your <strong id="category">person, place, or thing</strong> — stays on this machine, never sent to the server.</p>
      <input id="secretInput" size="40" /> <button id="secretBtn">Ready</button>
    </section>

    <section id="game" class="hidden">
      <p id="status"></p>
      <div class="feed" id="feed"></div>
      <p>
        <input id="actionText" size="40" placeholder="Ask a yes/no question…" />
        <button id="askBtn">Ask</button>
        <button id="guessBtn">Guess</button>
      </p>
    </section>

    <section id="result" class="hidden">
      <h2 id="winner"></h2>
      <div id="reveals"></div>
      <button id="rematchBtn">Rematch</button>
    </section>

    <script src="/app.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `src/app/web/app.js`**

```js
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");

const me = { slot: null };

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}

function addMsg(who, text, ai) {
  const div = document.createElement("div");
  div.className = "msg" + (ai ? " ai" : "");
  div.innerHTML = `<div class="who">${who}</div>${text}`;
  $("feed").appendChild(div);
  $("feed").scrollTop = $("feed").scrollHeight;
}

function slotLabel(slot) {
  return slot === "P1" ? "Player 1" : "Player 2";
}

function setStatus(turn) {
  const yours = turn === me.slot;
  $("status").textContent = yours ? "Your turn — ask a question or make a guess." : `Waiting for ${slotLabel(turn)}…`;
  $("askBtn").disabled = !yours;
  $("guessBtn").disabled = !yours;
  $("actionText").disabled = !yours;
}

function handleEvent(e) {
  switch (e.type) {
    case "snapshot":
      if (e.snapshot.phase === "in-progress") {
        hide("secret"); show("game"); setStatus(e.snapshot.turn);
        for (const h of e.snapshot.history) addMsg(`${slotLabel(h.askedBy)}`, h.question);
      }
      break;
    case "gameStarted":
      hide("lobby"); show("secret");
      break;
    case "enterSecret":
      $("category").textContent = e.category;
      hide("game"); hide("result"); show("secret");
      break;
    case "turnChanged":
      hide("secret"); show("game"); setStatus(e.turn);
      break;
    case "questionAnswered":
      addMsg(slotLabel(e.askedBy), e.question);
      addMsg(`${slotLabel(e.answeredBySlot)} AI`, e.answer, true);
      break;
    case "analysis":
      addMsg(`${slotLabel(e.forSlot)} AI`,
        `<em>candidates:</em> ${e.candidates.join(", ") || "—"}<br><em>try:</em> ${e.followups.join(" / ") || "—"}`, true);
      break;
    case "guessResult":
      addMsg(slotLabel(e.bySlot), `guessed "${e.guess}" — ${e.correct ? "correct!" : "nope"}`);
      break;
    case "gameOver":
      hide("game"); show("result");
      $("winner").textContent = `${slotLabel(e.winner)} wins!`;
      $("reveals").innerHTML = "";
      post("/local/reveal", {});
      break;
    case "secretRevealed": {
      const p = document.createElement("p");
      p.textContent = `${slotLabel(e.slot)}'s secret was: ${e.secret}`;
      $("reveals").appendChild(p);
      break;
    }
    case "rematch":
      $("feed").innerHTML = "";
      break;
    case "playerLeft":
      $("status").textContent = `${slotLabel(e.slot)} disconnected. Return to lobby.`;
      break;
  }
}

new EventSource("/local/stream").onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (e.type !== "local") handleEvent(e);
};

$("connectBtn").onclick = async () => {
  await post("/local/connect", { serverUrl: $("serverUrl").value, name: $("name").value || "Player" });
  hide("connect"); show("lobby");
};
$("createBtn").onclick = async () => {
  const { code } = await post("/local/game/create", {});
  me.slot = "P1";
  $("code").textContent = code;
  show("codeLine");
};
$("joinBtn").onclick = async () => {
  const r = await post("/local/game/join", { code: $("joinCode").value.toUpperCase() });
  me.slot = r.slot;
};
$("secretBtn").onclick = async () => {
  await post("/local/secret", { secret: $("secretInput").value });
  $("status").textContent = "Secret set — waiting for the other player…";
  hide("secret"); show("game");
};
$("askBtn").onclick = async () => {
  await post("/local/action", { type: "ask", text: $("actionText").value });
  $("actionText").value = "";
};
$("guessBtn").onclick = async () => {
  await post("/local/action", { type: "guess", text: $("actionText").value });
  $("actionText").value = "";
};
$("rematchBtn").onclick = async () => {
  hide("result");
  await post("/local/rematch", {});
};
```

- [ ] **Step 3: Manual smoke test (mock brains, one machine)**

Run three terminals:
1. `npm run coordinator`
2. `npm run app -- --mock --port=5173`
3. `npm run app -- --mock --port=5174 --no-open`

In the first browser tab (5173): Connect to `http://localhost:8787`, name "Alice", **Create game** (note the code). Open `http://localhost:5174` manually, Connect as "Bob", **Join** with the code. Each enters a secret and clicks Ready. Take turns asking/guessing.
Expected: questions answered by the *other* player's AI appear labeled "Player N AI"; a correct guess shows the winner + revealed secrets; Rematch resets the feed.

- [ ] **Step 4: Commit (optional)**

```bash
git add src/app/web/index.html src/app/web/app.js && git commit -m "feat: web UI"
```

---

### Task 13: Real two-machine run (manual verification)

**Files:** none (verification only).

- [ ] **Step 1: Confirm Claude Code auth on both machines**

On each participant's machine, ensure Claude Code is installed and logged in (the Agent SDK uses its credentials). Quick check from Task 11, Step 2 confirms the SDK import.

- [ ] **Step 2: Expose the coordinator**

On the host: `npm run coordinator`, then in another terminal `cloudflared tunnel --url http://localhost:8787` (or use your Cloudflare One address). Note the public URL.

- [ ] **Step 3: Each participant runs the app (real brain)**

`npm run app` (no `--mock`). A browser opens; enter the coordinator's public URL + a name. One creates a game and shares the 4-letter code; the other joins.

- [ ] **Step 4: Play a full game and confirm the federation properties**

Expected:
- Each player's question is answered by the **other** player's machine (latency/logs on the opponent's `npm run app` terminal show the job running there).
- Secrets are typed only into each local UI and never appear in the coordinator's logs.
- A correct guess ends the game and both secrets are revealed.

- [ ] **Step 5: Final full-suite check**

Run: `npm test`
Expected: PASS (game, lobby, secret-store, integration).

---

## Self-Review

**Spec coverage:**
- §3 two-layer topology → Tasks 5 (coordinator) + 10 (player app). ✓
- §4 components → protocol (T2), game (T3), lobby (T4), coordinator main/relay fold-in (T5), secret-store (T6), brain+mock (T7,T11), coordinator-client (T8), app main (T10), web (T12). ✓
- §5 protocol (jobs, SSE events incl. snapshot/secretRevealed, REST, local API) → T2 + T5 + T8 + T10. ✓
- §6 game flow (lobby→waiting-ready→in-progress→over, ask/answer/analyze pipeline, guess win, reveal, rematch) → T3 + T9. ✓
- §7 brain roles (answer/analyze/check-guess; init-secret as local UI action) → T11 (brain) + T10/T12 (secret via local API/UI). ✓
- §8 UI screens (connect/lobby/secret/split-screen chat/result) → T12. ✓
- §9 distribution → T13. ✓
- §10 error handling (player-left, brain error, out-of-turn, bad URL, restart) → playerLeft (T3/T5), job error (T10), out-of-turn (T3), connect error (T10/T12). ✓
- §11 testing (game/lobby/secret guard/integration) → T3, T4, T6, T9. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to" steps; all code blocks are complete. The one external-integration caveat (Agent SDK export shape) is an explicit verification step (T11 Step 2), not a placeholder.

**Type consistency:** `ServerEvent`, `JobAssignment`, `JobResult`, `JobResultData`, `GameSnapshot`, `Effect`, `Brain` are defined once (T2/T3/T7) and used with matching field names across coordinator, client, app, and tests (`answeredBySlot`, `forSlot`, `targetNodeId`, `bySlot`, `candidates`/`followups`/`note`, `correct`). `GameRoom` method names (`addPlayer`, `markReady`, `action`, `jobResult`, `reveal`, `rematch`, `playerLeft`, `nodeIds`, `snapshot`) are consistent between definition (T3) and callers (T5). `CoordinatorClient` method names match callers in T9/T10.

**Known minor caveat:** Task 10 references `ClaudeBrain` (added in Task 11) via dynamic import; build Task 11 before relying on a non-mock run. Noted inline in T10 Step 2.
