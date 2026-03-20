import { db } from "@workspace/db";
import {
  agentOrdersTable,
  agentQueriesTable,
  transactionEventsTable,
  normalizedProductsTable,
  inventoryTable,
  syncJobsTable,
} from "@workspace/db/schema";
import { eq, and, gte, lte, sql, desc, asc, count } from "drizzle-orm";

export type DateRange = "today" | "7d" | "30d" | "90d" | "ytd";

export function getDateBounds(range: DateRange): { from: Date; to: Date } {
  const now = new Date();
  const to = new Date(now);
  let from: Date;

  switch (range) {
    case "today":
      from = new Date(now);
      from.setHours(0, 0, 0, 0);
      break;
    case "7d":
      from = new Date(now);
      from.setDate(from.getDate() - 7);
      break;
    case "30d":
      from = new Date(now);
      from.setDate(from.getDate() - 30);
      break;
    case "90d":
      from = new Date(now);
      from.setDate(from.getDate() - 90);
      break;
    case "ytd":
      from = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      from = new Date(now);
      from.setDate(from.getDate() - 30);
  }

  return { from, to };
}

function buildSparkline(points: { date: string; value: number }[], count = 15): number[] {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) return Array(count).fill(0);
  if (sorted.length >= count) {
    const step = (sorted.length - 1) / (count - 1);
    return Array.from({ length: count }, (_, i) => {
      const idx = Math.min(Math.round(i * step), sorted.length - 1);
      return sorted[idx]!.value;
    });
  }
  const padded = Array(count - sorted.length).fill(0);
  return [...padded, ...sorted.map((p) => p.value)];
}

export async function getKpis(merchantId: string, range: DateRange) {
  const { from, to } = getDateBounds(range);

  const prevTo = new Date(from);
  const prevFrom = new Date(from);
  prevFrom.setTime(prevFrom.getTime() - (to.getTime() - from.getTime()));

  const [orderStats, prevOrderStats, queryStats, prevQueryStats, revenueRows, prevRevenueRows] =
    await Promise.all([
      db
        .select({ cnt: sql<number>`count(*)`, statuses: sql<string[]>`array_agg(distinct order_status)` })
        .from(agentOrdersTable)
        .where(
          and(
            eq(agentOrdersTable.merchantId, merchantId),
            gte(agentOrdersTable.createdAt, from),
            lte(agentOrdersTable.createdAt, to),
            sql`order_status NOT IN ('cancelled', 'failed')`,
          ),
        ),
      db
        .select({ cnt: sql<number>`count(*)` })
        .from(agentOrdersTable)
        .where(
          and(
            eq(agentOrdersTable.merchantId, merchantId),
            gte(agentOrdersTable.createdAt, prevFrom),
            lte(agentOrdersTable.createdAt, prevTo),
            sql`order_status NOT IN ('cancelled', 'failed')`,
          ),
        ),
      db
        .select({ cnt: sql<number>`count(*)` })
        .from(agentQueriesTable)
        .where(
          and(
            eq(agentQueriesTable.merchantId, merchantId),
            gte(agentQueriesTable.createdAt, from),
            lte(agentQueriesTable.createdAt, to),
          ),
        ),
      db
        .select({ cnt: sql<number>`count(*)` })
        .from(agentQueriesTable)
        .where(
          and(
            eq(agentQueriesTable.merchantId, merchantId),
            gte(agentQueriesTable.createdAt, prevFrom),
            lte(agentQueriesTable.createdAt, prevTo),
          ),
        ),
      db
        .select({ total: sql<number>`coalesce(sum(total_price::numeric), 0)` })
        .from(agentOrdersTable)
        .where(
          and(
            eq(agentOrdersTable.merchantId, merchantId),
            gte(agentOrdersTable.createdAt, from),
            lte(agentOrdersTable.createdAt, to),
            sql`order_status NOT IN ('cancelled', 'failed')`,
          ),
        ),
      db
        .select({ total: sql<number>`coalesce(sum(total_price::numeric), 0)` })
        .from(agentOrdersTable)
        .where(
          and(
            eq(agentOrdersTable.merchantId, merchantId),
            gte(agentOrdersTable.createdAt, prevFrom),
            lte(agentOrdersTable.createdAt, prevTo),
            sql`order_status NOT IN ('cancelled', 'failed')`,
          ),
        ),
    ]);

  const orders = Number(orderStats[0]?.cnt ?? 0);
  const prevOrders = Number(prevOrderStats[0]?.cnt ?? 0);
  const queries = Number(queryStats[0]?.cnt ?? 0);
  const prevQueries = Number(prevQueryStats[0]?.cnt ?? 0);
  const revenue = Number(revenueRows[0]?.total ?? 0);
  const prevRevenue = Number(prevRevenueRows[0]?.total ?? 0);
  const aov = orders > 0 ? revenue / orders : 0;
  const prevAov = prevOrders > 0 ? prevRevenue / prevOrders : 0;
  const conversion = queries > 0 ? (orders / queries) * 100 : 0;
  const prevConversion = prevQueries > 0 ? (prevOrders / prevQueries) * 100 : 0;

  const pctChange = (current: number, prev: number) =>
    prev === 0 ? (current > 0 ? 100 : 0) : Math.round(((current - prev) / prev) * 1000) / 10;

  const [ordersSparkRaw, revenueSparkRaw] = await Promise.all([
    db
      .select({
        date: sql<string>`to_char(created_at, 'YYYY-MM-DD')`,
        value: sql<number>`count(*)`,
      })
      .from(agentOrdersTable)
      .where(
        and(
          eq(agentOrdersTable.merchantId, merchantId),
          gte(agentOrdersTable.createdAt, from),
          lte(agentOrdersTable.createdAt, to),
        ),
      )
      .groupBy(sql`to_char(created_at, 'YYYY-MM-DD')`)
      .orderBy(sql`to_char(created_at, 'YYYY-MM-DD')`),
    db
      .select({
        date: sql<string>`to_char(created_at, 'YYYY-MM-DD')`,
        value: sql<number>`coalesce(sum(total_price::numeric), 0)`,
      })
      .from(agentOrdersTable)
      .where(
        and(
          eq(agentOrdersTable.merchantId, merchantId),
          gte(agentOrdersTable.createdAt, from),
          lte(agentOrdersTable.createdAt, to),
          sql`order_status NOT IN ('cancelled', 'failed')`,
        ),
      )
      .groupBy(sql`to_char(created_at, 'YYYY-MM-DD')`)
      .orderBy(sql`to_char(created_at, 'YYYY-MM-DD')`),
  ]);

  return {
    revenue: {
      value: Math.round(revenue * 100) / 100,
      pctChange: pctChange(revenue, prevRevenue),
      sparkline: buildSparkline(revenueSparkRaw.map((r) => ({ date: r.date, value: Number(r.value) }))),
    },
    orders: {
      value: orders,
      pctChange: pctChange(orders, prevOrders),
      sparkline: buildSparkline(ordersSparkRaw.map((r) => ({ date: r.date, value: Number(r.value) }))),
    },
    queries: {
      value: queries,
      pctChange: pctChange(queries, prevQueries),
      sparkline: buildSparkline([]),
    },
    conversionRate: {
      value: Math.round(conversion * 10) / 10,
      pctChange: pctChange(conversion, prevConversion),
      sparkline: buildSparkline([]),
    },
    aov: {
      value: Math.round(aov * 100) / 100,
      pctChange: pctChange(aov, prevAov),
      sparkline: buildSparkline([]),
    },
  };
}

export async function getTimeseries(merchantId: string, range: DateRange) {
  const { from, to } = getDateBounds(range);
  const diffDays = Math.ceil((to.getTime() - from.getTime()) / 86400000);
  const granularity = diffDays <= 1 ? "hour" : diffDays <= 30 ? "day" : "week";
  const fmt = granularity === "hour" ? "YYYY-MM-DD HH24:00" : granularity === "day" ? "YYYY-MM-DD" : "YYYY-IW";
  const fmtLiteral = `'${fmt}'`;

  const [orders, queries, revenue] = await Promise.all([
    db
      .select({
        bucket: sql<string>`to_char(created_at, ${sql.raw(fmtLiteral)})`,
        value: sql<number>`count(*)`,
      })
      .from(agentOrdersTable)
      .where(
        and(
          eq(agentOrdersTable.merchantId, merchantId),
          gte(agentOrdersTable.createdAt, from),
          lte(agentOrdersTable.createdAt, to),
          sql`order_status NOT IN ('cancelled', 'failed')`,
        ),
      )
      .groupBy(sql`to_char(created_at, ${sql.raw(fmtLiteral)})`)
      .orderBy(sql`to_char(created_at, ${sql.raw(fmtLiteral)})`),
    db
      .select({
        bucket: sql<string>`to_char(created_at, ${sql.raw(fmtLiteral)})`,
        value: sql<number>`count(*)`,
      })
      .from(agentQueriesTable)
      .where(
        and(
          eq(agentQueriesTable.merchantId, merchantId),
          gte(agentQueriesTable.createdAt, from),
          lte(agentQueriesTable.createdAt, to),
        ),
      )
      .groupBy(sql`to_char(created_at, ${sql.raw(fmtLiteral)})`)
      .orderBy(sql`to_char(created_at, ${sql.raw(fmtLiteral)})`),
    db
      .select({
        bucket: sql<string>`to_char(created_at, ${sql.raw(fmtLiteral)})`,
        value: sql<number>`coalesce(sum(total_price::numeric), 0)`,
      })
      .from(agentOrdersTable)
      .where(
        and(
          eq(agentOrdersTable.merchantId, merchantId),
          gte(agentOrdersTable.createdAt, from),
          lte(agentOrdersTable.createdAt, to),
          sql`order_status NOT IN ('cancelled', 'failed')`,
        ),
      )
      .groupBy(sql`to_char(created_at, ${sql.raw(fmtLiteral)})`)
      .orderBy(sql`to_char(created_at, ${sql.raw(fmtLiteral)})`),
  ]);

  const buckets = [...new Set([...orders, ...queries, ...revenue].map((r) => r.bucket))].sort();

  return {
    granularity,
    series: [
      {
        metric: "orders",
        data: buckets.map((b) => ({ bucket: b, value: Number(orders.find((r) => r.bucket === b)?.value ?? 0) })),
      },
      {
        metric: "queries",
        data: buckets.map((b) => ({ bucket: b, value: Number(queries.find((r) => r.bucket === b)?.value ?? 0) })),
      },
      {
        metric: "revenue",
        data: buckets.map((b) => ({ bucket: b, value: Number(revenue.find((r) => r.bucket === b)?.value ?? 0) })),
      },
    ],
  };
}

export async function getPlatformBreakdown(merchantId: string, range: DateRange) {
  const { from, to } = getDateBounds(range);

  const [ordersByPlatform, queriesByPlatform] = await Promise.all([
    db
      .select({
        platform: agentOrdersTable.agentPlatform,
        orders: sql<number>`count(*)`,
        revenue: sql<number>`coalesce(sum(total_price::numeric), 0)`,
      })
      .from(agentOrdersTable)
      .where(
        and(
          eq(agentOrdersTable.merchantId, merchantId),
          gte(agentOrdersTable.createdAt, from),
          lte(agentOrdersTable.createdAt, to),
          sql`order_status NOT IN ('cancelled', 'failed')`,
        ),
      )
      .groupBy(agentOrdersTable.agentPlatform),
    db
      .select({
        platform: agentQueriesTable.agentPlatform,
        queries: sql<number>`count(*)`,
      })
      .from(agentQueriesTable)
      .where(
        and(
          eq(agentQueriesTable.merchantId, merchantId),
          gte(agentQueriesTable.createdAt, from),
          lte(agentQueriesTable.createdAt, to),
        ),
      )
      .groupBy(agentQueriesTable.agentPlatform),
  ]);

  const platforms = [
    ...new Set([
      ...ordersByPlatform.map((r) => r.platform ?? "unknown"),
      ...queriesByPlatform.map((r) => r.platform ?? "unknown"),
    ]),
  ];

  return platforms.map((platform) => {
    const orderRow = ordersByPlatform.find((r) => (r.platform ?? "unknown") === platform);
    const queryRow = queriesByPlatform.find((r) => (r.platform ?? "unknown") === platform);
    return {
      platform,
      orders: Number(orderRow?.orders ?? 0),
      revenue: Math.round(Number(orderRow?.revenue ?? 0) * 100) / 100,
      queries: Number(queryRow?.queries ?? 0),
    };
  });
}

export async function getTopProducts(merchantId: string, range: DateRange, limit = 10) {
  const { from, to } = getDateBounds(range);

  const rows = await db
    .select({
      sku: agentOrdersTable.sku,
      productTitle: agentOrdersTable.productTitle,
      units: sql<number>`sum(quantity)`,
      revenue: sql<number>`coalesce(sum(total_price::numeric), 0)`,
      orders: sql<number>`count(*)`,
    })
    .from(agentOrdersTable)
    .where(
      and(
        eq(agentOrdersTable.merchantId, merchantId),
        gte(agentOrdersTable.createdAt, from),
        lte(agentOrdersTable.createdAt, to),
        sql`order_status NOT IN ('cancelled', 'failed')`,
      ),
    )
    .groupBy(agentOrdersTable.sku, agentOrdersTable.productTitle)
    .orderBy(desc(sql`sum(total_price::numeric)`))
    .limit(limit);

  return rows.map((r) => ({
    sku: r.sku,
    productTitle: r.productTitle,
    units: Number(r.units ?? 0),
    revenue: Math.round(Number(r.revenue ?? 0) * 100) / 100,
    orders: Number(r.orders ?? 0),
  }));
}

export async function getQueryIntents(merchantId: string, range: DateRange) {
  const { from, to } = getDateBounds(range);

  const rows = await db
    .select({
      cluster: agentQueriesTable.intentCluster,
      count: sql<number>`count(*)`,
      matched: sql<number>`count(*) filter (where was_matched)`,
    })
    .from(agentQueriesTable)
    .where(
      and(
        eq(agentQueriesTable.merchantId, merchantId),
        gte(agentQueriesTable.createdAt, from),
        lte(agentQueriesTable.createdAt, to),
      ),
    )
    .groupBy(agentQueriesTable.intentCluster)
    .orderBy(desc(sql`count(*)`));

  return rows.map((r) => ({
    cluster: r.cluster ?? "unknown",
    count: Number(r.count ?? 0),
    matched: Number(r.matched ?? 0),
    matchRate: Number(r.count) > 0 ? Math.round((Number(r.matched) / Number(r.count)) * 1000) / 10 : 0,
  }));
}

export async function getUnmatchedQueries(merchantId: string, range: DateRange, limit = 20) {
  const { from, to } = getDateBounds(range);

  const rows = await db
    .select({
      queryText: agentQueriesTable.queryText,
      count: sql<number>`count(*)`,
      lastSeen: sql<string>`max(created_at)`,
    })
    .from(agentQueriesTable)
    .where(
      and(
        eq(agentQueriesTable.merchantId, merchantId),
        gte(agentQueriesTable.createdAt, from),
        lte(agentQueriesTable.createdAt, to),
        eq(agentQueriesTable.wasMatched, false),
        sql`query_text is not null`,
      ),
    )
    .groupBy(agentQueriesTable.queryText)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  return rows.map((r) => ({
    queryText: r.queryText,
    count: Number(r.count ?? 0),
    lastSeen: r.lastSeen,
  }));
}

export async function getConversionFunnel(merchantId: string, range: DateRange) {
  const { from, to } = getDateBounds(range);

  const [queries, carts, checkouts, orders] = await Promise.all([
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(agentQueriesTable)
      .where(
        and(
          eq(agentQueriesTable.merchantId, merchantId),
          gte(agentQueriesTable.createdAt, from),
          lte(agentQueriesTable.createdAt, to),
        ),
      ),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(transactionEventsTable)
      .where(
        and(
          eq(transactionEventsTable.merchantId, merchantId),
          eq(transactionEventsTable.eventType, "cart_create"),
          gte(transactionEventsTable.createdAt, from),
          lte(transactionEventsTable.createdAt, to),
        ),
      ),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(transactionEventsTable)
      .where(
        and(
          eq(transactionEventsTable.merchantId, merchantId),
          eq(transactionEventsTable.eventType, "checkout"),
          gte(transactionEventsTable.createdAt, from),
          lte(transactionEventsTable.createdAt, to),
        ),
      ),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(agentOrdersTable)
      .where(
        and(
          eq(agentOrdersTable.merchantId, merchantId),
          gte(agentOrdersTable.createdAt, from),
          lte(agentOrdersTable.createdAt, to),
          sql`order_status NOT IN ('cancelled', 'failed')`,
        ),
      ),
  ]);

  const q = Number(queries[0]?.cnt ?? 0);
  const c = Number(carts[0]?.cnt ?? 0);
  const ch = Number(checkouts[0]?.cnt ?? 0);
  const o = Number(orders[0]?.cnt ?? 0);

  return [
    { stage: "queries", count: q, pct: 100 },
    { stage: "add_to_cart", count: c, pct: q > 0 ? Math.round((c / q) * 1000) / 10 : 0 },
    { stage: "checkout_initiated", count: ch, pct: q > 0 ? Math.round((ch / q) * 1000) / 10 : 0 },
    { stage: "orders_placed", count: o, pct: q > 0 ? Math.round((o / q) * 1000) / 10 : 0 },
  ];
}

export async function getFailedTransactions(merchantId: string, range: DateRange, page = 1, limit = 20) {
  const { from, to } = getDateBounds(range);
  const offset = (page - 1) * limit;

  const [rows, [{ cnt }]] = await Promise.all([
    db
      .select()
      .from(transactionEventsTable)
      .where(
        and(
          eq(transactionEventsTable.merchantId, merchantId),
          eq(transactionEventsTable.status, "error"),
          gte(transactionEventsTable.createdAt, from),
          lte(transactionEventsTable.createdAt, to),
        ),
      )
      .orderBy(desc(transactionEventsTable.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(transactionEventsTable)
      .where(
        and(
          eq(transactionEventsTable.merchantId, merchantId),
          eq(transactionEventsTable.status, "error"),
          gte(transactionEventsTable.createdAt, from),
          lte(transactionEventsTable.createdAt, to),
        ),
      ),
  ]);

  return { rows, total: Number(cnt ?? 0) };
}
