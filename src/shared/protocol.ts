export type NodeId = string;
export type PlayerSlot = "P1" | "P2";
export type PlayerResult = "won" | "lost";
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
  remaining: Record<PlayerSlot, number>;
  results: Record<PlayerSlot, PlayerResult | null>;
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
  | { type: "turnChanged"; turn: PlayerSlot; remaining: Record<PlayerSlot, number> }
  | { type: "gameOver"; results: Record<PlayerSlot, PlayerResult> }
  | { type: "playerResolved"; slot: PlayerSlot; result: PlayerResult; remaining: Record<PlayerSlot, number> }
  | { type: "actionFailed"; slot: PlayerSlot; reason: string; remaining: Record<PlayerSlot, number> }
  | { type: "secretRevealed"; slot: PlayerSlot; secret: string }
  | { type: "rematch" }
  | { type: "playerLeft"; slot: PlayerSlot };
