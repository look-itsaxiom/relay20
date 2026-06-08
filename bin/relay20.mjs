#!/usr/bin/env node
// Entry point for `npx github:look-itsaxiom/relay20` — launches the player app
// (local game UI + this machine's Claude brain node) using the bundled tsx runtime.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appEntry = join(root, "src", "app", "main.ts");

const child = spawn(process.execPath, ["--import", "tsx", appEntry, ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("Failed to launch relay20:", err.message);
  process.exit(1);
});
