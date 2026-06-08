# relay20

A 2-player game of **20 Questions** where every question you ask is answered by the **other player's own AI** — a working demo of a *federated brain pool*: a stateless coordinator that owns no AI and no secrets, plus participant-run nodes that each contribute their own authenticated Claude.

Your secret never leaves your machine. The coordinator literally cannot answer a question — it has no LLM and no secret — so it must route the work to your opponent's node. That's the whole point.

## How it works

```
  player A's machine                         player B's machine
  ┌───────────────────┐                      ┌───────────────────┐
  │ browser UI         │  localhost          │ browser UI         │
  │ player app:        │                      │ player app:        │
  │  • serves the UI   │                      │  • serves the UI   │
  │  • Claude node     │                      │  • Claude node     │
  │  • holds A's secret│                      │  • holds B's secret│
  └─────────┬──────────┘                      └─────────┬──────────┘
            │  SSE in / POST out (outbound only)        │
            └───────────────┬───────────────────────────┘
                            ▼
                ┌───────────────────────────┐
                │ coordinator (this repo)    │
                │  lobby + game state +      │
                │  job routing. NO LLM.      │
                │  NO secrets.               │
                └───────────────────────────┘
```

Each turn: you ask a question → it runs on your **opponent's** node (the secret-keeper) → then your **own** node analyzes the answer and suggests follow-ups. Both machines work every turn. Each player has 20 questions; guess correctly to win, run out to lose — outcomes are independent, so you can both win, both lose, or split.

## Prerequisites

- **Node 22** (the app runs TypeScript via `tsx`).
- An **authenticated Claude Code** on each player's machine — the brain node uses its ambient credentials (no API key needed). Or run with `--mock` for a token-free demo with a deterministic fake brain.

## Run the coordinator

The coordinator is stateless and in-memory. Run it locally:

```bash
npm install
npm run coordinator      # listens on :8787 (override with PORT)
```

…or in a container (e.g. on a homelab):

```bash
docker compose up -d     # coordinator on :8787, restart: unless-stopped
```

Expose `:8787` however you publish services so remote players can reach it.

## Run a player (client)

On each player's machine:

```bash
npm install
npm run app              # opens a local browser UI; add --mock for no-LLM mode
```

In the UI: enter the coordinator's URL + your name → one player **Create game** (shares the 4-letter code), the other **Join** with it → each picks a secret (stays local) and clicks Ready → take turns asking and guessing.

## Layout

- `src/coordinator/` — the coordinator: `game.ts` (pure state machine), `lobby.ts` (join-by-code), `main.ts` (HTTP + SSE).
- `src/app/` — the player app: local UI server, Claude brain node, local secret store, coordinator client.
- `src/shared/protocol.ts` — the wire types.
- `docs/superpowers/` — the design spec and implementation plan.

## Tests

```bash
npm test        # pure game/lobby logic + an end-to-end coordinator integration test
```

## Note (Windows + nvm)

If `node -v` shows an old version, prepend the Node 22 directory to `PATH` for the session:

```powershell
$env:Path = "C:\Users\<you>\AppData\Local\nvm\v22.22.1;" + $env:Path
```
