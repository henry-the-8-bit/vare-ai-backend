import { db } from "@workspace/db";
import { rawProductsTable, normalizedProductsTable, fitmentConfigsTable } from "@workspace/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { batchProcess } from "@workspace/integrations-anthropic-ai/batch";
import { logger } from "../lib/logger.js";

export interface FitmentAssessment {
  totalProducts: number;
  structuredFitment: number;
  textFitment: number;
  noFitment: number;
  structuredPct: number;
  textPct: number;
  noFitmentPct: number;
  sampleStructured: unknown[];
  sampleTextFitment: Array<{ sku: string; fitmentText: string }>;
}

export interface FitmentData {
  make?: string;
  model?: string;
  year?: number | string;
  trim?: string;
  engine?: string;
  submodel?: string;
  notes?: string;
  source: "structured" | "text_extracted" | "mpn_cross" | "none";
}

const FITMENT_FIELDS = [
  "fitment",
  "vehicle_fitment",
  "compatibility",
  "fits",
  "vehicle_compatibility",
  "application",
  "year_from",
  "year_to",
  "make",
  "model",
  "trim",
  "engine",
];

const FITMENT_TEXT_PATTERNS = [
  /(?:fits?|for|compatible\s+with)\s+(\d{4})\s+([A-Za-z]+)\s+([A-Za-z0-9]+)/gi,
  /(\d{4})\s*[-–]\s*(\d{4})\s+([A-Za-z]+)\s+([A-Za-z0-9]+)/gi,
  /([A-Za-z]+)\s+(\d{4})\s*[-–]\s*(\d{4})/gi,
];

export async function assessFitment(merchantId: string): Promise<FitmentAssessment> {
  const products = await db
    .select({ sku: rawProductsTable.sku, rawData: rawProductsTable.rawData })
    .from(rawProductsTable)
    .where(eq(rawProductsTable.merchantId, merchantId))
    .limit(1000);

  let structured = 0;
  let textFitment = 0;
  let noFitment = 0;
  const sampleStructured: unknown[] = [];
  const sampleTextFitment: Array<{ sku: string; fitmentText: string }> = [];

  for (const row of products) {
    const data = (row.rawData ?? {}) as Record<string, unknown>;
    const customAttrs = extractCustomAttributes(data);
    const all = { ...data, ...customAttrs };

    const hasStructured = FITMENT_FIELDS.some((f) => {
      const val = all[f];
      return val !== undefined && val !== null && val !== "";
    });

    if (hasStructured) {
      structured++;
      if (sampleStructured.length < 3) {
        sampleStructured.push({ sku: row.sku, fitmentFields: FITMENT_FIELDS.filter((f) => all[f]) });
      }
      continue;
    }

    const desc = String(all["description"] ?? all["short_description"] ?? all["name"] ?? "");
    let hasFitmentText = false;
    for (const pattern of FITMENT_TEXT_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(desc)) {
        hasFitmentText = true;
        if (sampleTextFitment.length < 3) {
          sampleTextFitment.push({ sku: row.sku, fitmentText: desc.slice(0, 200) });
        }
        break;
      }
    }

    if (hasFitmentText) textFitment++;
    else noFitment++;
  }

  const total = products.length;
  return {
    totalProducts: total,
    structuredFitment: structured,
    textFitment,
    noFitment,
    structuredPct: total > 0 ? Math.round((structured / total) * 100) : 0,
    textPct: total > 0 ? Math.round((textFitment / total) * 100) : 0,
    noFitmentPct: total > 0 ? Math.round((noFitment / total) * 100) : 0,
    sampleStructured,
    sampleTextFitment,
  };
}

export async function extractFitmentFromDescriptions(
  merchantId: string,
  skus?: string[],
): Promise<Array<{ sku: string; fitmentData: FitmentData | null }>> {
  const [fitmentCfg] = await db
    .select()
    .from(fitmentConfigsTable)
    .where(eq(fitmentConfigsTable.merchantId, merchantId))
    .limit(1);

  const source = fitmentCfg?.source ?? "description_text";
  const enabled = fitmentCfg?.enabled ?? true;
  const configuredFields = Array.isArray(fitmentCfg?.fields) ? (fitmentCfg.fields as string[]) : [];

  const query = db
    .select({ id: rawProductsTable.id, sku: rawProductsTable.sku, rawData: rawProductsTable.rawData })
    .from(rawProductsTable)
    .where(
      skus && skus.length > 0
        ? and(eq(rawProductsTable.merchantId, merchantId), inArray(rawProductsTable.sku, skus))
        : eq(rawProductsTable.merchantId, merchantId),
    )
    .limit(100);

  const products = await query;

  if (!enabled) {
    return products.map((p) => ({ sku: p.sku, fitmentData: null }));
  }

  type FitmentRow = { id: string; sku: string; rawData: unknown };
  const results = await batchProcess(
    products,
    async (row: FitmentRow) => {
      const data = (row.rawData ?? {}) as Record<string, unknown>;
      const customAttrs = extractCustomAttributes(data);
      const merged = { ...data, ...customAttrs };

      if (source === "structured_fields") {
        const fieldsToCheck = configuredFields.length > 0 ? configuredFields : FITMENT_FIELDS;
        const structured: Record<string, unknown> = {};
        for (const field of fieldsToCheck) {
          if (merged[field] !== undefined && merged[field] !== null && merged[field] !== "") {
            structured[field] = merged[field];
          }
        }
        if (Object.keys(structured).length === 0) return { sku: row.sku, fitmentData: null };
        const fitmentData: FitmentData = {
          make: String(structured["make"] ?? ""),
          model: String(structured["model"] ?? ""),
          year: String(structured["year_from"] ?? structured["year"] ?? ""),
          trim: String(structured["trim"] ?? ""),
          engine: String(structured["engine"] ?? ""),
          notes: Object.entries(structured).map(([k, v]) => `${k}: ${v}`).join("; "),
          source: "structured",
        };
        return { sku: row.sku, fitmentData };
      }

      if (source === "mpn_cross") {
        const mpn = String(merged["manufacturer_part_number"] ?? merged["mpn"] ?? merged["part_number"] ?? "");
        if (!mpn) return { sku: row.sku, fitmentData: null };

        const prompt = `Given this automotive part number (MPN), infer possible vehicle fitment data. Return JSON only.

MPN: "${mpn}"
SKU: "${row.sku}"

Return a JSON object with: make, model, year (or year range as string), trim, engine, submodel, notes.
If the MPN provides no fitment information, return null.
Only return valid JSON, no markdown.`;

        try {
          const message = await anthropic.messages.create({
            model: "claude-haiku-4-5",
            max_tokens: 8192,
            messages: [{ role: "user", content: prompt }],
          });
          const block = message.content[0];
          if (block.type !== "text") return { sku: row.sku, fitmentData: null };
          const text = block.text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "");
          if (text === "null") return { sku: row.sku, fitmentData: null };
          const parsed = JSON.parse(text) as FitmentData;
          return { sku: row.sku, fitmentData: { ...parsed, source: "mpn_cross" as const } };
        } catch {
          return { sku: row.sku, fitmentData: null };
        }
      }

      const desc = String(merged["description"] ?? merged["short_description"] ?? merged["name"] ?? "");
      if (!desc || desc.length < 10) return { sku: row.sku, fitmentData: null };

      const prompt = `Extract vehicle fitment data from this product description. Return JSON only.

Description: "${desc.slice(0, 500)}"

Return a JSON object with: make, model, year (or year range as string), trim, engine, submodel, notes.
If no fitment data found, return null.
Only return valid JSON, no markdown.`;

      try {
        const message = await anthropic.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: 8192,
          messages: [{ role: "user", content: prompt }],
        });

        const block = message.content[0];
        if (block.type !== "text") return { sku: row.sku, fitmentData: null };

        const text = block.text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "");
        if (text === "null") return { sku: row.sku, fitmentData: null };

        const parsed = JSON.parse(text) as FitmentData;
        return { sku: row.sku, fitmentData: { ...parsed, source: "text_extracted" as const } };
      } catch {
        return { sku: row.sku, fitmentData: null };
      }
    },
    { concurrency: 2, retries: 3 },
  );

  return results;
}

export async function applyFitmentData(
  merchantId: string,
  fitmentResults: Array<{ sku: string; fitmentData: FitmentData | null }>,
): Promise<{ updated: number; skipped: number }> {
  let updated = 0;
  let skipped = 0;

  for (const { sku, fitmentData } of fitmentResults) {
    if (!fitmentData) { skipped++; continue; }

    const [existing] = await db
      .select({ id: normalizedProductsTable.id })
      .from(normalizedProductsTable)
      .where(and(eq(normalizedProductsTable.merchantId, merchantId), eq(normalizedProductsTable.sku, sku)))
      .limit(1);

    if (existing) {
      await db
        .update(normalizedProductsTable)
        .set({ fitmentData: (fitmentData as unknown) as Record<string, unknown>, updatedAt: new Date() })
        .where(and(eq(normalizedProductsTable.merchantId, merchantId), eq(normalizedProductsTable.sku, sku)));
      updated++;
    } else {
      skipped++;
    }
  }

  return { updated, skipped };
}

function extractCustomAttributes(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const custom = data["custom_attributes"];
  if (Array.isArray(custom)) {
    for (const entry of custom) {
      if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        if (e["attribute_code"] && e["value"] !== undefined) {
          result[String(e["attribute_code"])] = e["value"];
        }
      }
    }
  }
  return result;
}
