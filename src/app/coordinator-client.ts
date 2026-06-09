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
  async postResult(nodeId: string, result: JobResult) {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.post(`/jobs/${result.jobId}/result`, { ...result, nodeId });
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
    throw lastErr;
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
