import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

export const MEMORY_FILE_MAP = Object.freeze({
  personal: "personal.md",
  family: "family.md",
  faith: "faith.md",
  amanahfy: "amanahfy-context.md",
  system: "system.md",
});

export function memoryTokensEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Register the `/memory/:name` endpoint on the given Express app.
 *
 * Gated by the `X-Wakil-Token` header, which must match the
 * `MEMORY_API_TOKEN` env var. Without the env var, the endpoint returns 503.
 *
 * Designed for cross-service file access on Railway (where volumes
 * can't be shared directly between services).
 */
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

    const filename = MEMORY_FILE_MAP[req.params.name];
    if (!filename) {
      return res.status(400).json({
        error: "Invalid memory file name",
        allowed: Object.keys(MEMORY_FILE_MAP),
      });
    }

    const filePath = path.join(workspaceDir, filename);

    try {
      const contents = await fsp.readFile(filePath, "utf8");
      res.set("Content-Type", "text/markdown; charset=utf-8");
      if (req.query.nocache) {
        res.set("Cache-Control", "no-store, no-cache, must-revalidate");
        res.set("Pragma", "no-cache");
        res.set("Expires", "0");
      } else {
        res.set("Cache-Control", "no-store");
      }
      return res.send(contents);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return res.status(404).json({
          error: "Memory file not found on disk",
          file: filename,
        });
      }
      console.error(
        "[memory endpoint] file read error:",
        error && error.message ? error.message : error,
      );
      return res.status(500).json({
        error: "File system error",
        detail: error && error.message ? error.message : String(error),
      });
    }
  });
}
