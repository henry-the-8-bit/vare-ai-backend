import { db } from "@workspace/db";
import { insightsTable } from "@workspace/db/schema";
import { eq, desc, gte } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "../lib/logger.js";
import { getKpis, getQueryIntents, getUnmatchedQueries, type DateRange } from "./metricsService.js";

const INSIGHT_TYPES = ["revenue", "conversion", "query_gap", "platform_mix", "growth_opportunity"];

export async function getOrGenerateInsights(merchantId: string, range: DateRange = "30d") {
  const cacheWindow = new Date();
  cacheWindow.setHours(cacheWindow.getHours() - 6);

  const existing = await db
    .select()
    .from(insightsTable)
    .where(eq(insightsTable.merchantId, merchantId))
    .orderBy(desc(insightsTable.createdAt))
    .limit(10);

  const fresh = existing.filter((i) => i.createdAt && i.createdAt >= cacheWindow);

  if (fresh.length >= 3) {
    return fresh;
  }

  return generateInsights(merchantId, range);
}

async function generateInsights(merchantId: string, range: DateRange) {
  const [kpis, intents, unmatched] = await Promise.all([
    getKpis(merchantId, range),
    getQueryIntents(merchantId, range),
    getUnmatchedQueries(merchantId, range, 5),
  ]);

  const context = JSON.stringify({
    kpis: {
      revenue: kpis.revenue.value,
      revenuePct: kpis.revenue.pctChange,
      orders: kpis.orders.value,
      ordersPct: kpis.orders.pctChange,
      queries: kpis.queries.value,
      conversion: kpis.conversionRate.value,
      aov: kpis.aov.value,
    },
    topIntents: intents.slice(0, 5).map((i) => ({ cluster: i.cluster, count: i.count, matchRate: i.matchRate })),
    unmatchedSamples: unmatched.slice(0, 5).map((u) => u.queryText),
    range,
  });

  const prompt = `You are an AI analyst for Vare AI, a platform that enables AI agents to browse and purchase auto parts.
  
Analyze these metrics for a merchant and generate 3-5 actionable insights in JSON array format.
Each insight must be a JSON object with:
- insightType: one of ${INSIGHT_TYPES.join(", ")}
- badge: short label (e.g., "Revenue Up 12%", "Query Gap Detected", "New Opportunity")
- text: 1-2 sentences of insight with specific numbers
- actionLabel: short CTA (e.g., "View Products", "Optimize Catalog", "Add Inventory")

Metrics context:
${context}

Respond ONLY with a valid JSON array of insight objects. No markdown, no explanation.`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const rawText = message.content[0]?.type === "text" ? message.content[0].text : "[]";
    const raw = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    const parsed = JSON.parse(raw) as Array<{
      insightType: string;
      badge: string;
      text: string;
      actionLabel: string;
    }>;

    await db.delete(insightsTable).where(eq(insightsTable.merchantId, merchantId));

    const rows = await db
      .insert(insightsTable)
      .values(
        parsed.slice(0, 5).map((insight) => ({
          merchantId,
          insightType: insight.insightType ?? "general",
          badge: insight.badge ?? "",
          text: insight.text ?? "",
          actionLabel: insight.actionLabel ?? "View Details",
          dateRange: range,
        })),
      )
      .returning();

    return rows;
  } catch (err) {
    logger.error({ merchantId, err }, "Failed to generate AI insights");
    const fallback = await db
      .select()
      .from(insightsTable)
      .where(eq(insightsTable.merchantId, merchantId))
      .orderBy(desc(insightsTable.createdAt))
      .limit(5);
    return fallback;
  }
}
