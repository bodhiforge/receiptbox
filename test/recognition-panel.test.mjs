import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

test("recognition panel attaches button handlers after its last innerHTML append", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderRecognition(){");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  const lastAppend = body.lastIndexOf("panel.innerHTML+=");
  const firstHandler = body.indexOf(".onclick=");
  assert.ok(start >= 0 && lastAppend >= 0 && firstHandler >= 0);
  // innerHTML+= reparses the panel and drops handlers attached before it.
  assert.ok(lastAppend < firstHandler, "a panel.innerHTML+= runs after a click handler is attached");
});
