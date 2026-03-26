import { Router, type IRouter, type Request, type Response } from "express";
import { distributionService } from "../../services/distribution/distributionService.js";
import { errorResponse } from "../../lib/response.js";
import type { DistributionPlatform } from "../../services/distribution/types.js";

const router: IRouter = Router({ mergeParams: true });

function getParam(req: Request, key: string): string | undefined {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

async function serveSpec(req: Request, res: Response, platform: DistributionPlatform) {
  const slug = getParam(req, "merchant_slug");
  if (!slug) {
    errorResponse(res, "Missing merchant slug", "BAD_REQUEST", 400);
    return;
  }

  const spec = await distributionService.getSpecBySlugAndPlatform(slug, platform);
  if (!spec) {
    errorResponse(res, `No active ${platform} connection found for this merchant`, "NOT_FOUND", 404);
    return;
  }

  res.status(200).json(spec.content);
}

// GET /api/v1/merchants/:merchant_slug/platforms/chatgpt/openapi.json
router.get("/platforms/chatgpt/openapi.json", (req, res) => serveSpec(req, res, "chatgpt"));

// GET /api/v1/merchants/:merchant_slug/platforms/gemini/tools.json
router.get("/platforms/gemini/tools.json", (req, res) => serveSpec(req, res, "gemini"));

// GET /api/v1/merchants/:merchant_slug/platforms/perplexity/feed.json
router.get("/platforms/perplexity/feed.json", (req, res) => serveSpec(req, res, "perplexity"));

export default router;
