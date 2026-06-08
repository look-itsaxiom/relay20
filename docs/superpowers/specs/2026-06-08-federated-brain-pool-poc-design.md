# Federated Brain-Pool POC — Design

**Date:** 2026-06-08
**Status:** design contract (awaiting user review)
**Working title:** `relay` (placeholder — rename freely; avoids collision with the user's `open-hive` project)

## 1. Purpose

Prove, in the smallest convincing form, one architecture idea extracted from the
`ai-vtt` (Aether) project: **a stateless coordinator that owns no AI compute,
plus a self-registering pool of participant-owned "brain nodes," where one
participant's action triggers LLM compute on another participant's machine.**

The proof vehicle is a 2-player game of **20 Questions** ("person, place, or
thing") with a twist that makes the federation load-bearing rather than
decorative: each player picks a *secret* that is stored **only on their own
machine** and never sent to the coordinator. So the coordinator is **provably
incapable** of answering a question — it has no secret and no LLM, and must route
the work to the opponent's node. The humans pick the secrets, so it is genuinely
player-A-vs-player-B, mediated by their agents.

This is a demonstration, not a product. It is deliberately scoped so it isolates
the federation mechanism. The real destination for the concept is the user's
`open-hive` project; this POC validates the idea first.

## 2. Goals / Non-goals

**Goals**
- Running one script gives a participant a full local game UI *and* registers
  their authenticated Claude into a shared pool ("the mechanism itself").
- An action from participant A executes the Claude Agent SDK on participant B's
  machine, and vice versa ("your request runs on my agent").
- **Both** nodes do real work every turn (keeper answers + strategist analyzes).
- Human-vs-human: each **human** picks their own secret in the UI; it stays on
  their machine.
- Trivially distributable: a coworker on a different network joins by running one
  script and typing in the server URL + a game code — **no networking setup**, no
  inbound connections.
- Runnable token-free for development/CI via a mock brain.

**Non-goals**
- Persistence / a database (in-memory; restart resets lobby + games).
- Auth/security beyond the join-by-code and an optional shared server token.
- >2 players, load balancing, capability-aware routing.
- A native/desktop app or any heavy frontend build step.
- Reconnect-resume of an in-progress game.

## 3. Architecture — two layers

```
   participant A's machine                      participant B's machine
 ┌───────────────────────────┐               ┌───────────────────────────┐
 │  browser tab (UI)          │               │  browser tab (UI)          │
 │     │  localhost only      │               │     │  localhost only      │
 │     ▼                      │               │     ▼                      │
 │  PLAYER APP (one script)   │               │  PLAYER APP (one script)   │
 │  • serves UI on localhost  │               │  • serves UI on localhost  │
 │  • brain node (Claude SDK) │               │  • brain node (Claude SDK) │
 │  • holds A's secret LOCALLY │               │  • holds B's secret LOCALLY │
 │  • 1 outbound conn ───────┐│               │┌─────── 1 outbound conn     │
 └───────────────────────────┘│               ││                            │
                              ▼ SSE in / POST out                           ▼
                       ┌──────────────────────────────────────────────────────┐
                       │  COORDINATOR (remote server)                          │
                       │  • lobby / matchmaking (create + join-by-code)        │
                       │  • shared PUBLIC game state (turns, chat feed, win)   │
                       │  • routes jobs between the two nodes; relays events   │
                       │  NO secrets. NO LLM calls.                            │
                       └──────────────────────────────────────────────────────┘
                          exposed via Cloudflare Tunnel / CF One address
```

Two communication hops:
- **browser ↔ player app:** localhost, same machine — no networking concerns. The
  secret only ever travels this hop.
- **player app ↔ coordinator:** one long-lived **SSE** stream for events+jobs
  *in*, plain `POST`s *out*. Entirely outbound from the app, so it works
  identically over the open internet and a Cloudflare One overlay, with no
  inbound/port-forwarding. Only public data (questions, answers, turn/win state)
  crosses this hop.

The coordinator is the only thing that needs a reachable URL (via tunnel / CF
One address). Each player app is otherwise self-contained.

## 4. Components

Single TypeScript package (Node 22), two runnable entry points. No monorepo
tooling.

```
relay/
├── package.json            # scripts: coordinator, app; bin: relay-app
├── tsconfig.json
├── src/
│   ├── shared/
│   │   └── protocol.ts     # all wire types (coordinator API + SSE events + local API)
│   ├── coordinator/
│   │   ├── main.ts         # HTTP entry: REST + per-game SSE
│   │   ├── lobby.ts        # create/join-by-code, ready-up (PURE-ish)
│   │   ├── game.ts         # 20-questions game state machine (PURE)
│   │   └── relay.ts        # job routing + SSE fan-out to the two players
│   └── app/
│       ├── main.ts         # entry: start local UI server, open browser
│       ├── coordinator-client.ts # register, SSE-subscribe, POST actions/results
│       ├── brain.ts        # Claude Agent SDK calls per job kind
│       ├── mock-brain.ts   # canned responses for --mock
│       ├── secret-store.ts # in-process (optionally local file); never transmitted
│       └── web/
│           ├── index.html  # lobby + secret entry + split-screen chat + result
│           └── app.js       # vanilla JS: talks to localhost only
└── docs/superpowers/specs/…
```

- **coordinator (`src/coordinator`)** — remote. Owns the lobby, the per-game state
  machine, job routing between the two nodes, and SSE fan-out. Holds no secrets
  and never calls an LLM. The whole demo's punchline lives here: *it cannot
  answer a question; it can only route.*
- **player app (`src/app`)** — the distributable piece each participant runs. One
  process that: serves the UI on localhost and opens the browser; registers its
  node with the coordinator and holds a single SSE connection; runs job requests
  (answer / analyze / check-guess) via the Claude Agent SDK
  (`@anthropic-ai/claude-agent-sdk`) on ambient Claude Code auth; stores this
  participant's secret locally. `--mock` swaps the Claude call for deterministic
  canned text.
- **UI (`src/app/web`)** — static page served by the player app. Talks only to
  localhost. Screens: connect → lobby → secret entry → split-screen chat → result.

**HTTP library:** a minimal one (Express, or Hono via `@hono/node-server`) for
both the coordinator and the app's local server. SSE is a plain held-open
`text/event-stream` response.

## 5. Wire protocol & data model

Types live in `src/shared/protocol.ts`.

```ts
type NodeId = string;        // coordinator-assigned on register
type PlayerSlot = "P1" | "P2";

interface NodeInfo { nodeId: NodeId; name: string; }

// A unit of work the coordinator routes to ONE specific node.
type JobKind = "answer" | "analyze" | "check-guess";
interface JobAssignment {
  jobId: string;
  targetNodeId: NodeId;
  kind: JobKind;
  payload:
    | { kind: "answer"; question: string }        // keeper uses its LOCAL secret
    | { kind: "analyze"; history: QnA[] }          // strategist; no secret
    | { kind: "check-guess"; guess: string };      // keeper uses its LOCAL secret
}
interface QnA { askedBy: PlayerSlot; question: string; answer: string; }

interface JobResult {
  jobId: string; ok: boolean; latencyMs: number;
  data:                                            // shape per kind:
    | { answer: string }
    | { candidates: string[]; followups: string[]; note: string }
    | { correct: boolean };
}
```

**Coordinator REST (app → coordinator, all outbound POSTs):**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/register` | `{name}` → `{nodeId}`. |
| `POST` | `/games` | host creates a game → `{gameId, code}`. |
| `POST` | `/games/join` | `{code, nodeId}` → `{gameId, slot}`. |
| `POST` | `/games/:id/ready` | `{nodeId}` — sent after the local human has entered+stored their secret. |
| `POST` | `/games/:id/action` | `{nodeId, type:"ask"|"guess", text}` — validated against whose turn it is. |
| `POST` | `/games/:id/reveal` | `{nodeId, secret}` — sent **only at game over**, so the recap can show both secrets. |
| `POST` | `/jobs/:jobId/result` | a `JobResult`. |

**Coordinator → app (SSE, `GET /games/:id/stream?nodeId=…`):** one stream per
player carrying both control events and job assignments addressed to that node:
`playerJoined`, `bothReady`/`gameStarted`, `enterSecret`, `jobAssigned`
(a `JobAssignment` — the app runs it iff `targetNodeId === myNodeId`),
`questionAnswered` `{askedBy, question, answer, answeredBySlot}`, `analysis`
`{forSlot, candidates, followups}`, `guessResult`, `turnChanged`, `gameOver`
`{winner, secrets}`, `rematch`, `playerLeft`.

**App local API (browser → player app, localhost only):**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/local/connect` | `{serverUrl, name}` → app registers with the coordinator. |
| `POST` | `/local/game/create` / `/local/game/join` | proxied lobby actions. |
| `POST` | `/local/secret` | `{secret}` → stored in `secret-store` locally, then app POSTs `ready`. **Never forwarded to the coordinator.** |
| `POST` | `/local/action` | `{type, text}` → proxied to coordinator `/action`. |
| `GET`  | `/local/stream` | SSE the UI subscribes to; the app mirrors coordinator events here (minus anything secret). |

## 6. Game flow / state machine (`coordinator/game.ts`, pure)

States: `lobby → waiting-ready → in-progress → over`.

1. **lobby** — host `POST /games` → code; guest `POST /games/join` with the code.
   When both nodes are in the game → `waiting-ready`; coordinator emits
   `gameStarted` + `enterSecret` to both.
2. **waiting-ready** — each app's UI prompts its human for a secret ("person,
   place, or thing"). The secret is POSTed to the **local** app
   (`/local/secret`), stored locally, and the app POSTs `ready`. When both are
   ready → `in-progress`, turn = P1.
3. **in-progress** — repeat until a win. The current player (asker) acts via
   `/action`; the opponent's node is **keeper**, the asker's own node is
   **strategist** (roles swap with the turn):
   - **ask** `Q`:
     1. coordinator routes a `jobAssigned`(answer, `Q`) to the **opponent's** node
        (keeper); it answers truthfully from its local secret without revealing
        it → `questionAnswered`.
     2. coordinator routes a `jobAssigned`(analyze, history) to the **asker's own**
        node (strategist) → `analysis` (candidates + follow-ups for the asker).
     3. append to public history; `turnChanged` → opponent.
   - **guess** `G`:
     1. coordinator routes a `jobAssigned`(check-guess, `G`) to the opponent's
        node (keeper); it compares against its local secret → `{correct}`.
     2. correct → **the keeper's AI has confirmed the guess** → `gameOver`
        (asker wins); wrong → `guessResult`, `turnChanged` → opponent.
4. **over** — both apps `POST /games/:id/reveal` their secrets so the recap shows
   them; coordinator emits `gameOver {winner, secrets}`. UI offers **rematch**
   (new secrets, same two players → back to `waiting-ready`) or **back to lobby**.

The per-turn answer→analyze pipeline guarantees both nodes work every turn and
that keeper/strategist roles swap with the turn.

## 7. Player-app brain (`src/app/brain.ts`)

The app holds one piece of local state in `secret-store`: `mySecret: string |
null`, set by the **local human via the UI** (never transmitted to the
coordinator) and read by `answer` / `check-guess`. The three job kinds each map
to one `query()` call against the Claude Agent SDK; prompt sketches:

- **answer** — *"Your secret is `{mySecret}`. Answer this yes/no question
  truthfully and briefly. Do NOT reveal the secret itself, only answer the
  question. Question: {question}"* → `{answer}`.
- **analyze** — *"Here is the Q&A history for guessing the opponent's secret:
  {history}. List the most plausible remaining candidates and suggest 2-3 strong
  follow-up questions."* → `{candidates, followups, note}`. (No secret involved.)
- **check-guess** — *"Your secret is `{mySecret}`. Is the guess `{guess}` correct
  (allow reasonable synonyms)? Answer yes or no."* → `{correct}`.

App loop: on each SSE `jobAssigned` event addressed to my node, run `brain[kind]`
(or `mockBrain[kind]` under `--mock`) and `POST /jobs/:id/result`. Secret entry,
lobby, and actions are driven by the UI via the local API.

## 8. UI (`src/app/web`)

Static page, vanilla JS, served by the player app on localhost; talks only to the
local API + a local SSE stream. Screens:
- **Connect** — enter the coordinator URL + a display name.
- **Lobby** — "create game" (shows a code to share) or "join by code"; shows when
  the second player connects and a "ready" control.
- **Secret entry** — prompt for your "person, place, or thing." Submitting POSTs
  it to localhost only; the screen makes clear it stays on this machine.
- **Split-screen chat** — the running feed with four labeled speakers:
  **Player 1**, **Player 2** (the humans' questions/guesses) and **Player 1 AI**,
  **Player 2 AI** (keeper answers + strategist analyses), each clearly attributed
  to the machine that produced it. Input enabled only on your turn (ask / guess).
- **Result** — winner banner with both now-revealed secrets; **rematch** or
  **back to lobby**.

## 9. Distribution / running

- **Host the coordinator (you):** `npm run coordinator` → `cloudflared tunnel
  --url http://localhost:PORT` (or your CF One address). Share the URL.
- **Each participant:** `npx relay-app` (or, pre-publish, `git clone … && npm i &&
  npm run app`). A browser tab opens to the local UI; they enter the coordinator
  URL, then create/join a game by code.
- **Local-only smoke test:** run the coordinator + two app instances (different
  local ports, optionally `--mock`) and two browser tabs on one machine.

Auth: the app uses the machine's logged-in Claude Code (the Claude Agent SDK
resolves it the way `ai-vtt`'s `node/providers/claude.ts` already does). The
exact resolution path (logged-in `claude` CLI session vs. `CLAUDE_CODE_OAUTH_TOKEN`)
is confirmed during implementation; no API key is passed around.

## 10. Error handling & edge cases

- **Player app disconnects (SSE drops / process exits):** coordinator detects the
  closed stream, marks the player gone, emits `playerLeft`. Because that machine
  held its secret, the game cannot continue — the other UI shows "opponent
  disconnected; return to lobby." (An honest consequence of secrets living on the
  edge, not a bug to hide.)
- **Brain/SDK error on a node:** the app posts `{ok:false}`; coordinator retries
  the job once to the same node, then surfaces a turn error; the asker retries.
- **Action out of turn / malformed:** `/action` rejects with a clear message; the
  UI disables input off-turn anyway.
- **Bad coordinator URL / unreachable:** the connect screen surfaces the failure
  and lets the user retry.
- **Coordinator restart:** in-memory lobby + games clear; apps' SSE streams drop;
  UIs return to the connect/lobby screen and re-register.

## 11. Testing strategy

- **Unit (TDD):**
  - `coordinator/game.ts` — turn alternation, keeper/strategist role assignment
    per turn, win on keeper-confirmed guess, illegal-action rejection. Pure.
  - `coordinator/lobby.ts` — create/join-by-code, two-player cap, ready-up gate.
  - `app/secret-store.ts` — set/get; assert the secret is never included in any
    payload sent to the coordinator (guard test).
- **Integration:** start the coordinator + two app instances with `--mock` brains
  in-process; drive a scripted game (create, join, ready, ask, analyze, guess);
  assert the right node is targeted per job, events fan out to both players in
  order, and a keeper-confirmed guess ends the game. Deterministic + token-free.
- **Manual:** the real two-machine run over a tunnel, plus the local two-tab run.

## 12. Build sequence

1. `shared/protocol.ts` — lock the wire + local API types first.
2. `coordinator/lobby.ts` + `coordinator/game.ts` + tests (pure state machines).
3. `coordinator/relay.ts` + `coordinator/main.ts` — REST + per-game SSE.
4. `app/secret-store.ts` (+ guard test) and `app/coordinator-client.ts`.
5. `app/mock-brain.ts` + `app/main.ts` — local UI server, SSE bridge, register,
   job loop against the coordinator; integration test with two mock apps.
6. `app/web` — connect → lobby → secret → split-screen chat → result; manual
   playthrough with mock brains.
7. `app/brain.ts` — real Claude Agent SDK calls; confirm ambient auth.
8. Tunnel + two-machine manual test.

## 13. Scope / YAGNI

In: 2 players, join-by-code lobby, in-memory state, outbound-only app↔coordinator
(SSE + POST), local UI + local secret store, two-stage per-turn pipeline, mock
brain, rematch. Out: DB/persistence, >2 players, accounts/auth beyond a code,
load balancing, capability routing, reconnect-resume, native packaging.

## 14. Open items

- **Name.** `relay` is a placeholder. Pick a final name before publishing the
  player-app package (must not collide with `open-hive`).
- **Git.** The project directory is not yet a git repo, so this design document
  is not committed. Initialize git (and commit the spec) when ready.
