import { db } from "@workspace/db";
import {
  rawProductsTable,
  normalizedProductsTable,
  attributeMappingsTable,
  valueNormalizationsTable,
  syncJobsTable,
} from "@workspace/db/schema";
import { eq, and, desc, count, inArray } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { batchProcess } from "@workspace/integrations-anthropic-ai/batch";
import { normalizeColor, COLOR_MAPPINGS } from "../data/colorMappings.js";
import { parseMeasurement } from "../data/unitConversions.js";
import { AUTOMOTIVE_ATTRIBUTE_MAP, FINISH_NORMALIZATIONS, stringSimilarity } from "../data/automotiveRules.js";
import { logger } from "../lib/logger.js";

// ── Gemini 2.5 Flash integration (Transformation Zone) ──────────
// Falls back to Claude Haiku if the Google AI key is not configured.
let geminiModel: { generateContent: (prompt: string) => Promise<{ response: { text: () => string } }> } | null = null;

async function initGemini() {
  if (geminiModel) return geminiModel;
  const apiKey = process.env["AI_INTEGRATIONS_GOOGLE_API_KEY"];
  if (!apiKey) return null;
  try {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const client = new GoogleGenerativeAI(apiKey);
    geminiModel = client.getGenerativeModel({ model: "gemini-2.5-flash" });
    return geminiModel;
  } catch {
    logger.warn("Failed to initialize Gemini 2.5 Flash, falling back to Claude Haiku");
    return null;
  }
}

/**
 * Generate text via Gemini 2.5 Flash (preferred for normalization) with
 * automatic fallback to Claude Haiku if Google AI is unavailable.
 */
async function llmGenerate(prompt: string): Promise<string> {
  const model = await initGemini();
  if (model) {
    const result = await model.generateContent(prompt);
    return result.response.text();
  }

  // Fallback: Claude Haiku
  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  });
  const block = message.content[0];
  if (block.type !== "text") return "";
  return block.text;
}

function extractJson(text: string): string {
  return text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "");
}

const SNAKE_TO_CAMEL: Record<string, string> = {
  product_title: "productTitle",
  short_description: "shortDescription",
  category_path: "categoryPath",
  image_urls: "imageUrls",
  weight_unit: "weightUnit",
  custom_attributes: "customAttributes",
};

function toNormalizedFieldKey(targetAttr: string): string {
  return SNAKE_TO_CAMEL[targetAttr] ?? targetAttr;
}

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
    const text = await llmGenerate(prompt);
    const enriched = JSON.parse(extractJson(text)) as Partial<NormalizedFields>;
    return enriched;
  } catch (err) {
    logger.warn({ sku: raw.sku, err }, "LLM enrichment failed for product");
    return {};
  }
}

const UNIVERSAL_ATTRIBUTES = [
  "product_title", "description", "short_description", "brand", "manufacturer",
  "mpn", "upc", "price", "color", "finish", "weight", "weight_unit",
  "category_path", "image_urls", "fitment",
];

async function llmDisambiguateAttributes(
  ambiguousAttrs: Array<{ sourceAttr: string; sampleValues: string[] }>,
): Promise<Record<string, { target: string | null; confidence: number }>> {
  if (ambiguousAttrs.length === 0) return {};

  const prompt = `You are an automotive parts catalog data expert. Map these ambiguous product attribute names to standard catalog fields.

Standard fields: ${UNIVERSAL_ATTRIBUTES.join(", ")}

For each attribute below, identify the best matching standard field (or null if unknown):
${ambiguousAttrs.map((a, i) => `${i + 1}. "${a.sourceAttr}" (sample values: ${a.sampleValues.slice(0, 3).join(", ") || "none"})`).join("\n")}

Respond with a JSON object mapping attribute names to { "target": string|null, "confidence": 0.0-1.0 }.
Only return valid JSON, no markdown.`;

  try {
    const text = await llmGenerate(prompt);
    return JSON.parse(extractJson(text)) as Record<string, { target: string | null; confidence: number }>;
  } catch (err) {
    logger.warn({ err }, "LLM attribute disambiguation failed");
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
  const attributeSamples: Record<string, string[]> = {};

  for (const row of products) {
    const data = (row.rawData ?? {}) as Record<string, unknown>;
    const custom = data["custom_attributes"];
    if (Array.isArray(custom)) {
      for (const attr of custom) {
        const a = attr as Record<string, unknown>;
        if (a["attribute_code"]) {
          const code = String(a["attribute_code"]);
          attributeFreq[code] = (attributeFreq[code] ?? 0) + 1;
          if (a["value"] && (!attributeSamples[code] || attributeSamples[code].length < 5)) {
            attributeSamples[code] = [...(attributeSamples[code] ?? []), String(a["value"])];
          }
        }
      }
    }
    for (const key of Object.keys(data)) {
      if (!["id", "sku", "type_id", "status", "visibility", "custom_attributes", "media_gallery_entries", "extension_attributes"].includes(key)) {
        attributeFreq[key] = (attributeFreq[key] ?? 0) + 1;
        const val = data[key];
        if (val && typeof val === "string" && (!attributeSamples[key] || attributeSamples[key].length < 5)) {
          attributeSamples[key] = [...(attributeSamples[key] ?? []), val];
        }
      }
    }
  }

  const allSourceAttrs = Object.keys(attributeFreq);
  const existingMappings = allSourceAttrs.length > 0
    ? await db
        .select({ sourceAttribute: attributeMappingsTable.sourceAttribute })
        .from(attributeMappingsTable)
        .where(and(
          eq(attributeMappingsTable.merchantId, merchantId),
          inArray(attributeMappingsTable.sourceAttribute, allSourceAttrs),
        ))
    : [];
  const existingSet = new Set(existingMappings.map((m) => m.sourceAttribute));

  const ambiguousForLlm: Array<{ sourceAttr: string; sampleValues: string[] }> = [];
  const decisionsMap = new Map<string, { targetAttribute: string | null; confidence: number; mappingStatus: string }>();

  for (const [sourceAttr, _freq] of Object.entries(attributeFreq)) {
    if (existingSet.has(sourceAttr)) continue;

    const directTarget = AUTOMOTIVE_ATTRIBUTE_MAP[sourceAttr.toLowerCase()];

    if (directTarget) {
      decisionsMap.set(sourceAttr, { targetAttribute: directTarget, confidence: 0.95, mappingStatus: "auto" });
      continue;
    }

    let bestMatch = "";
    let bestScore = 0;
    for (const ua of UNIVERSAL_ATTRIBUTES) {
      const score = stringSimilarity(sourceAttr, ua);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = ua;
      }
    }

    if (bestScore >= 0.75) {
      decisionsMap.set(sourceAttr, { targetAttribute: bestMatch, confidence: bestScore * 0.9, mappingStatus: "auto" });
    } else if (bestScore >= 0.5) {
      ambiguousForLlm.push({ sourceAttr, sampleValues: attributeSamples[sourceAttr] ?? [] });
    } else {
      decisionsMap.set(sourceAttr, { targetAttribute: null, confidence: 0, mappingStatus: "pending" });
    }
  }

  if (ambiguousForLlm.length > 0) {
    const llmResults = await llmDisambiguateAttributes(ambiguousForLlm);
    for (const { sourceAttr } of ambiguousForLlm) {
      const llmResult = llmResults[sourceAttr];
      if (llmResult) {
        const conf = llmResult.confidence ?? 0;
        decisionsMap.set(sourceAttr, {
          targetAttribute: llmResult.target,
          confidence: conf,
          mappingStatus: conf >= 0.7 ? "auto" : "pending",
        });
      } else {
        decisionsMap.set(sourceAttr, { targetAttribute: null, confidence: 0, mappingStatus: "pending" });
      }
    }
  }

  for (const [sourceAttr, decision] of decisionsMap.entries()) {
    await db.insert(attributeMappingsTable).values({
      merchantId,
      sourceAttribute: sourceAttr,
      targetAttribute: decision.targetAttribute,
      mappingStatus: decision.mappingStatus,
      confidence: decision.confidence || null,
    });
  }
}

async function llmNormalizeValues(
  targetAttribute: string | null,
  valuesToNormalize: string[],
): Promise<Record<string, string>> {
  if (valuesToNormalize.length === 0) return {};

  const prompt = `You are an automotive parts catalog normalizer. Normalize these raw product attribute values for the field "${targetAttribute ?? "unknown"}".

Values to normalize:
${valuesToNormalize.map((v, i) => `${i + 1}. "${v}"`).join("\n")}

Return a JSON object mapping each raw value to its normalized form. Use proper casing and standard terminology.
For example: { "blk": "Black", "XL size": "XL", "made in usa": "USA" }
Only return valid JSON, no markdown.`;

  try {
    const text = await llmGenerate(prompt);
    return JSON.parse(extractJson(text)) as Record<string, string>;
  } catch (err) {
    logger.warn({ err }, "LLM value normalization failed");
    return {};
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
    }

    if (val === undefined || val === null || val === "") {
      val = data[mapping.sourceAttribute];
    }

    if (val !== undefined && val !== null && val !== "") {
      const strVal = String(val).trim();
      valueCounts[strVal] = (valueCounts[strVal] ?? 0) + 1;
    }
  }

  const CLUSTER_THRESHOLD = 0.75;
  const needsLlmNormalization: string[] = [];

  const allSourceValues = Object.keys(valueCounts);
  const existingValueRows = allSourceValues.length > 0
    ? await db
        .select({ sourceValue: valueNormalizationsTable.sourceValue })
        .from(valueNormalizationsTable)
        .where(and(
          eq(valueNormalizationsTable.merchantId, merchantId),
          eq(valueNormalizationsTable.attributeMappingId, attributeMappingId),
          inArray(valueNormalizationsTable.sourceValue, allSourceValues),
        ))
    : [];
  const existingValueSet = new Set(existingValueRows.map((v) => v.sourceValue));

  const newValues: Array<{ sourceValue: string; freq: number }> = [];

  for (const [sourceValue, freq] of Object.entries(valueCounts)) {
    if (existingValueSet.has(sourceValue)) continue;
    newValues.push({ sourceValue, freq });
  }

  const existingNorms = await db
    .select({ normalizedValue: valueNormalizationsTable.normalizedValue })
    .from(valueNormalizationsTable)
    .where(and(eq(valueNormalizationsTable.merchantId, merchantId), eq(valueNormalizationsTable.attributeMappingId, attributeMappingId)));

  const resolved = new Map<string, string>();

  for (const { sourceValue } of newValues) {
    const colorResult = mapping.targetAttribute === "color" ? normalizeColor(sourceValue) : null;
    if (colorResult) {
      resolved.set(sourceValue, colorResult);
      continue;
    }

    let matched = false;
    for (const norm of existingNorms) {
      const sim = stringSimilarity(sourceValue, norm.normalizedValue);
      if (sim >= CLUSTER_THRESHOLD) {
        resolved.set(sourceValue, norm.normalizedValue);
        matched = true;
        break;
      }
    }

    if (!matched) {
      const alreadyResolved = resolved.get(sourceValue);
      if (!alreadyResolved) {
        needsLlmNormalization.push(sourceValue);
      }
    }
  }

  if (needsLlmNormalization.length > 0) {
    const llmResults = await llmNormalizeValues(mapping.targetAttribute, needsLlmNormalization);
    for (const [raw, normalized] of Object.entries(llmResults)) {
      resolved.set(raw, normalized);
    }
  }

  for (const { sourceValue, freq } of newValues) {
    const normalizedValue = resolved.get(sourceValue) ?? sourceValue;
    await db.insert(valueNormalizationsTable).values({
      merchantId,
      attributeMappingId,
      sourceValue,
      normalizedValue,
      clusterName: normalizedValue,
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

  const approvedMappingRows = await db
    .select({
      id: attributeMappingsTable.id,
      sourceAttribute: attributeMappingsTable.sourceAttribute,
      targetAttribute: attributeMappingsTable.targetAttribute,
    })
    .from(attributeMappingsTable)
    .where(and(
      eq(attributeMappingsTable.merchantId, merchantId),
      inArray(attributeMappingsTable.mappingStatus, ["auto", "manual"]),
    ));

  const attrMap = new Map<string, string>(
    approvedMappingRows
      .filter((m) => m.sourceAttribute && m.targetAttribute)
      .map((m) => [m.sourceAttribute, m.targetAttribute!]),
  );

  const mappingIdBySourceAttr = new Map<string, string>(
    approvedMappingRows
      .filter((m) => m.sourceAttribute)
      .map((m) => [m.sourceAttribute, m.id]),
  );

  const approvedValues = await db
    .select({
      sourceValue: valueNormalizationsTable.sourceValue,
      normalizedValue: valueNormalizationsTable.normalizedValue,
      attributeMappingId: valueNormalizationsTable.attributeMappingId,
    })
    .from(valueNormalizationsTable)
    .where(and(eq(valueNormalizationsTable.merchantId, merchantId), eq(valueNormalizationsTable.status, "approved")));

  const valueMapById = new Map<string, Map<string, string>>();
  for (const v of approvedValues) {
    if (!v.attributeMappingId || !v.sourceValue || !v.normalizedValue) continue;
    if (!valueMapById.has(v.attributeMappingId)) valueMapById.set(v.attributeMappingId, new Map());
    valueMapById.get(v.attributeMappingId)!.set(v.sourceValue, v.normalizedValue);
  }

  let processed = 0;
  let errors = 0;
  const errorLog: Array<{ sku: string; error: string; timestamp: string }> = [];

  const BATCH_SIZE = 20;

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
        let merged: NormalizedFields = { ...fields, ...llmData };

        const rawData = (raw.rawData ?? {}) as Record<string, unknown>;
        const customAttrs = rawData["custom_attributes"];
        const customMap: Record<string, unknown> = {};
        if (Array.isArray(customAttrs)) {
          for (const ca of customAttrs as Array<Record<string, unknown>>) {
            if (ca["attribute_code"] && ca["value"] !== undefined) {
              customMap[String(ca["attribute_code"])] = ca["value"];
            }
          }
        }
        const allRawAttrs = { ...rawData, ...customMap };

        for (const [sourceAttr, targetAttr] of attrMap) {
          const rawVal = allRawAttrs[sourceAttr];
          if (rawVal === undefined || rawVal === null || rawVal === "") continue;
          const mappingId = mappingIdBySourceAttr.get(sourceAttr);
          const valueMap = mappingId ? valueMapById.get(mappingId) : undefined;
          const normalizedVal = valueMap ? (valueMap.get(String(rawVal)) ?? String(rawVal)) : String(rawVal);

          const camelKey = toNormalizedFieldKey(targetAttr);
          const mergedRecord = merged as unknown as Record<string, unknown>;
          if (mergedRecord[camelKey] === undefined || mergedRecord[camelKey] === null || mergedRecord[camelKey] === "") {
            mergedRecord[camelKey] = normalizedVal;
          }
        }

        if (merged.customAttributes && typeof merged.customAttributes === "object") {
          const ca = merged.customAttributes as Record<string, unknown>;
          for (const [sourceAttr, targetAttr] of attrMap) {
            const rawVal = ca[sourceAttr];
            if (rawVal === undefined || rawVal === null || rawVal === "") continue;
            const mappingId = mappingIdBySourceAttr.get(sourceAttr);
            const valueMap = mappingId ? valueMapById.get(mappingId) : undefined;
            const normalizedVal = valueMap ? (valueMap.get(String(rawVal)) ?? String(rawVal)) : String(rawVal);
            const camelKey = toNormalizedFieldKey(targetAttr);
            ca[camelKey] = normalizedVal;
          }
        }

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

// ── Normalization rule preview (for UI rule cards) ───────────────
// Returns the data contract the Lovable frontend expects:
// { id, label, clusters, applied, changes: [{ from, to, count }] }

export interface NormRuleChange {
  from: string;
  to: string;
  count: number;
}

export interface NormRulePreview {
  id: string;
  label: string;
  clusters: number;
  applied: boolean;
  changes: NormRuleChange[];
}

export async function previewNormalizationRules(merchantId: string): Promise<NormRulePreview[]> {
  // Pull raw product sample to compute rule stats
  const products = await db
    .select({ rawData: rawProductsTable.rawData })
    .from(rawProductsTable)
    .where(eq(rawProductsTable.merchantId, merchantId))
    .limit(2000);

  const colorCounts: Record<string, Record<string, number>> = {};
  const finishCounts: Record<string, Record<string, number>> = {};
  const brandCounts: Record<string, number> = {};
  const unitCounts: Record<string, Record<string, number>> = {};

  for (const row of products) {
    const data = (row.rawData ?? {}) as Record<string, unknown>;
    const customAttrs: Record<string, unknown> = {};
    const custom = data["custom_attributes"];
    if (Array.isArray(custom)) {
      for (const entry of custom as Array<Record<string, unknown>>) {
        if (entry["attribute_code"] && entry["value"] !== undefined) {
          customAttrs[String(entry["attribute_code"])] = entry["value"];
        }
      }
    }
    const all = { ...data, ...customAttrs };

    // Color
    const rawColor = String(all["color"] ?? all["colour"] ?? all["clr"] ?? "").trim();
    if (rawColor) {
      const normalized = normalizeColor(rawColor) ?? rawColor;
      if (normalized.toLowerCase() !== rawColor.toLowerCase()) {
        if (!colorCounts[rawColor]) colorCounts[rawColor] = {};
        colorCounts[rawColor][normalized] = (colorCounts[rawColor][normalized] ?? 0) + 1;
      }
    }

    // Finish
    const rawFinish = String(all["finish"] ?? all["finish_type"] ?? all["surface_finish"] ?? "").trim();
    if (rawFinish) {
      const normalized = FINISH_NORMALIZATIONS[rawFinish.toLowerCase()] ?? rawFinish;
      if (normalized.toLowerCase() !== rawFinish.toLowerCase()) {
        if (!finishCounts[rawFinish]) finishCounts[rawFinish] = {};
        finishCounts[rawFinish][normalized] = (finishCounts[rawFinish][normalized] ?? 0) + 1;
      }
    }

    // Brand (track for cluster count)
    const brand = String(all["brand"] ?? all["manufacturer"] ?? "").trim();
    if (brand) brandCounts[brand] = (brandCounts[brand] ?? 0) + 1;

    // Weight/unit
    const rawWeight = String(all["weight"] ?? all["item_weight"] ?? all["wt"] ?? "").trim();
    if (rawWeight) {
      const parsed = parseMeasurement(rawWeight);
      if (parsed && parsed.unit) {
        const key = `${rawWeight} → ${parsed.value} ${parsed.unit}`;
        if (!unitCounts[rawWeight]) unitCounts[rawWeight] = {};
        unitCounts[rawWeight][`${parsed.value} ${parsed.unit}`] = (unitCounts[rawWeight][`${parsed.value} ${parsed.unit}`] ?? 0) + 1;
      }
    }
  }

  function toChanges(counts: Record<string, Record<string, number>>): NormRuleChange[] {
    const changes: NormRuleChange[] = [];
    for (const [from, targets] of Object.entries(counts)) {
      for (const [to, count] of Object.entries(targets)) {
        changes.push({ from, to, count });
      }
    }
    return changes.sort((a, b) => b.count - a.count);
  }

  // Check if normalization has been applied
  const [normJob] = await db
    .select({ status: syncJobsTable.status })
    .from(syncJobsTable)
    .where(and(eq(syncJobsTable.merchantId, merchantId), eq(syncJobsTable.jobType, "normalization")))
    .orderBy(desc(syncJobsTable.createdAt))
    .limit(1);

  const applied = normJob?.status === "completed";

  const colorChanges = toChanges(colorCounts);
  const finishChanges = toChanges(finishCounts);
  const unitChanges = toChanges(unitCounts);

  const rules: NormRulePreview[] = [
    {
      id: "color",
      label: "Color Normalization",
      clusters: new Set(colorChanges.map((c) => c.to)).size,
      applied,
      changes: colorChanges,
    },
    {
      id: "finish",
      label: "Finish Normalization",
      clusters: new Set(finishChanges.map((c) => c.to)).size,
      applied,
      changes: finishChanges,
    },
    {
      id: "brand",
      label: "Brand Normalization",
      clusters: new Set(Object.keys(brandCounts)).size,
      applied,
      changes: [], // Brand normalization requires LLM clustering
    },
    {
      id: "unit",
      label: "Unit Standardization",
      clusters: new Set(unitChanges.map((c) => c.to)).size,
      applied,
      changes: unitChanges,
    },
  ];

  return rules;
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
