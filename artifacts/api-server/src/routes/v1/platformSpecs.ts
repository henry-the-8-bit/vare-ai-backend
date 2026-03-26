import { Router, type IRouter, type Request, type Response } from "express";
import { distributionService } from "../../services/distribution/distributionService.js";
import type { DistributionPlatform } from "../../services/distribution/types.js";

const router: IRouter = Router({ mergeParams: true });

/**
 * Vare-wide platform spec endpoints.
 *
 * These serve the specs/tool declarations that AI platforms use to understand
 * how to call the Vare catalog API. They are NOT per-merchant — Vare manages
 * one integration per platform. The specs use {merchant_slug} as a path
 * parameter so platforms can route to any merchant's catalog.
 *
 * These are public endpoints (no auth) so platforms can fetch them during setup.
 */

function serveSpec(_req: Request, res: Response, platform: DistributionPlatform) {
  try {
    const spec = distributionService.getSpec(platform);
    res.status(200).json(spec.content);
  } catch {
    res.status(404).json({ error: `Spec not available for platform: ${platform}` });
  }
}

// GET /api/v1/platforms/chatgpt/openapi.json
router.get("/chatgpt/openapi.json", (req, res) => serveSpec(req, res, "chatgpt"));

// GET /api/v1/platforms/gemini/tools.json
router.get("/gemini/tools.json", (req, res) => serveSpec(req, res, "gemini"));

// GET /api/v1/platforms/perplexity/feed.json
router.get("/perplexity/feed.json", (req, res) => serveSpec(req, res, "perplexity"));

export default router;
