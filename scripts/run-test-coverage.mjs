#!/usr/bin/env node
/**
 * Runs `vitest run --coverage`, strips the "Uncovered Line #s" column from the
 * Istanbul text table on stdout, forwards stderr unchanged, and exits with
 * Vitest's exit code.
 */

import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function stripLastColumn(line) {
  if (line.includes(" | ")) {
    const parts = line.split(" | ");
    if (parts.length === 6) {
      return parts.slice(0, 5).join(" | ");
    }
    return line;
  }

  const trimmed = line.trimEnd();
  if (/^[\s\-|]+$/.test(trimmed) && trimmed.includes("|")) {
    const parts = trimmed.split("|");
    if (parts.length === 6) {
      return parts.slice(0, 5).join("|");
    }
  }

  return line;
}

function pipeStrip(readable, writable) {
  const rl = readline.createInterface({ input: readable, crlfDelay: Infinity });
  rl.on("line", (line) => {
    writable.write(`${stripLastColumn(line)}\n`);
  });
  return new Promise((resolve) => {
    rl.on("close", resolve);
  });
}

const vitest = spawn(
  process.execPath,
  [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--coverage"],
  {
    cwd: root,
    stdio: ["inherit", "pipe", "pipe"],
    env: process.env,
  }
);

const outDone = pipeStrip(vitest.stdout, process.stdout);
vitest.stderr.pipe(process.stderr);

vitest.on("close", async (code) => {
  await outDone;
  process.exit(code ?? 1);
});
