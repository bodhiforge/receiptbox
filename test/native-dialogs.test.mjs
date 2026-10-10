import assert from "node:assert/strict";
import {readdir,readFile} from "node:fs/promises";
import test from "node:test";

// Some in-app browsers suppress confirm(), alert() and prompt(); they return at once and the action silently does nothing.
test("the web app uses its own dialogs, not native confirm, alert or prompt", async () => {
  const dir = new URL("../public/", import.meta.url);
  for (const name of (await readdir(dir)).filter(n => /\.m?js$/.test(n))) {
    const code = (await readFile(new URL(name, dir), "utf8")).replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /(?<![\w.$])(?:window\.)?(?:confirm|alert|prompt)\(/, name);
  }
});
