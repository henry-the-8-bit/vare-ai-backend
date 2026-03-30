import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { transactionEventsTable, agentOrdersTable } from "@workspace/db/schema";
import { eq, and, desc, sql, ilike, or, gte, lte } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { paginatedResponse, successResponse } from "../lib/response.js";
import { getDateBounds, parseRange } from "../services/metricsService.js";

const router: IRouter = Router();

// ── GET /transactions — flat event list (original) ──
router.get("/transactions", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "20"), 10)));
  const offset = (page - 1) * limit;
  const search = req.query["search"] as string | undefined;
  const eventType = req.query["eventType"] as string | undefined;
  const status = req.query["status"] as string | undefined;
  const range = parseRange(req.query["range"]);
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

// ── Funnel step ordering for funnelReached calculation ──
const FUNNEL_STEPS = ["Query", "Product", "Inventory", "Cart", "Order"];
const EVENT_TO_FUNNEL: Record<string, string> = {
  query: "Query", search: "Query",
  product: "Product", product_view: "Product", product_detail: "Product",
  inventory: "Inventory", inventory_check: "Inventory", probe: "Inventory",
  cart: "Cart", cart_add: "Cart", add_to_cart: "Cart",
  order: "Order", checkout: "Order", order_placed: "Order",
};

// ── GET /transactions/sessions — grouped by sessionId for ledger UI ──
router.get("/transactions/sessions", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query["limit"] ?? "20"), 10)));
  const search = req.query["search"] as string | undefined;
  const agentPlatform = req.query["agentPlatform"] as string | undefined;
  const status = req.query["status"] as string | undefined;
  const range = parseRange(req.query["range"]);
  const { from, to } = getDateBounds(range);

  // Build WHERE conditions for the session summary query
  const baseWhere = [
    eq(transactionEventsTable.merchantId, merchantId),
    gte(transactionEventsTable.createdAt, from),
    lte(transactionEventsTable.createdAt, to),
  ];

  if (agentPlatform && agentPlatform !== "all") {
    baseWhere.push(eq(transactionEventsTable.agentPlatform, agentPlatform));
  }
  if (search) {
    baseWhere.push(
      or(
        ilike(transactionEventsTable.sku, `%${search}%`),
        ilike(transactionEventsTable.sessionId, `%${search}%`),
        ilike(transactionEventsTable.agentPlatform, `%${search}%`),
      )!,
    );
  }

  // Get distinct session IDs with pagination
  const sessionSummaries = await db
    .select({
      sessionId: transactionEventsTable.sessionId,
      agentPlatform: sql<string>`max(${transactionEventsTable.agentPlatform})`,
      firstSku: sql<string>`(array_agg(${transactionEventsTable.sku} order by ${transactionEventsTable.createdAt}))[1]`,
      eventCount: sql<number>`count(*)::int`,
      totalDurationMs: sql<number>`coalesce(sum(${transactionEventsTable.durationMs}), 0)::int`,
      hasError: sql<boolean>`bool_or(${transactionEventsTable.status} = 'failed' OR ${transactionEventsTable.eventType} = 'error')`,
      hasPending: sql<boolean>`bool_or(${transactionEventsTable.status} = 'pending')`,
      startedAt: sql<string>`min(${transactionEventsTable.createdAt})`,
    })
    .from(transactionEventsTable)
    .where(and(...baseWhere))
    .groupBy(transactionEventsTable.sessionId)
    .orderBy(desc(sql`min(${transactionEventsTable.createdAt})`))
    .limit(limit)
    .offset((page - 1) * limit);

  // Total sessions count
  const [{ cnt }] = await db
    .select({ cnt: sql<number>`count(distinct ${transactionEventsTable.sessionId})` })
    .from(transactionEventsTable)
    .where(and(...baseWhere));

  if (sessionSummaries.length === 0) {
    paginatedResponse(res, [], Number(cnt ?? 0), page, limit);
    return;
  }

  // Fetch all events for these sessions
  const sessionIds = sessionSummaries.map(s => s.sessionId);
  const allEvents = await db
    .select()
    .from(transactionEventsTable)
    .where(
      and(
        eq(transactionEventsTable.merchantId, merchantId),
        sql`${transactionEventsTable.sessionId} = ANY(${sessionIds})`,
      ),
    )
    .orderBy(transactionEventsTable.createdAt);

  // Group events by sessionId
  const eventsBySession = new Map<string, typeof allEvents>();
  for (const ev of allEvents) {
    const sid = ev.sessionId ?? "";
    if (!eventsBySession.has(sid)) eventsBySession.set(sid, []);
    eventsBySession.get(sid)!.push(ev);
  }

  // Fetch order data for these sessions
  const orders = await db
    .select()
    .from(agentOrdersTable)
    .where(
      and(
        eq(agentOrdersTable.merchantId, merchantId),
        sql`${agentOrdersTable.agentSessionId} = ANY(${sessionIds})`,
      ),
    );

  const orderBySession = new Map<string, typeof orders[0]>();
  for (const o of orders) {
    if (o.agentSessionId) orderBySession.set(o.agentSessionId, o);
  }

  // Build session transaction objects
  const sessions = sessionSummaries.map((summary, idx) => {
    const sid = summary.sessionId ?? "";
    const events = eventsBySession.get(sid) || [];
    const order = orderBySession.get(sid);

    // Determine overall status
    let sessionStatus: "success" | "failed" | "pending" = "success";
    if (summary.hasError) sessionStatus = "failed";
    else if (summary.hasPending) sessionStatus = "pending";
    // Apply status filter after grouping
    if (status && status !== "all" && sessionStatus !== status) return null;

    // Calculate funnel reached
    const eventTypesPresent = new Set(
      events.map(e => EVENT_TO_FUNNEL[(e.eventType ?? "").toLowerCase()] ?? "").filter(Boolean),
    );
    let funnelReached = 0;
    for (const step of FUNNEL_STEPS) {
      if (eventTypesPresent.has(step)) funnelReached = FUNNEL_STEPS.indexOf(step) + 1;
    }

    // Format amount
    let amount: string | null = null;
    if (order?.totalPrice) {
      amount = `$${Number(order.totalPrice).toFixed(2)}`;
    }

    // Agent display name
    const platform = (summary.agentPlatform ?? "unknown").toLowerCase();
    const agentNames: Record<string, string> = {
      chatgpt: "ChatGPT", gemini: "Gemini", claude: "Claude",
      perplexity: "Perplexity", copilot: "Copilot",
    };

    // Format events for frontend
    const formattedEvents = events.map(ev => {
      const ts = new Date(ev.createdAt!);
      return {
        time: ts.toISOString(),
        type: (ev.eventType ?? "QUERY").toUpperCase(),
        description: (ev.metadata as Record<string, string>)?.description ?? `${ev.eventType} event`,
        detail: (ev.metadata as Record<string, string>)?.detail ?? "",
        latency: ev.durationMs ? `${ev.durationMs}ms` : "0ms",
      };
    });

    const startTs = new Date(summary.startedAt);

    return {
      id: sid,
      timestamp: startTs.toISOString(),
      agent: agentNames[platform] ?? platform.charAt(0).toUpperCase() + platform.slice(1),
      agentPlatform: platform,
      sku: summary.firstSku ?? "",
      productName: order?.productTitle ?? (events[0]?.metadata as Record<string, string>)?.productName ?? "",
      amount,
      status: sessionStatus,
      duration: `${summary.totalDurationMs}ms`,
      funnelSteps: FUNNEL_STEPS,
      funnelReached,
      events: formattedEvents,
    };
  }).filter(Boolean);

  paginatedResponse(res, sessions, Number(cnt ?? 0), page, limit);
});

// ── GET /transactions/stats — ledger stats bar data ──
router.get("/transactions/stats", requireAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const range = parseRange(req.query["range"]);
  const { from, to } = getDateBounds(range);

  const baseWhere = and(
    eq(transactionEventsTable.merchantId, merchantId),
    gte(transactionEventsTable.createdAt, from),
    lte(transactionEventsTable.createdAt, to),
  );

  // Get today's bounds for "today" comparison
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);

  const [
    [totals],
    [todayTotals],
    [yesterdayTotals],
    platformRows,
  ] = await Promise.all([
    db.select({
      sessions: sql<number>`count(distinct ${transactionEventsTable.sessionId})::int`,
      events: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) filter (where ${transactionEventsTable.status} = 'failed')::int`,
      avgDuration: sql<number>`coalesce(avg(${transactionEventsTable.durationMs}), 0)::int`,
    }).from(transactionEventsTable).where(baseWhere),

    db.select({
      sessions: sql<number>`count(distinct ${transactionEventsTable.sessionId})::int`,
    }).from(transactionEventsTable).where(and(
      eq(transactionEventsTable.merchantId, merchantId),
      gte(transactionEventsTable.createdAt, todayStart),
    )),

    db.select({
      sessions: sql<number>`count(distinct ${transactionEventsTable.sessionId})::int`,
    }).from(transactionEventsTable).where(and(
      eq(transactionEventsTable.merchantId, merchantId),
      gte(transactionEventsTable.createdAt, yesterdayStart),
      lte(transactionEventsTable.createdAt, todayStart),
    )),

    db.select({
      platform: transactionEventsTable.agentPlatform,
    }).from(transactionEventsTable).where(and(
      eq(transactionEventsTable.merchantId, merchantId),
      gte(transactionEventsTable.createdAt, from),
    )).groupBy(transactionEventsTable.agentPlatform),
  ]);

  const todayCount = todayTotals?.sessions ?? 0;
  const yesterdayCount = yesterdayTotals?.sessions ?? 0;
  const changePercent = yesterdayCount > 0
    ? Math.round(((todayCount - yesterdayCount) / yesterdayCount) * 100)
    : todayCount > 0 ? 100 : 0;

  const successRate = totals.events > 0
    ? Math.round(((totals.events - totals.failed) / totals.events) * 1000) / 10
    : 100;

  successResponse(res, {
    transactionsToday: todayCount,
    changePercent,
    successRate,
    failedCount: totals.failed,
    avgResponseMs: totals.avgDuration,
    activeAgents: platformRows.length,
    agentNames: platformRows.map(r => r.platform).filter(Boolean),
  });
});

export default router;
