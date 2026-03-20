import { db } from "@workspace/db";
import { rawProductsTable } from "@workspace/db/schema";
import { eq, count, sql } from "drizzle-orm";

export interface IssueCard {
  issue: string;
  severity: "error" | "warning" | "info";
  count: number;
  pct: number;
  suggestion: string;
}

export interface AttributeHeatmapEntry {
  attribute: string;
  coverage: number;
  productCount: number;
  missingCount: number;
}

export interface HealthScanResult {
  merchantId: string;
  totalProducts: number;
  scannedAt: string;
  overallHealthScore: number;
  issueCards: IssueCard[];
  attributeHeatmap: AttributeHeatmapEntry[];
  productTypeSummary: Record<string, number>;
  readinessDistribution: {
    ready: number;
    needsWork: number;
    incomplete: number;
  };
}

const TRACKED_ATTRIBUTES = [
  "name",
  "description",
  "short_description",
  "price",
  "sku",
  "weight",
  "color",
  "manufacturer",
  "brand",
  "media_gallery_entries",
];

type RawProductRow = {
  sku: string;
  productType: string | null;
  rawData: unknown;
};

export async function runHealthScan(merchantId: string): Promise<HealthScanResult> {
  const products = await db
    .select({
      sku: rawProductsTable.sku,
      productType: rawProductsTable.productType,
      rawData: rawProductsTable.rawData,
    })
    .from(rawProductsTable)
    .where(eq(rawProductsTable.merchantId, merchantId));

  const total = products.length;

  if (total === 0) {
    return {
      merchantId,
      totalProducts: 0,
      scannedAt: new Date().toISOString(),
      overallHealthScore: 0,
      issueCards: [],
      attributeHeatmap: [],
      productTypeSummary: {},
      readinessDistribution: { ready: 0, needsWork: 0, incomplete: 0 },
    };
  }

  const issueCounts = {
    missingDescription: 0,
    thinTitle: 0,
    noImages: 0,
    missingPrice: 0,
    missingWeight: 0,
    missingBrand: 0,
    missingColor: 0,
  };

  const attrCoverage: Record<string, number> = {};
  for (const attr of TRACKED_ATTRIBUTES) attrCoverage[attr] = 0;

  const productTypeCounts: Record<string, number> = {};
  let readyCount = 0, needsWorkCount = 0, incompleteCount = 0;

  for (const row of products) {
    const data = (row.rawData ?? {}) as Record<string, unknown>;
    const customAttrs = extractCustomAttributes(data);
    const merged = { ...data, ...customAttrs };

    const pt = row.productType ?? "unknown";
    productTypeCounts[pt] = (productTypeCounts[pt] ?? 0) + 1;

    const title = String(merged["name"] ?? "");
    const desc = String(merged["description"] ?? merged["short_description"] ?? "");
    const price = merged["price"];
    const images = merged["media_gallery_entries"];
    const weight = merged["weight"] ?? customAttrs["weight"];
    const brand = merged["manufacturer"] ?? customAttrs["brand"] ?? customAttrs["manufacturer"];
    const color = customAttrs["color"];

    if (!desc || desc.length < 20) issueCounts.missingDescription++;
    if (!title || title.length < 5) issueCounts.thinTitle++;
    if (!images || (Array.isArray(images) && images.length === 0)) issueCounts.noImages++;
    if (!price) issueCounts.missingPrice++;
    if (!weight) issueCounts.missingWeight++;
    if (!brand) issueCounts.missingBrand++;
    if (!color) issueCounts.missingColor++;

    for (const attr of TRACKED_ATTRIBUTES) {
      const val = merged[attr];
      if (val !== undefined && val !== null && val !== "") {
        attrCoverage[attr]++;
      }
    }

    const scoreParts = [
      title && title.length >= 5 ? 20 : 0,
      desc && desc.length >= 20 ? 20 : 0,
      price ? 20 : 0,
      images && (!Array.isArray(images) || images.length > 0) ? 20 : 0,
      (brand || color) ? 20 : 0,
    ];
    const score = scoreParts.reduce((a, b) => a + b, 0);
    if (score >= 80) readyCount++;
    else if (score >= 40) needsWorkCount++;
    else incompleteCount++;
  }

  const issueCards: IssueCard[] = [
    {
      issue: "Missing or thin description",
      severity: "error" as const,
      count: issueCounts.missingDescription,
      pct: Math.round((issueCounts.missingDescription / total) * 100),
      suggestion: "Add product descriptions of at least 20 characters for agent readability.",
    },
    {
      issue: "Thin product title",
      severity: "warning" as const,
      count: issueCounts.thinTitle,
      pct: Math.round((issueCounts.thinTitle / total) * 100),
      suggestion: "Titles should be at least 5 characters for accurate agent search.",
    },
    {
      issue: "No product images",
      severity: "error" as const,
      count: issueCounts.noImages,
      pct: Math.round((issueCounts.missingDescription / total) * 100),
      suggestion: "Add at least one product image to improve agent-readiness score.",
    },
    {
      issue: "Missing price",
      severity: "error" as const,
      count: issueCounts.missingPrice,
      pct: Math.round((issueCounts.missingPrice / total) * 100),
      suggestion: "Products without a price cannot be ordered by agents.",
    },
    {
      issue: "Missing weight",
      severity: "info" as const,
      count: issueCounts.missingWeight,
      pct: Math.round((issueCounts.missingWeight / total) * 100),
      suggestion: "Weight data improves shipping cost estimation by agents.",
    },
    {
      issue: "Missing brand/manufacturer",
      severity: "warning" as const,
      count: issueCounts.missingBrand,
      pct: Math.round((issueCounts.missingBrand / total) * 100),
      suggestion: "Brand data is required for fitment and catalog matching.",
    },
    {
      issue: "Missing color attribute",
      severity: "info" as const,
      count: issueCounts.missingColor,
      pct: Math.round((issueCounts.missingColor / total) * 100),
      suggestion: "Color data improves product searchability for agents.",
    },
  ].filter((c) => c.count > 0);

  const attributeHeatmap: AttributeHeatmapEntry[] = TRACKED_ATTRIBUTES.map((attr) => ({
    attribute: attr,
    coverage: Math.round((attrCoverage[attr] / total) * 100),
    productCount: attrCoverage[attr],
    missingCount: total - attrCoverage[attr],
  }));

  const avgCoverage = attributeHeatmap.reduce((a, b) => a + b.coverage, 0) / attributeHeatmap.length;
  const issueDeduction = Math.min(30, (issueCounts.missingDescription / total) * 15 + (issueCounts.noImages / total) * 15);
  const overallHealthScore = Math.round(Math.max(0, avgCoverage - issueDeduction));

  return {
    merchantId,
    totalProducts: total,
    scannedAt: new Date().toISOString(),
    overallHealthScore,
    issueCards,
    attributeHeatmap,
    productTypeSummary: productTypeCounts,
    readinessDistribution: {
      ready: readyCount,
      needsWork: needsWorkCount,
      incomplete: incompleteCount,
    },
  };
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
