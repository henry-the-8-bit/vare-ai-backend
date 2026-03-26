import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, paginatedResponse, errorResponse } from "../lib/response.js";
import { distributionService } from "../services/distribution/distributionService.js";
import type { DistributionPlatform, SyncType } from "../services/distribution/types.js";

const router: IRouter = Router();

function getParam(req: Request, key: string): string | undefined {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

const createConnectionSchema = z.object({
  platform: z.enum(["chatgpt", "gemini", "perplexity", "claude", "custom"]),
  displayName: z.string().min(1).max(255),
  credentials: z.record(z.string(), z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  syncSchedule: z.string().max(50).optional(),
});

const updateConnectionSchema = z.object({
  displayName: z.string().min(1).max(255).optional(),
  credentials: z.record(z.string(), z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  syncSchedule: z.string().max(50).optional(),
  connectionStatus: z.enum(["pending", "connected", "syncing", "error", "disabled"]).optional(),
});

const triggerSyncSchema = z.object({
  type: z.enum(["full_sync", "delta_sync"]),
});

// GET /api/distributions/platforms — list available platforms
router.get("/distributions/platforms", requireAuth, async (_req: Request, res: Response) => {
  const platforms = distributionService.getPlatformMetadata();
  successResponse(res, platforms);
});

// GET /api/distributions — list all connections for merchant
router.get("/distributions", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const connections = await distributionService.listConnections(merchantId);
  successResponse(res, connections);
});

// POST /api/distributions — create new platform connection
router.post("/distributions", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const parsed = createConnectionSchema.safeParse(req.body);

  if (!parsed.success) {
    errorResponse(res, "Validation error", "VALIDATION_ERROR", 400, parsed.error.issues);
    return;
  }

  try {
    const connection = await distributionService.createConnection(merchantId, parsed.data);
    successResponse(res, connection, 201);
  } catch (err) {
    errorResponse(res, String(err), "CREATE_FAILED", 400);
  }
});

// GET /api/distributions/:id — get connection details
router.get("/distributions/:id", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const connectionId = getParam(req, "id")!;

  const connection = await distributionService.getConnection(connectionId, merchantId);
  if (!connection) {
    errorResponse(res, "Connection not found", "NOT_FOUND", 404);
    return;
  }

  successResponse(res, connection);
});

// PATCH /api/distributions/:id — update connection
router.patch("/distributions/:id", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const connectionId = getParam(req, "id")!;
  const parsed = updateConnectionSchema.safeParse(req.body);

  if (!parsed.success) {
    errorResponse(res, "Validation error", "VALIDATION_ERROR", 400, parsed.error.issues);
    return;
  }

  try {
    const updated = await distributionService.updateConnection(connectionId, merchantId, parsed.data);
    successResponse(res, updated);
  } catch (err) {
    errorResponse(res, String(err), "UPDATE_FAILED", 400);
  }
});

// DELETE /api/distributions/:id — delete connection
router.delete("/distributions/:id", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const connectionId = getParam(req, "id")!;

  try {
    await distributionService.deleteConnection(connectionId, merchantId);
    successResponse(res, { deleted: true });
  } catch (err) {
    errorResponse(res, String(err), "DELETE_FAILED", 400);
  }
});

// POST /api/distributions/:id/test — test connection
router.post("/distributions/:id/test", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const connectionId = getParam(req, "id")!;

  try {
    const result = await distributionService.testConnection(connectionId, merchantId);
    successResponse(res, result);
  } catch (err) {
    errorResponse(res, String(err), "TEST_FAILED", 400);
  }
});

// POST /api/distributions/:id/sync — trigger sync
router.post("/distributions/:id/sync", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const connectionId = getParam(req, "id")!;
  const parsed = triggerSyncSchema.safeParse(req.body);

  if (!parsed.success) {
    errorResponse(res, "Validation error", "VALIDATION_ERROR", 400, parsed.error.issues);
    return;
  }

  try {
    const job = await distributionService.triggerSync(connectionId, merchantId, parsed.data.type as SyncType);
    successResponse(res, job, 202);
  } catch (err) {
    errorResponse(res, String(err), "SYNC_FAILED", 400);
  }
});

// GET /api/distributions/:id/jobs — list sync jobs
router.get("/distributions/:id/jobs", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const connectionId = getParam(req, "id")!;
  const page = Math.max(1, Number(req.query["page"]) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query["limit"]) || 20));

  const jobs = await distributionService.listJobs(connectionId, merchantId, page, limit);
  successResponse(res, jobs);
});

// GET /api/distributions/:id/spec — get generated platform spec
router.get("/distributions/:id/spec", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const connectionId = getParam(req, "id")!;

  const spec = await distributionService.getSpec(connectionId, merchantId);
  if (!spec) {
    errorResponse(res, "Spec not available for this platform", "NOT_AVAILABLE", 404);
    return;
  }

  successResponse(res, spec);
});

export default router;
