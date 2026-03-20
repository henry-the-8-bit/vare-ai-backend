import { db } from "@workspace/db";
import {
  rawProductsTable,
  normalizedProductsTable,
  attributeMappingsTable,
  valueNormalizationsTable,
  syncJobsTable,
} from "@workspace/db/schema";
import { eq, and, desc, count } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { batchProcess } from "@workspace/integrations-anthropic-ai/batch";
import { normalizeColor } from "../data/colorMappings.js";
import { parseMeasurement } from "../data/unitConversions.js";
import { AUTOMOTIVE_ATTRIBUTE_MAP, FINISH_NORMALIZATIONS, stringSimilarity } from "../data/automotiveRules.js";
import { logger } from "../lib/logger.js";

type RawProductRow = {
  id: string;
  merchantId: string | null;
  sku: string;
  productType: string | null;
  rawData: unknown;
};

interface NormalizedFields {
  sku: string;
  productTitle?: string;
  description?: string;
  shortDescription?: string;
  brand?: string;
  manufacturer?: string;
  mpn?: string;
  upc?: string;
  price?: string;
  color?: string;
  finish?: string;
  weight?: string;
  weightUnit?: string;
  categoryPath?: string;
  imageUrls?: unknown;
  customAttributes?: Record<string, unknown>;
  fitmentData?: Record<string, unknown>;
  agentReadinessScore?: number;
  normalizationStatus?: string;
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

export function rulesBasedNormalize(raw: RawProductRow): NormalizedFields {
  const data = (raw.rawData ?? {}) as Record<string, unknown>;
  const customAttrs = extractCustomAttributes(data);
  const all = { ...data, ...customAttrs };

  const rawColor = String(all["color"] ?? all["colour"] ?? all["clr"] ?? "");
  const normalizedColor = rawColor ? (normalizeColor(rawColor) ?? rawColor) : undefined;

  const rawFinish = String(all["finish"] ?? all["finish_type"] ?? all["surface_finish"] ?? "");
  const normalizedFinish = rawFinish
    ? (FINISH_NORMALIZATIONS[rawFinish.toLowerCase()] ?? rawFinish)
    : undefined;

  const rawWeight = String(all["weight"] ?? all["item_weight"] ?? all["wt"] ?? "");
  const parsedWeight = rawWeight ? parseMeasurement(rawWeight) : null;

  const images = data["media_gallery_entries"];
  const imageUrls = Array.isArray(images)
    ? images.map((img: unknown) => {
        const i = img as Record<string, unknown>;
        return i["file"] ?? i["url"] ?? img;
      })
    : images
    ? [images]
    : undefined;

  const price = all["price"];
  const priceStr = price !== undefined && price !== null ? String(price) : undefined;

  const fields: NormalizedFields = {
    sku: raw.sku,
    productTitle: String(all["name"] ?? "").trim() || undefined,
    description: String(all["description"] ?? "").trim() || undefined,
    shortDescription: String(all["short_description"] ?? "").trim() || undefined,
    brand: String(all["brand"] ?? all["manufacturer"] ?? all["mfg"] ?? "").trim() || undefined,
    manufacturer: String(all["manufacturer"] ?? all["mfg"] ?? all["make"] ?? "").trim() || undefined,
    mpn: String(all["mpn"] ?? all["part_number"] ?? all["part_no"] ?? "").trim() || undefined,
    upc: String(all["upc"] ?? all["upc_code"] ?? all["ean"] ?? all["barcode"] ?? "").trim() || undefined,
    price: priceStr,
    color: normalizedColor,
    finish: normalizedFinish,
    weight: parsedWeight ? String(parsedWeight.value) : (rawWeight || undefined),
    weightUnit: parsedWeight?.unit ?? undefined,
    categoryPath: String(all["category"] ?? all["cat_path"] ?? "").trim() || undefined,
    imageUrls: imageUrls,
    customAttributes: customAttrs,
  };

  return fields;
}

export function computeAgentReadinessScore(fields: NormalizedFields): number {
  let score = 0;
  if (fields.productTitle && fields.productTitle.length >= 5) score += 15;
  if (fields.description && fields.description.length >= 50) score += 20;
  else if (fields.description && fields.description.length >= 10) score += 10;
  if (fields.price && parseFloat(fields.price) > 0) score += 20;
  if (fields.imageUrls && (Array.isArray(fields.imageUrls) ? fields.imageUrls.length > 0 : true)) score += 15;
  if (fields.brand || fields.manufacturer) score += 10;
  if (fields.mpn) score += 5;
  if (fields.color) score += 5;
  if (fields.weight) score += 5;
  if (fields.upc) score += 5;
  return Math.min(100, score);
}

export async function llmEnrichProduct(fields: NormalizedFields, raw: RawProductRow): Promise<Partial<NormalizedFields>> {
  const needsDesc = !fields.description || fields.description.length < 20;
  const needsBrand = !fields.brand;
  const needsCategory = !fields.categoryPath;

  if (!needsDesc && !needsBrand && !needsCategory) return {};

  const data = (raw.rawData ?? {}) as Record<string, unknown>;
  const prompt = `You are a product data normalizer for an automotive parts catalog. Given this raw product data, fill in the missing fields.

Product data: ${JSON.stringify({
    name: data["name"],
    sku: raw.sku,
    type: raw.productType,
    price: data["price"],
    custom_attributes: data["custom_attributes"],
  }, null, 2)}

Current normalized fields: ${JSON.stringify({
    productTitle: fields.productTitle,
    brand: fields.brand,
    color: fields.color,
    categoryPath: fields.categoryPath,
  }, null, 2)}

Please respond with a JSON object containing ONLY the fields that are missing or need improvement:
- "description": a 1-3 sentence product description (if missing/too short)
- "shortDescription": a concise 1-sentence description (if missing)
- "brand": the brand/manufacturer name (if missing)
- "categoryPath": the category path like "Automotive > Engine > Filters" (if missing)
- "color": normalized color name (if not set and inferable)

Respond ONLY with valid JSON, no markdown, no explanation.`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });

    const block = message.content[0];
    if (block.type !== "text") return {};

    const text = block.text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "");
    const enriched = JSON.parse(text) as Partial<NormalizedFields>;
    return enriched;
  } catch (err) {
    logger.warn({ sku: raw.sku, err }, "LLM enrichment failed for product");
    return {};
  }
}

export async function discoverAttributeMappings(merchantId: string): Promise<void> {
  const products = await db
    .select({ rawData: rawProductsTable.rawData })
    .from(rawProductsTable)
    .where(eq(rawProductsTable.merchantId, merchantId))
    .limit(200);

  const attributeFreq: Record<string, number> = {};

  for (const row of products) {
    const data = (row.rawData ?? {}) as Record<string, unknown>;
    const custom = data["custom_attributes"];
    if (Array.isArray(custom)) {
      for (const attr of custom) {
        const a = attr as Record<string, unknown>;
        if (a["attribute_code"]) {
          const code = String(a["attribute_code"]);
          attributeFreq[code] = (attributeFreq[code] ?? 0) + 1;
        }
      }
    }
    for (const key of Object.keys(data)) {
      if (!["id", "sku", "type_id", "status", "visibility", "custom_attributes", "media_gallery_entries", "extension_attributes"].includes(key)) {
        attributeFreq[key] = (attributeFreq[key] ?? 0) + 1;
      }
    }
  }

  const universalAttributes = ["product_title", "description", "short_description", "brand", "manufacturer", "mpn", "upc", "price", "color", "finish", "weight", "weight_unit", "category_path", "image_urls"];

  for (const [sourceAttr, freq] of Object.entries(attributeFreq)) {
    const existing = await db
      .select({ id: attributeMappingsTable.id })
      .from(attributeMappingsTable)
      .where(and(eq(attributeMappingsTable.merchantId, merchantId), eq(attributeMappingsTable.sourceAttribute, sourceAttr)))
      .limit(1);

    if (existing.length > 0) continue;

    const directTarget = AUTOMOTIVE_ATTRIBUTE_MAP[sourceAttr.toLowerCase()];

    let targetAttribute = directTarget ?? null;
    let confidence = directTarget ? 0.95 : 0;

    if (!directTarget) {
      let bestMatch = "";
      let bestScore = 0;
      for (const ua of universalAttributes) {
        const score = stringSimilarity(sourceAttr, ua);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = ua;
        }
      }
      if (bestScore > 0.6) {
        targetAttribute = bestMatch;
        confidence = bestScore * 0.8;
      }
    }

    await db.insert(attributeMappingsTable).values({
      merchantId,
      sourceAttribute: sourceAttr,
      targetAttribute: targetAttribute,
      mappingStatus: directTarget ? "auto" : (confidence > 0.7 ? "auto" : "pending"),
      confidence: confidence || null,
    });
  }
}

export async function discoverValueClusters(merchantId: string, attributeMappingId: string): Promise<void> {
  const [mapping] = await db
    .select()
    .from(attributeMappingsTable)
    .where(and(eq(attributeMappingsTable.id, attributeMappingId), eq(attributeMappingsTable.merchantId, merchantId)))
    .limit(1);

  if (!mapping) return;

  const products = await db
    .select({ rawData: rawProductsTable.rawData })
    .from(rawProductsTable)
    .where(eq(rawProductsTable.merchantId, merchantId))
    .limit(500);

  const valueCounts: Record<string, number> = {};

  for (const row of products) {
    const data = (row.rawData ?? {}) as Record<string, unknown>;
    const custom = data["custom_attributes"];
    let val: unknown;

    if (Array.isArray(custom)) {
      const found = (custom as Array<Record<string, unknown>>).find(
        (a) => a["attribute_code"] === mapping.sourceAttribute,
      );
      val = found?.["value"];
    } else {
      val = data[mapping.sourceAttribute];
    }

    if (val !== undefined && val !== null && val !== "") {
      const strVal = String(val).trim();
      valueCounts[strVal] = (valueCounts[strVal] ?? 0) + 1;
    }
  }

  const CLUSTER_THRESHOLD = 0.75;

  for (const [sourceValue, freq] of Object.entries(valueCounts)) {
    const existing = await db
      .select({ id: valueNormalizationsTable.id })
      .from(valueNormalizationsTable)
      .where(and(
        eq(valueNormalizationsTable.merchantId, merchantId),
        eq(valueNormalizationsTable.attributeMappingId, attributeMappingId),
        eq(valueNormalizationsTable.sourceValue, sourceValue),
      ))
      .limit(1);

    if (existing.length > 0) continue;

    const existingNorms = await db
      .select({ normalizedValue: valueNormalizationsTable.normalizedValue })
      .from(valueNormalizationsTable)
      .where(and(eq(valueNormalizationsTable.merchantId, merchantId), eq(valueNormalizationsTable.attributeMappingId, attributeMappingId)));

    let normalizedValue = sourceValue;
    let clusterName = sourceValue;

    const colorResult = mapping.targetAttribute === "color" ? normalizeColor(sourceValue) : null;
    if (colorResult) {
      normalizedValue = colorResult;
      clusterName = colorResult;
    } else {
      for (const existing2 of existingNorms) {
        const sim = stringSimilarity(sourceValue, existing2.normalizedValue);
        if (sim >= CLUSTER_THRESHOLD) {
          normalizedValue = existing2.normalizedValue;
          clusterName = existing2.normalizedValue;
          break;
        }
      }
    }

    await db.insert(valueNormalizationsTable).values({
      merchantId,
      attributeMappingId,
      sourceValue,
      normalizedValue,
      clusterName,
      status: "suggested",
      productCount: freq,
    });
  }
}

export async function runBatchNormalization(jobId: string, merchantId: string): Promise<void> {
  const startTime = new Date();
  await db.update(syncJobsTable).set({ status: "running", startedAt: startTime }).where(eq(syncJobsTable.id, jobId));

  const products = await db
    .select()
    .from(rawProductsTable)
    .where(eq(rawProductsTable.merchantId, merchantId));

  const total = products.length;
  await db.update(syncJobsTable).set({ totalRecords: total }).where(eq(syncJobsTable.id, jobId));

  let processed = 0;
  let errors = 0;
  const errorLog: Array<{ sku: string; error: string; timestamp: string }> = [];

  const BATCH_SIZE = 20;
  const LLM_BATCH_SIZE = 5;

  const rulesResults: Array<{ raw: RawProductRow; fields: NormalizedFields }> = [];

  for (const raw of products) {
    try {
      const fields = rulesBasedNormalize(raw);
      rulesResults.push({ raw, fields });
    } catch (err) {
      errors++;
      errorLog.push({ sku: raw.sku, error: String(err), timestamp: new Date().toISOString() });
    }
  }

  const needsLlm = rulesResults.filter(({ fields }) => {
    const score = computeAgentReadinessScore(fields);
    return score < 60;
  });

  const llmEnrichedMap = new Map<string, Partial<NormalizedFields>>();

  type NeedsLlmItem = { raw: RawProductRow; fields: NormalizedFields };
  if (needsLlm.length > 0) {
    await batchProcess(
      needsLlm,
      async (item: NeedsLlmItem) => {
        const enriched = await llmEnrichProduct(item.fields, item.raw);
        llmEnrichedMap.set(item.raw.sku, enriched);
        return enriched;
      },
      { concurrency: 2, retries: 3 },
    );
  }

  for (let i = 0; i < rulesResults.length; i += BATCH_SIZE) {
    const batch = rulesResults.slice(i, i + BATCH_SIZE);

    for (const { raw, fields } of batch) {
      try {
        const llmData = llmEnrichedMap.get(raw.sku) ?? {};
        const merged: NormalizedFields = { ...fields, ...llmData };
        const score = computeAgentReadinessScore(merged);

        const status = score >= 80 ? "complete" : score >= 40 ? "partial" : "needs_review";

        await db
          .insert(normalizedProductsTable)
          .values({
            merchantId,
            rawProductId: raw.id,
            sku: raw.sku,
            productTitle: merged.productTitle ?? null,
            description: merged.description ?? null,
            shortDescription: merged.shortDescription ?? null,
            brand: merged.brand ?? null,
            manufacturer: merged.manufacturer ?? null,
            mpn: merged.mpn ?? null,
            upc: merged.upc ?? null,
            price: merged.price ?? null,
            color: merged.color ?? null,
            finish: merged.finish ?? null,
            weight: merged.weight ?? null,
            weightUnit: merged.weightUnit ?? null,
            categoryPath: merged.categoryPath ?? null,
            imageUrls: merged.imageUrls ?? null,
            customAttributes: merged.customAttributes ?? null,
            agentReadinessScore: score,
            normalizationStatus: status,
            normalizedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [normalizedProductsTable.merchantId, normalizedProductsTable.sku],
            set: {
              productTitle: merged.productTitle ?? null,
              description: merged.description ?? null,
              shortDescription: merged.shortDescription ?? null,
              brand: merged.brand ?? null,
              manufacturer: merged.manufacturer ?? null,
              mpn: merged.mpn ?? null,
              upc: merged.upc ?? null,
              price: merged.price ?? null,
              color: merged.color ?? null,
              finish: merged.finish ?? null,
              weight: merged.weight ?? null,
              weightUnit: merged.weightUnit ?? null,
              categoryPath: merged.categoryPath ?? null,
              imageUrls: merged.imageUrls ?? null,
              customAttributes: merged.customAttributes ?? null,
              agentReadinessScore: score,
              normalizationStatus: status,
              normalizedAt: new Date(),
              updatedAt: new Date(),
            },
          });

        processed++;
      } catch (err) {
        errors++;
        errorLog.push({ sku: raw.sku, error: String(err), timestamp: new Date().toISOString() });
      }
    }

    await db.update(syncJobsTable).set({ processedRecords: processed, errorCount: errors }).where(eq(syncJobsTable.id, jobId));
  }

  const completedAt = new Date();
  const normStatus = total === 0 ? "completed" : (errors < total ? "completed" : "failed");
  await db.update(syncJobsTable).set({
    status: normStatus,
    processedRecords: processed,
    errorCount: errors,
    errorLog: errorLog.length > 0 ? errorLog : null,
    completedAt,
    durationSeconds: Math.round((completedAt.getTime() - startTime.getTime()) / 1000),
  }).where(eq(syncJobsTable.id, jobId));
}

export async function previewNormalization(merchantId: string, limit = 10): Promise<Array<{ raw: Record<string, unknown>; normalized: NormalizedFields; score: number }>> {
  const products = await db
    .select()
    .from(rawProductsTable)
    .where(eq(rawProductsTable.merchantId, merchantId))
    .limit(limit);

  return products.map((raw) => {
    const fields = rulesBasedNormalize(raw);
    const score = computeAgentReadinessScore(fields);
    return { raw: (raw.rawData ?? {}) as Record<string, unknown>, normalized: fields, score };
  });
}
