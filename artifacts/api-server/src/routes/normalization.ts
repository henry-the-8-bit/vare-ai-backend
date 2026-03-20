import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { syncJobsTable, attributeMappingsTable, valueNormalizationsTable } from "@workspace/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod/v4";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, errorResponse } from "../lib/response.js";
import {
  runBatchNormalization,
  previewNormalization,
  discoverAttributeMappings,
  discoverValueClusters,
} from "../services/normalizationService.js";

const router: IRouter = Router();

function getParam(req: Request, key: string): string | undefined {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

router.get("/normalization/preview", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query["limit"] ?? "10"))));

  const previews = await previewNormalization(merchantId, limit);
  successResponse(res, { count: previews.length, previews });
});

router.post("/normalization/run", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const [job] = await db
    .insert(syncJobsTable)
    .values({
      merchantId,
      jobType: "normalization",
      status: "queued",
    })
    .returning();

  runBatchNormalization(job.id, merchantId).catch((err) => {
    console.error("[normalization] batch normalization failed", err);
  });

  successResponse(res, { jobId: job.id, status: "queued", message: "Normalization job started" }, 202);
});

router.get("/normalization/status", requireAuth, async (req: Request, res: Response) => {
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
      .where(and(eq(syncJobsTable.merchantId, merchantId), eq(syncJobsTable.jobType, "normalization")))
      .orderBy(desc(syncJobsTable.createdAt))
      .limit(1);
    job = found;
  }

  if (!job) {
    errorResponse(res, "No normalization job found", "NOT_FOUND", 404);
    return;
  }

  successResponse(res, {
    jobId: job.id,
    status: job.status,
    totalRecords: job.totalRecords,
    processedRecords: job.processedRecords,
    errorCount: job.errorCount,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    durationSeconds: job.durationSeconds,
  });
});

router.get("/normalization/attribute-mappings", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const mappings = await db
    .select()
    .from(attributeMappingsTable)
    .where(eq(attributeMappingsTable.merchantId, merchantId))
    .orderBy(desc(attributeMappingsTable.createdAt))
    .limit(200);

  successResponse(res, { count: mappings.length, mappings });
});

router.post("/normalization/attribute-mappings/discover", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  await discoverAttributeMappings(merchantId);

  const mappings = await db
    .select()
    .from(attributeMappingsTable)
    .where(eq(attributeMappingsTable.merchantId, merchantId))
    .orderBy(desc(attributeMappingsTable.createdAt));

  successResponse(res, { discovered: mappings.length, mappings });
});

const updateMappingSchema = z.object({
  targetAttribute: z.string().max(255).nullable(),
  mappingStatus: z.enum(["auto", "manual", "pending", "rejected"]).optional(),
  dataType: z.string().max(50).optional(),
  normalizationUnit: z.string().max(50).optional(),
});

router.patch("/normalization/attribute-mappings/:mappingId", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const mappingId = getParam(req, "mappingId");

  if (!mappingId) {
    errorResponse(res, "mappingId required", "VALIDATION_ERROR", 400);
    return;
  }

  const parsed = updateMappingSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.flatten());
    return;
  }

  const [existing] = await db
    .select({ id: attributeMappingsTable.id })
    .from(attributeMappingsTable)
    .where(and(eq(attributeMappingsTable.id, mappingId), eq(attributeMappingsTable.merchantId, merchantId)))
    .limit(1);

  if (!existing) {
    errorResponse(res, "Attribute mapping not found", "NOT_FOUND", 404);
    return;
  }

  const [updated] = await db
    .update(attributeMappingsTable)
    .set({
      targetAttribute: parsed.data.targetAttribute ?? undefined,
      mappingStatus: parsed.data.mappingStatus ?? undefined,
      dataType: parsed.data.dataType ?? undefined,
      normalizationUnit: parsed.data.normalizationUnit ?? undefined,
    })
    .where(and(eq(attributeMappingsTable.id, mappingId), eq(attributeMappingsTable.merchantId, merchantId)))
    .returning();

  successResponse(res, updated);
});

router.get("/normalization/value-clusters/:mappingId", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const mappingId = getParam(req, "mappingId");

  if (!mappingId) {
    errorResponse(res, "mappingId required", "VALIDATION_ERROR", 400);
    return;
  }

  const [mapping] = await db
    .select({ id: attributeMappingsTable.id })
    .from(attributeMappingsTable)
    .where(and(eq(attributeMappingsTable.id, mappingId), eq(attributeMappingsTable.merchantId, merchantId)))
    .limit(1);

  if (!mapping) {
    errorResponse(res, "Attribute mapping not found", "NOT_FOUND", 404);
    return;
  }

  const clusters = await db
    .select()
    .from(valueNormalizationsTable)
    .where(and(eq(valueNormalizationsTable.merchantId, merchantId), eq(valueNormalizationsTable.attributeMappingId, mappingId)))
    .orderBy(desc(valueNormalizationsTable.productCount))
    .limit(200);

  successResponse(res, { mappingId, count: clusters.length, clusters });
});

router.post("/normalization/value-clusters/:mappingId/discover", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const mappingId = getParam(req, "mappingId");

  if (!mappingId) {
    errorResponse(res, "mappingId required", "VALIDATION_ERROR", 400);
    return;
  }

  const [mapping] = await db
    .select({ id: attributeMappingsTable.id })
    .from(attributeMappingsTable)
    .where(and(eq(attributeMappingsTable.id, mappingId), eq(attributeMappingsTable.merchantId, merchantId)))
    .limit(1);

  if (!mapping) {
    errorResponse(res, "Attribute mapping not found", "NOT_FOUND", 404);
    return;
  }

  await discoverValueClusters(merchantId, mappingId);

  const clusters = await db
    .select()
    .from(valueNormalizationsTable)
    .where(and(eq(valueNormalizationsTable.merchantId, merchantId), eq(valueNormalizationsTable.attributeMappingId, mappingId)))
    .orderBy(desc(valueNormalizationsTable.productCount));

  successResponse(res, { mappingId, discovered: clusters.length, clusters });
});

const updateClusterSchema = z.object({
  normalizedValue: z.string().max(500),
  clusterName: z.string().max(255).optional(),
  status: z.enum(["suggested", "approved", "rejected"]),
});

router.patch("/normalization/value-clusters/:mappingId/:clusterId", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const mappingId = getParam(req, "mappingId");
  const clusterId = getParam(req, "clusterId");

  if (!mappingId || !clusterId) {
    errorResponse(res, "mappingId and clusterId required", "VALIDATION_ERROR", 400);
    return;
  }

  const parsed = updateClusterSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.flatten());
    return;
  }

  const [existing] = await db
    .select({ id: valueNormalizationsTable.id })
    .from(valueNormalizationsTable)
    .where(and(
      eq(valueNormalizationsTable.id, clusterId),
      eq(valueNormalizationsTable.merchantId, merchantId),
      eq(valueNormalizationsTable.attributeMappingId, mappingId),
    ))
    .limit(1);

  if (!existing) {
    errorResponse(res, "Value cluster not found", "NOT_FOUND", 404);
    return;
  }

  const [updated] = await db
    .update(valueNormalizationsTable)
    .set({
      normalizedValue: parsed.data.normalizedValue,
      clusterName: parsed.data.clusterName ?? undefined,
      status: parsed.data.status,
    })
    .where(and(eq(valueNormalizationsTable.id, clusterId), eq(valueNormalizationsTable.merchantId, merchantId)))
    .returning();

  successResponse(res, updated);
});

export default router;
