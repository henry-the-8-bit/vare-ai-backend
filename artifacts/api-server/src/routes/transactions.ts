import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { transactionEventsTable } from "@workspace/db/schema";
import { eq, and, desc, sql, ilike, or, gte, lte } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { paginatedResponse } from "../lib/response.js";
import { getDateBounds, type DateRange } from "../services/metricsService.js";

const router: IRouter = Router();

router.get("/transactions", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "20"), 10)));
  const offset = (page - 1) * limit;
  const search = req.query["search"] as string | undefined;
  const eventType = req.query["eventType"] as string | undefined;
  const status = req.query["status"] as string | undefined;
  const range = ((req.query["range"] as string) ?? "30d") as DateRange;
  const { from, to } = getDateBounds(range);

  const conditions = [
    eq(transactionEventsTable.merchantId, merchantId),
    gte(transactionEventsTable.createdAt, from),
    lte(transactionEventsTable.createdAt, to),
  ];

  if (search) {
    conditions.push(
      or(
        ilike(transactionEventsTable.sku, `%${search}%`),
        ilike(transactionEventsTable.sessionId, `%${search}%`),
        ilike(transactionEventsTable.agentPlatform, `%${search}%`),
      )!,
    );
  }

  if (eventType) conditions.push(eq(transactionEventsTable.eventType, eventType));
  if (status) conditions.push(eq(transactionEventsTable.status, status));

  const [rows, [{ cnt }]] = await Promise.all([
    db
      .select()
      .from(transactionEventsTable)
      .where(and(...conditions))
      .orderBy(desc(transactionEventsTable.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(transactionEventsTable)
      .where(and(...conditions)),
  ]);

  paginatedResponse(res, rows, Number(cnt ?? 0), page, limit);
});

export default router;
