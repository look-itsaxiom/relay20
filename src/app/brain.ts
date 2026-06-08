import { QnA } from "../shared/protocol.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

export interface Brain {
  answer(secret: string, question: string): Promise<{ answer: string }>;
  analyze(history: QnA[]): Promise<{ candidates: string[]; followups: string[]; note: string }>;
  checkGuess(secret: string, guess: string): Promise<{ correct: boolean }>;
}

// Runs one Agent SDK query. When opts.stream is set, streams the answer to
// stdout live (so the operator watches their Claude produce it); always returns
// the final text. Falls back to printing the full answer once if the installed
// SDK build doesn't surface partial messages.
async function runClaude(prompt: string, opts: { stream?: boolean } = {}): Promise<string> {
  let assistantText = "";
  let resultText = "";
  let printedAny = false;
  const useStream = opts.stream === true;

  const q = useStream
    ? query({ prompt, options: { includePartialMessages: true } })
    : query({ prompt });

  for await (const message of q) {
    const m = message as any;
    if (useStream && m.type === "stream_event") {
      const delta = m.event?.delta?.text;
      if (typeof delta === "string" && delta.length) {
        if (!printedAny) {
          process.stdout.write("[claude] ");
          printedAny = true;
        }
        process.stdout.write(delta);
      }
      continue;
    }
    if (m.type === "assistant" && m.message?.content) {
      for (const block of m.message.content) {
        if (block.type === "text") assistantText += block.text;
      }
    }
    if (m.type === "result" && typeof m.result === "string") {
      resultText = m.result;
    }
  }

  const final = (resultText || assistantText).trim();
  if (useStream) {
    if (!printedAny && final) process.stdout.write(`[claude] ${final}`);
    process.stdout.write("\n");
  }
  return final;
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
      { stream: true },
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
      { stream: true },
    );
    return { correct: /\byes\b/i.test(out) };
  }
}
