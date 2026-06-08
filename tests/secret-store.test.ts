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
