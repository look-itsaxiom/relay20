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
