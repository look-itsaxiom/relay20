import {
  GamePhase,
  GameSnapshot,
  JobAssignment,
  JobResult,
  NodeId,
  PlayerResult,
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
  text?: string;
}

const CATEGORY = "person, place, or thing";
const QUESTION_BUDGET = 20;

function label(slot: PlayerSlot): string {
  return slot === "P1" ? "Player 1" : "Player 2";
}

export class GameRoom {
  readonly gameId: string;
  readonly code: string;
  private readonly nextId: () => string;
  private readonly budget: number;

  phase: GamePhase = "lobby";
  players: Partial<Record<PlayerSlot, PlayerState>> = {};
  turn: PlayerSlot = "P1";
  history: QnA[] = [];
  remaining: Record<PlayerSlot, number>;
  results: Record<PlayerSlot, PlayerResult | null> = { P1: null, P2: null };

  private busy = false;
  private pending = new Map<string, PendingJob>();
  private pendingHistory?: QnA[];

  constructor(opts: { gameId: string; code: string; nextId: () => string; budget?: number }) {
    this.gameId = opts.gameId;
    this.code = opts.code;
    this.nextId = opts.nextId;
    this.budget = opts.budget ?? QUESTION_BUDGET;
    this.remaining = { P1: this.budget, P2: this.budget };
  }

  private slotOf(nodeId: NodeId): PlayerSlot | null {
    if (this.players.P1?.nodeId === nodeId) return "P1";
    if (this.players.P2?.nodeId === nodeId) return "P2";
    return null;
  }
  private opp(slot: PlayerSlot): PlayerSlot {
    return slot === "P1" ? "P2" : "P1";
  }
  private turnEvent(turn: PlayerSlot): ServerEvent {
    return { type: "turnChanged", turn, remaining: { ...this.remaining } };
  }

  addPlayer(nodeId: NodeId, name: string): Effect[] {
    if (this.players.P1 && this.players.P2) throw new Error("game full");
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
      return [{ kind: "broadcast", event: this.turnEvent("P1") }];
    }
    return [];
  }

  action(nodeId: NodeId, type: "ask" | "guess", text: string): Effect[] {
    const slot = this.slotOf(nodeId);
    if (this.phase !== "in-progress" || slot !== this.turn) {
      throw new Error("not your turn");
    }
    if (this.busy) {
      throw new Error("still resolving the previous question");
    }
    this.busy = true;
    this.remaining[slot] -= 1;
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
    const failed = !res.ok || !res.data;

    if (p.kind === "answer") {
      if (failed || res.data?.kind !== "answer") {
        return this.failAction(asker, `${label(keeperSlot)}'s AI couldn't answer: ${res.error ?? "unknown error"}`);
      }
      const answer = res.data.answer;
      this.pendingHistory = [...this.history, { askedBy: asker, question: p.text!, answer }];
      const jobId = this.nextId();
      this.pending.set(jobId, { kind: "analyze", askerSlot: asker });
      // The strategist must only see the asker's OWN line of questioning (their
      // questions about the OPPONENT's secret). The opponent's questions are about
      // the asker's own secret and would mislead the suggestions, so filter them out.
      const askerThread = this.pendingHistory.filter((q) => q.askedBy === asker);
      return [
        {
          kind: "broadcast",
          event: { type: "questionAnswered", askedBy: asker, question: p.text!, answer, answeredBySlot: keeperSlot },
        },
        {
          kind: "routeJob",
          job: { jobId, targetNodeId: this.players[asker]!.nodeId, payload: { kind: "analyze", history: askerThread } },
        },
      ];
    }

    if (p.kind === "analyze") {
      // The question was already answered; analysis is best-effort. Commit history and pass the turn either way.
      this.history = this.pendingHistory ?? this.history;
      this.pendingHistory = undefined;
      const a =
        !failed && res.data?.kind === "analyze"
          ? res.data
          : { candidates: [] as string[], followups: [] as string[], note: "(analysis unavailable)" };
      const fx: Effect[] = [
        { kind: "broadcast", event: { type: "analysis", forSlot: asker, candidates: a.candidates, followups: a.followups } },
      ];
      return [...fx, ...this.resolveTurn(asker, false)];
    }

    if (p.kind === "check-guess") {
      if (failed || res.data?.kind !== "check-guess") {
        return this.failAction(asker, `${label(keeperSlot)}'s AI couldn't check your guess: ${res.error ?? "unknown error"}`);
      }
      const correct = res.data.correct;
      return [
        { kind: "broadcast", event: { type: "guessResult", bySlot: asker, guess: p.text!, correct } },
        ...this.resolveTurn(asker, correct),
      ];
    }

    return [];
  }

  // A node's AI failed to produce a result. Refund the consumed question, clear
  // the turn-lock, keep the turn with the asker so they can retry, and surface why.
  private failAction(asker: PlayerSlot, reason: string): Effect[] {
    this.busy = false;
    this.remaining[asker] += 1;
    this.pendingHistory = undefined;
    this.turn = asker;
    return [
      { kind: "broadcast", event: { type: "actionFailed", slot: asker, reason, remaining: { ...this.remaining } } },
    ];
  }

  private resolveTurn(asker: PlayerSlot, didWin: boolean): Effect[] {
    this.busy = false;
    const fx: Effect[] = [];

    if (didWin) this.results[asker] = "won";
    else if (this.remaining[asker] <= 0) this.results[asker] = "lost";

    if (this.results[asker] !== null) {
      fx.push({
        kind: "broadcast",
        event: { type: "playerResolved", slot: asker, result: this.results[asker]!, remaining: { ...this.remaining } },
      });
    }

    const next = this.nextUnresolved(asker);
    if (next === null) {
      this.phase = "over";
      fx.push({ kind: "broadcast", event: { type: "gameOver", results: { P1: this.results.P1!, P2: this.results.P2! } } });
    } else {
      this.turn = next;
      fx.push({ kind: "broadcast", event: this.turnEvent(next) });
    }
    return fx;
  }

  private nextUnresolved(after: PlayerSlot): PlayerSlot | null {
    const order: PlayerSlot[] = [this.opp(after), after];
    for (const s of order) if (this.results[s] === null) return s;
    return null;
  }

  reveal(nodeId: NodeId, secret: string): Effect[] {
    const slot = this.slotOf(nodeId);
    if (!slot) return [];
    return [{ kind: "broadcast", event: { type: "secretRevealed", slot, secret } }];
  }

  rematch(): Effect[] {
    this.phase = "waiting-ready";
    this.history = [];
    this.results = { P1: null, P2: null };
    this.remaining = { P1: this.budget, P2: this.budget };
    this.busy = false;
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
      remaining: { ...this.remaining },
      results: { ...this.results },
    };
  }
}
