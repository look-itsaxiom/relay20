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
