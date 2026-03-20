import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { agentConfigsTable, agentQueriesTable } from "@workspace/db/schema";
import { eq, and, desc, gte, lte, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, errorResponse, paginatedResponse } from "../lib/response.js";
import { z } from "zod/v4";
import { getDateBounds, parseRange } from "../services/metricsService.js";

const router: IRouter = Router();

const botDefenseSchema = z.object({
  rateLimitPerMinute: z.number().int().min(1).max(1000).optional(),
  requireCartConfirmation: z.boolean().optional(),
  maxOrderValueCents: z.number().int().min(0).optional().nullable(),
  allowedPlatforms: z.array(z.string()).optional().nullable(),
  testOrderEnabled: z.boolean().optional(),
  enabledCapabilities: z.array(z.string()).optional(),
});

router.get("/bot-defense/overview", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const range = parseRange(req.query["range"]);
  const { from, to } = getDateBounds(range);

  const [totalQueriesRow, unmatchedRow] = await Promise.all([
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(agentQueriesTable)
      .where(
        and(eq(agentQueriesTable.merchantId, merchantId), gte(agentQueriesTable.createdAt, from), lte(agentQueriesTable.createdAt, to)),
      ),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(agentQueriesTable)
      .where(
        and(
          eq(agentQueriesTable.merchantId, merchantId),
          gte(agentQueriesTable.createdAt, from),
          lte(agentQueriesTable.createdAt, to),
          sql`was_matched = false`,
        ),
      ),
  ]);

  const total = Number(totalQueriesRow[0]?.cnt ?? 0);
  const unmatched = Number(unmatchedRow[0]?.cnt ?? 0);
  const matched = total - unmatched;

  successResponse(res, {
    totalRequests: total,
    matchedRequests: matched,
    unmatchedRequests: unmatched,
    matchRate: total > 0 ? Math.round((matched / total) * 1000) / 10 : 0,
    flaggedRequests: 0,
    blockRate: 0,
  });
});

router.get("/bot-defense/events", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const range = parseRange(req.query["range"]);
  const { from, to } = getDateBounds(range);
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "20"), 10)));
  const offset = (page - 1) * limit;

  const [events, [{ cnt }]] = await Promise.all([
    db
      .select()
      .from(agentQueriesTable)
      .where(
        and(
          eq(agentQueriesTable.merchantId, merchantId),
          gte(agentQueriesTable.createdAt, from),
          lte(agentQueriesTable.createdAt, to),
          sql`was_matched = false`,
        ),
      )
      .orderBy(desc(agentQueriesTable.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(agentQueriesTable)
      .where(
        and(
          eq(agentQueriesTable.merchantId, merchantId),
          gte(agentQueriesTable.createdAt, from),
          lte(agentQueriesTable.createdAt, to),
          sql`was_matched = false`,
        ),
      ),
  ]);

  paginatedResponse(res, events, Number(cnt ?? 0), page, limit);
});

router.get("/bot-defense/suspicious-agents", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const range = parseRange(req.query["range"]);
  const { from, to } = getDateBounds(range);

  const rows = await db
    .select({
      agentPlatform: agentQueriesTable.agentPlatform,
      requestCount: sql<number>`count(*)`,
      lastSeen: sql<string>`max(created_at)`,
    })
    .from(agentQueriesTable)
    .where(
      and(
        eq(agentQueriesTable.merchantId, merchantId),
        gte(agentQueriesTable.createdAt, from),
        lte(agentQueriesTable.createdAt, to),
        sql`agent_platform IS NOT NULL`,
      ),
    )
    .groupBy(agentQueriesTable.agentPlatform)
    .orderBy(desc(sql`count(*)`))
    .limit(20);

  successResponse(res, rows);
});

router.get("/bot-defense/settings", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const [config] = await db
    .select()
    .from(agentConfigsTable)
    .where(eq(agentConfigsTable.merchantId, merchantId))
    .limit(1);

  successResponse(res, config ?? {
    merchantId,
    rateLimitPerMinute: 60,
    requireCartConfirmation: false,
    maxOrderValueCents: null,
    allowedPlatforms: null,
    testOrderEnabled: true,
    enabledCapabilities: ["search", "cart", "checkout"],
  });
});

router.patch("/bot-defense/settings", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;

  const parsed = botDefenseSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, "Validation failed", "VALIDATION_ERROR", 400, parsed.error.issues);
    return;
  }

  const data = parsed.data;

  const [existing] = await db
    .select({ id: agentConfigsTable.id })
    .from(agentConfigsTable)
    .where(eq(agentConfigsTable.merchantId, merchantId))
    .limit(1);

  let config;
  if (existing) {
    [config] = await db
      .update(agentConfigsTable)
      .set({
        ...(data.rateLimitPerMinute !== undefined && { rateLimitPerMinute: data.rateLimitPerMinute }),
        ...(data.requireCartConfirmation !== undefined && { requireCartConfirmation: data.requireCartConfirmation }),
        ...(data.maxOrderValueCents !== undefined && { maxOrderValueCents: data.maxOrderValueCents }),
        ...(data.allowedPlatforms !== undefined && { allowedPlatforms: data.allowedPlatforms }),
        ...(data.testOrderEnabled !== undefined && { testOrderEnabled: data.testOrderEnabled }),
        ...(data.enabledCapabilities !== undefined && { enabledCapabilities: data.enabledCapabilities }),
        updatedAt: new Date(),
      })
      .where(eq(agentConfigsTable.merchantId, merchantId))
      .returning();
  } else {
    [config] = await db
      .insert(agentConfigsTable)
      .values({
        merchantId,
        rateLimitPerMinute: data.rateLimitPerMinute ?? 60,
        requireCartConfirmation: data.requireCartConfirmation ?? false,
        maxOrderValueCents: data.maxOrderValueCents ?? null,
        allowedPlatforms: data.allowedPlatforms ?? null,
        testOrderEnabled: data.testOrderEnabled ?? true,
        enabledCapabilities: data.enabledCapabilities ?? ["search", "cart", "checkout"],
      })
      .returning();
  }

  successResponse(res, config);
});

export default router;
