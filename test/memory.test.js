import { after, before, describe, test } from "node:test";
import { strict as assert } from "node:assert";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import express from "express";
import {
  MEMORY_FILE_MAP,
  memoryTokensEqual,
  registerMemoryRoutes,
} from "../src/memoryRoutes.js";

const TOKEN = "test-token-123";

describe("/memory/:name route", () => {
  let dir;
  let server;
  let baseUrl;
  let savedToken;

  before(async () => {
    savedToken = process.env.MEMORY_API_TOKEN;
    process.env.MEMORY_API_TOKEN = TOKEN;

    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wakil-mem-"));
    const app = express();
    registerMemoryRoutes(app, { workspaceDir: dir });

    await new Promise((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(dir, { recursive: true, force: true });
    if (savedToken === undefined) delete process.env.MEMORY_API_TOKEN;
    else process.env.MEMORY_API_TOKEN = savedToken;
  });

  async function get(urlPath, headers = {}) {
    return fetch(`${baseUrl}${urlPath}`, { headers });
  }

  test("valid token + existing file → 200 text/markdown with body", async () => {
    await fsp.writeFile(path.join(dir, "personal.md"), "# personal notes\n", "utf8");
    const res = await get("/memory/personal", { "X-Wakil-Token": TOKEN });
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("content-type"),
      "text/markdown; charset=utf-8",
    );
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(await res.text(), "# personal notes\n");
  });

  test("amanahfy reads amanahfy-context.md (path mapping)", async () => {
    await fsp.writeFile(path.join(dir, "amanahfy-context.md"), "# biz", "utf8");
    await fsp.writeFile(path.join(dir, "amanahfy.md"), "should not be served", "utf8");
    const res = await get("/memory/amanahfy", { "X-Wakil-Token": TOKEN });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "# biz");
  });

  test("family / faith / system map to their .md files", async () => {
    for (const [urlName, fileName] of Object.entries({
      family: "family.md",
      faith: "faith.md",
      system: "system.md",
    })) {
      await fsp.writeFile(path.join(dir, fileName), `content-${urlName}`, "utf8");
      const res = await get(`/memory/${urlName}`, { "X-Wakil-Token": TOKEN });
      assert.equal(res.status, 200, `${urlName} status`);
      assert.equal(await res.text(), `content-${urlName}`);
    }
  });

  test("invalid token → 401", async () => {
    const res = await get("/memory/personal", { "X-Wakil-Token": "wrong" });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.error, /invalid or missing/i);
  });

  test("missing X-Wakil-Token header → 401", async () => {
    const res = await get("/memory/personal");
    assert.equal(res.status, 401);
  });

  test("valid token but invalid name → 400 with allowed list", async () => {
    const res = await get("/memory/nonsense", { "X-Wakil-Token": TOKEN });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /invalid/i);
    assert.deepEqual(
      body.allowed.sort(),
      ["amanahfy", "faith", "family", "personal", "system"],
    );
  });

  test("valid token + missing file on disk → 404", async () => {
    // Earlier tests may have populated this file in the shared dir; remove it
    // explicitly so we're testing the ENOENT branch.
    await fsp.rm(path.join(dir, "faith.md"), { force: true });
    const res = await get("/memory/faith", { "X-Wakil-Token": TOKEN });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.error, /not found/i);
    assert.equal(body.file, "faith.md");
  });
});

describe("/memory/:name without MEMORY_API_TOKEN configured", () => {
  let dir;
  let server;
  let baseUrl;
  let savedToken;

  before(async () => {
    savedToken = process.env.MEMORY_API_TOKEN;
    delete process.env.MEMORY_API_TOKEN;

    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wakil-mem-"));
    const app = express();
    registerMemoryRoutes(app, { workspaceDir: dir });

    await new Promise((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(dir, { recursive: true, force: true });
    if (savedToken === undefined) delete process.env.MEMORY_API_TOKEN;
    else process.env.MEMORY_API_TOKEN = savedToken;
  });

  test("returns 503 regardless of request token", async () => {
    const res = await fetch(`${baseUrl}/memory/personal`, {
      headers: { "X-Wakil-Token": "anything" },
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /not configured/i);
  });
});

describe("memoryTokensEqual helper", () => {
  test("equal same-length strings → true", () => {
    assert.equal(memoryTokensEqual("abc", "abc"), true);
  });
  test("different same-length strings → false", () => {
    assert.equal(memoryTokensEqual("abc", "abd"), false);
  });
  test("different-length strings → false", () => {
    assert.equal(memoryTokensEqual("abc", "abcd"), false);
  });
  test("non-string inputs → false", () => {
    assert.equal(memoryTokensEqual(null, "abc"), false);
    assert.equal(memoryTokensEqual("abc", undefined), false);
    assert.equal(memoryTokensEqual(123, 123), false);
  });
});

describe("MEMORY_FILE_MAP shape", () => {
  test("has the five expected keys", () => {
    assert.deepEqual(
      Object.keys(MEMORY_FILE_MAP).sort(),
      ["amanahfy", "faith", "family", "personal", "system"],
    );
  });
  test("amanahfy explicitly points at amanahfy-context.md", () => {
    assert.equal(MEMORY_FILE_MAP.amanahfy, "amanahfy-context.md");
  });
});
