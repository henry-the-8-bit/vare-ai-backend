import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { syncJobsTable, magentoConnectionsTable } from "@workspace/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod/v4";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, errorResponse } from "../lib/response.js";
import { catalogSyncService } from "../services/catalogSync.js";

const router: IRouter = Router();

const syncConfigSchema = z.object({
  productTypes: z.array(z.string()).optional().default(["simple", "configurable", "grouped", "bundle"]),
  status: z.array(z.string()).optional().default(["1"]),
  visibility: z.array(z.string()).optional().default(["1", "2", "3", "4"]),
  categoryIds: z.array(z.number()).optional(),
  attributes: z.array(z.string()).optional(),
});

router.post("/sync/configure", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const parsed = syncConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.flatten());
    return;
  }

  const [conn] = await db
    .select({ id: magentoConnectionsTable.id })
    .from(magentoConnectionsTable)
    .where(eq(magentoConnectionsTable.merchantId, merchantId))
    .limit(1);

  if (!conn) {
    errorResponse(res, "No Magento connection configured. Submit credentials first.", "NO_CONNECTION", 400);
    return;
  }

  await db
    .update(magentoConnectionsTable)
    .set({ syncConfig: parsed.data })
    .where(eq(magentoConnectionsTable.merchantId, merchantId));

  successResponse(res, {
    configured: true,
    config: parsed.data,
  });
});

router.post("/sync/start", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const [conn] = await db
    .select({ id: magentoConnectionsTable.id, connectionStatus: magentoConnectionsTable.connectionStatus, syncConfig: magentoConnectionsTable.syncConfig })
    .from(magentoConnectionsTable)
    .where(eq(magentoConnectionsTable.merchantId, merchantId))
    .limit(1);

  if (!conn) {
    errorResponse(res, "No Magento connection configured.", "NO_CONNECTION", 400);
    return;
  }

  if (conn.connectionStatus !== "connected") {
    errorResponse(res, "Magento connection is not verified. Run /connect/test first.", "CONNECTION_NOT_VERIFIED", 400);
    return;
  }

  const syncType = req.body?.type === "delta" ? "delta" : "full";
  const config = (conn.syncConfig as Record<string, unknown> | null) ?? { productTypes: ["simple", "configurable"], status: ["1"] };

  let job;
  if (syncType === "delta") {
    job = await catalogSyncService.startDeltaSync(merchantId);
  } else {
    job = await catalogSyncService.startFullSync(merchantId, config as Parameters<typeof catalogSyncService.startFullSync>[1]);
  }

  successResponse(res, job, 202);
});

router.get("/sync/status", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const jobId = req.query["jobId"] as string | undefined;

  let job;
  if (jobId) {
    job = await catalogSyncService.getJob(jobId, merchantId);
  } else {
    job = await catalogSyncService.getLatestJob(merchantId);
  }

  if (!job) {
    errorResponse(res, "No sync job found", "NOT_FOUND", 404);
    return;
  }

  successResponse(res, {
    jobId: job.id,
    status: job.status,
    totalRecords: job.totalRecords,
    processedRecords: job.processedRecords,
    errorCount: job.errorCount,
  });
});

router.post("/sync/pause", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const jobId = req.body?.jobId as string | undefined;

  if (!jobId) {
    errorResponse(res, "jobId required in request body", "VALIDATION_ERROR", 400);
    return;
  }

  const [job] = await db
    .select()
    .from(syncJobsTable)
    .where(and(eq(syncJobsTable.id, jobId), eq(syncJobsTable.merchantId, merchantId)))
    .limit(1);

  if (!job) {
    errorResponse(res, "Sync job not found", "NOT_FOUND", 404);
    return;
  }

  const paused = catalogSyncService.pauseJob(jobId);

  successResponse(res, { jobId, paused, message: paused ? "Job paused" : "Job not currently running" });
});

router.post("/sync/cancel", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const jobId = req.body?.jobId as string | undefined;

  if (!jobId) {
    errorResponse(res, "jobId required in request body", "VALIDATION_ERROR", 400);
    return;
  }

  const [job] = await db
    .select()
    .from(syncJobsTable)
    .where(and(eq(syncJobsTable.id, jobId), eq(syncJobsTable.merchantId, merchantId)))
    .limit(1);

  if (!job) {
    errorResponse(res, "Sync job not found", "NOT_FOUND", 404);
    return;
  }

  const cancelled = catalogSyncService.cancelJob(jobId);

  if (!cancelled) {
    await db
      .update(syncJobsTable)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(syncJobsTable.id, jobId));
  }

  successResponse(res, { jobId, cancelled: true, message: "Job cancellation requested" });
});

router.get("/sync/summary", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const jobs = await db
    .select()
    .from(syncJobsTable)
    .where(eq(syncJobsTable.merchantId, merchantId))
    .orderBy(desc(syncJobsTable.createdAt))
    .limit(10);

  if (jobs.length === 0) {
    successResponse(res, { totalJobs: 0, jobs: [] });
    return;
  }

  const lastJob = jobs[0];

  successResponse(res, {
    totalJobs: jobs.length,
    lastSync: {
      jobId: lastJob.id,
      type: lastJob.jobType,
      status: lastJob.status,
      totalRecords: lastJob.totalRecords,
      processedRecords: lastJob.processedRecords,
      errorCount: lastJob.errorCount,
      startedAt: lastJob.startedAt,
      completedAt: lastJob.completedAt,
      durationSeconds: lastJob.durationSeconds,
    },
    recentJobs: jobs.map((j) => ({
      jobId: j.id,
      type: j.jobType,
      status: j.status,
      processedRecords: j.processedRecords,
      errorCount: j.errorCount,
      createdAt: j.createdAt,
    })),
  });
});

router.get("/sync/errors", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const jobId = req.query["jobId"] as string | undefined;

  let job;
  if (jobId) {
    const [found] = await db
      .select()
      .from(syncJobsTable)
      .where(and(eq(syncJobsTable.id, jobId), eq(syncJobsTable.merchantId, merchantId)))
      .limit(1);
    job = found;
  } else {
    const [found] = await db
      .select()
      .from(syncJobsTable)
      .where(eq(syncJobsTable.merchantId, merchantId))
      .orderBy(desc(syncJobsTable.createdAt))
      .limit(1);
    job = found;
  }

  if (!job) {
    errorResponse(res, "No sync job found", "NOT_FOUND", 404);
    return;
  }

  const errorLog = Array.isArray(job.errorLog) ? job.errorLog : [];

  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1")));
  const limit = Math.min(100, parseInt(String(req.query["limit"] ?? "50")));
  const start = (page - 1) * limit;

  successResponse(res, {
    jobId: job.id,
    totalErrors: job.errorCount,
    errors: errorLog.slice(start, start + limit),
    page,
    limit,
  });
});

export default router;
