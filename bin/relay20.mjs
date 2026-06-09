#!/usr/bin/env node
// Entry for `npx github:look-itsaxiom/relay20`. Registers the tsx loader
// IN-PROCESS (via a static import that resolves tsx relative to THIS package,
// not the user's cwd), then runs the TypeScript player-app entry. This avoids
// the `--import tsx` cwd-resolution trap that broke npx on a fresh machine.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
register();
await import(pathToFileURL(join(root, "src", "app", "main.ts")).href);
