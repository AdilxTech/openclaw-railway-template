import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

// Legacy monolith filenames — used as fallback if per-entry dir is absent.
export const MEMORY_FILE_MAP = Object.freeze({
  personal: "personal.md",
  family: "family.md",
  faith: "faith.md",
  amanahfy: "amanahfy-context.md",
  trading: "trading.md",
  system: "system.md",
  "productivity-bot": "productivity-bot.md",
});

const ENTRY_SEPARATOR = "\n\n---\n\n";

export function memoryTokensEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Read a pillar's memory content.
 *
 * Prefers per-entry layout: <workspaceDir>/memory/<pillar>/*.md, sorted desc by
 * filename (newest first), concatenated with `---` separators.
 *
 * Falls back to legacy monolith <workspaceDir>/<pillar>.md if the per-entry
 * directory is absent. This lets us deploy code before migrating the volume.
 *
 * Throws an Error with code === "ENOENT" if neither location yields content.
 */
async function readPillarContent(workspaceDir, pillarKey) {
  const entryDir = path.join(workspaceDir, "memory", pillarKey);

  let entries;
  try {
    entries = await fsp.readdir(entryDir);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      // No per-entry dir — fall back to legacy monolith.
      const legacyFile = MEMORY_FILE_MAP[pillarKey];
      const legacyPath = path.join(workspaceDir, legacyFile);
      const content = await fsp.readFile(legacyPath, "utf8");
      return { content, source: "legacy_monolith", entryCount: 1 };
    }
    throw error;
  }

  const mdFiles = entries
    .filter((name) => name.endsWith(".md"))
    .sort()
    .reverse();

  if (mdFiles.length === 0) {
    const err = new Error("No .md entries in memory directory");
    err.code = "ENOENT";
    throw err;
  }

  const reads = await Promise.all(
    mdFiles.map((name) => fsp.readFile(path.join(entryDir, name), "utf8")),
  );

  const content =
    reads
      .map((s) => s.trim())
      .filter(Boolean)
      .join(ENTRY_SEPARATOR) + "\n";

  return { content, source: "per_entry_dir", entryCount: mdFiles.length };
}

export function registerMemoryRoutes(app, { workspaceDir }) {
  if (typeof workspaceDir !== "string" || !workspaceDir) {
    throw new TypeError("registerMemoryRoutes: workspaceDir is required");
  }

  app.get("/memory/:name", async (req, res) => {
    const expectedToken = process.env.MEMORY_API_TOKEN;
    if (!expectedToken) {
      return res.status(503).json({
        error: "MEMORY_API_TOKEN not configured on OpenClaw service",
      });
    }

    const providedToken = req.get("X-Wakil-Token");
    if (!providedToken || !memoryTokensEqual(providedToken, expectedToken)) {
      return res
        .status(401)
        .json({ error: "Invalid or missing X-Wakil-Token" });
    }

    if (!MEMORY_FILE_MAP[req.params.name]) {
      return res.status(400).json({
        error: "Invalid memory file name",
        allowed: Object.keys(MEMORY_FILE_MAP),
      });
    }

    try {
      const { content } = await readPillarContent(
        workspaceDir,
        req.params.name,
      );
      res.set("Content-Type", "text/markdown; charset=utf-8");
      if (req.query.nocache) {
        res.set("Cache-Control", "no-store, no-cache, must-revalidate");
        res.set("Pragma", "no-cache");
        res.set("Expires", "0");
      } else {
        res.set("Cache-Control", "no-store");
      }
      return res.send(content);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return res.status(404).json({
          error: "Memory not found",
          pillar: req.params.name,
        });
      }
      console.error(
        "[memory endpoint] read error:",
        error && error.message ? error.message : error,
      );
      return res.status(500).json({
        error: "File system error",
        detail: error && error.message ? error.message : String(error),
      });
    }
  });
}
