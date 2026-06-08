import { QnA } from "../shared/protocol.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

export interface Brain {
  answer(secret: string, question: string): Promise<{ answer: string }>;
  analyze(history: QnA[]): Promise<{ candidates: string[]; followups: string[]; note: string }>;
  checkGuess(secret: string, guess: string): Promise<{ correct: boolean }>;
}

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
