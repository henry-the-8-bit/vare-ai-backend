import { parse } from "csv-parse/sync";
import { db } from "@workspace/db";
import {
  csvUploadsTable,
  csvColumnMappingsTable,
  csvFieldOverridesTable,
  normalizedProductsTable,
} from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { getTransform } from "../data/columnTransforms.js";

export const VARE_FIELDS = [
  { field: "sku", label: "SKU", required: true },
  { field: "name", label: "Product Name", required: true },
  { field: "description", label: "Description", required: false },
  { field: "short_description", label: "Short Description", required: false },
  { field: "brand", label: "Brand", required: false },
  { field: "manufacturer", label: "Manufacturer", required: false },
  { field: "mpn", label: "MPN / Part Number", required: false },
  { field: "upc", label: "UPC / Barcode", required: false },
  { field: "price", label: "Price", required: false },
  { field: "category", label: "Category", required: false },
  { field: "color", label: "Color", required: false },
  { field: "finish", label: "Finish", required: false },
  { field: "weight", label: "Weight", required: false },
  { field: "weight_unit", label: "Weight Unit", required: false },
  { field: "image_url", label: "Image URL", required: false },
  { field: "stock_qty", label: "Stock Quantity", required: false },
  { field: "skip", label: "Skip this column", required: false },
] as const;

const ALIASES: Record<string, string> = {
  // SKU
  sku: "sku", product_id: "sku", item_id: "sku", part_number: "sku",
  part_no: "sku", partnumber: "sku", partnum: "sku", "item #": "sku",
  item_number: "sku", product_code: "sku", article_number: "sku",
  // Name
  name: "name", title: "name", product_name: "name", product_title: "name",
  item_name: "name", item_title: "name", product: "name",
  // Description
  description: "description", desc: "description", long_description: "description",
  full_description: "description", body: "description",
  // Short description
  short_description: "short_description", summary: "short_description",
  excerpt: "short_description", teaser: "short_description",
  // Brand
  brand: "brand", brand_name: "brand", make: "brand",
  // Manufacturer
  manufacturer: "manufacturer", mfg: "manufacturer", mfr: "manufacturer",
  vendor: "manufacturer",
  // MPN
  mpn: "mpn", model: "mpn", model_number: "mpn", model_no: "mpn",
  part_num: "mpn", oem: "mpn",
  // UPC
  upc: "upc", barcode: "upc", ean: "upc", gtin: "upc", isbn: "upc",
  // Price
  price: "price", retail_price: "price", list_price: "price", msrp: "price",
  unit_price: "price", cost: "price", sale_price: "price",
  // Category
  category: "category", category_name: "category", product_category: "category",
  department: "category", type: "category", product_type: "category",
  // Color
  color: "color", colour: "color",
  // Finish
  finish: "finish", surface: "finish", coating: "finish",
  // Weight
  weight: "weight", shipping_weight: "weight", gross_weight: "weight",
  // Weight unit
  weight_unit: "weight_unit", weight_uom: "weight_unit",
  // Image
  image_url: "image_url", image: "image_url", photo: "image_url",
  picture: "image_url", thumbnail: "image_url", main_image: "image_url",
  // Stock
  stock_qty: "stock_qty", qty: "stock_qty", quantity: "stock_qty",
  stock: "stock_qty", inventory: "stock_qty", on_hand: "stock_qty",
};

function normalizeKey(header: string): string {
  return header.toLowerCase().trim().replace(/\s+/g, "_").replace(/[^a-z0-9_#]/g, "");
}

export function suggestMappings(headers: string[]): { csvHeader: string; vareField: string | null; confidence: "high" | "low" }[] {
  return headers.map((h) => {
    const key = normalizeKey(h);
    const match = ALIASES[key] ?? null;
    return {
      csvHeader: h,
      vareField: match,
      confidence: match ? "high" : "low",
    };
  });
}

export async function parseAndSaveCsv(
  buffer: Buffer,
  filename: string,
  merchantId: string,
): Promise<{ uploadId: string; headers: string[]; rowCount: number; suggestions: ReturnType<typeof suggestMappings> }> {
  let rows: Record<string, string>[];
  try {
    rows = parse(buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
    }) as Record<string, string>[];
  } catch (err) {
    throw new Error(`Failed to parse CSV: ${err instanceof Error ? err.message : "unknown error"}`);
  }

  if (rows.length === 0) throw new Error("CSV file is empty or has no data rows");

  const headers = Object.keys(rows[0]!);
  if (headers.length === 0) throw new Error("CSV file has no columns");

  const [upload] = await db
    .insert(csvUploadsTable)
    .values({
      merchantId,
      filename,
      originalHeaders: headers,
      rowCount: rows.length,
      rawRows: rows,
      status: "pending_mapping",
    })
    .returning({ id: csvUploadsTable.id });

  return {
    uploadId: upload!.id,
    headers,
    rowCount: rows.length,
    suggestions: suggestMappings(headers),
  };
}

export async function confirmMappings(
  uploadId: string,
  merchantId: string,
  mappings: { csvHeader: string; vareField: string | null; transformId?: string | null }[],
  fieldOverrides?: { vareField: string; strategy: "default_value" | "ai_fill"; defaultValue?: string }[],
): Promise<void> {
  const [upload] = await db
    .select({ id: csvUploadsTable.id })
    .from(csvUploadsTable)
    .where(and(eq(csvUploadsTable.id, uploadId), eq(csvUploadsTable.merchantId, merchantId)))
    .limit(1);

  if (!upload) throw new Error("Upload not found");

  const skuMapping = mappings.find((m) => m.vareField === "sku");
  const nameMapping = mappings.find((m) => m.vareField === "name");
  if (!skuMapping) throw new Error("A column must be mapped to 'sku'");
  if (!nameMapping) throw new Error("A column must be mapped to 'name'");

  // Clear existing mappings and overrides
  await db.delete(csvColumnMappingsTable).where(eq(csvColumnMappingsTable.csvUploadId, uploadId));
  await db.delete(csvFieldOverridesTable).where(eq(csvFieldOverridesTable.csvUploadId, uploadId));

  if (mappings.length > 0) {
    await db.insert(csvColumnMappingsTable).values(
      mappings.map((m) => ({
        merchantId,
        csvUploadId: uploadId,
        csvHeader: m.csvHeader,
        vareField: m.vareField ?? null,
        transformId: m.transformId ?? null,
      })),
    );
  }

  // Store field overrides (defaults / AI-fill markers for unmapped required fields)
  if (fieldOverrides && fieldOverrides.length > 0) {
    await db.insert(csvFieldOverridesTable).values(
      fieldOverrides.map((o) => ({
        merchantId,
        csvUploadId: uploadId,
        vareField: o.vareField,
        strategy: o.strategy,
        defaultValue: o.strategy === "default_value" ? (o.defaultValue ?? null) : null,
      })),
    );
  }

  await db
    .update(csvUploadsTable)
    .set({ status: "mapped", updatedAt: new Date() })
    .where(eq(csvUploadsTable.id, uploadId));
}

export async function runImport(uploadId: string, merchantId: string): Promise<{ imported: number; errors: number }> {
  const [upload] = await db
    .select()
    .from(csvUploadsTable)
    .where(and(eq(csvUploadsTable.id, uploadId), eq(csvUploadsTable.merchantId, merchantId)))
    .limit(1);

  if (!upload) throw new Error("Upload not found");
  if (upload.status !== "mapped") throw new Error("Confirm column mappings before importing");

  const mappings = await db
    .select()
    .from(csvColumnMappingsTable)
    .where(eq(csvColumnMappingsTable.csvUploadId, uploadId));

  const overrides = await db
    .select()
    .from(csvFieldOverridesTable)
    .where(eq(csvFieldOverridesTable.csvUploadId, uploadId));

  const fieldMap: Record<string, string> = {};
  const transformMap: Record<string, string> = {}; // csvHeader → transformId
  for (const m of mappings) {
    if (m.vareField && m.vareField !== "skip") {
      fieldMap[m.csvHeader] = m.vareField;
    }
    if (m.transformId) {
      transformMap[m.csvHeader] = m.transformId;
    }
  }

  await db
    .update(csvUploadsTable)
    .set({ status: "importing", updatedAt: new Date() })
    .where(eq(csvUploadsTable.id, uploadId));

  const rows = (upload.rawRows ?? []) as Record<string, string>[];
  const importErrors: { row: number; error: string }[] = [];
  let imported = 0;
  const BATCH = 500;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values: (typeof normalizedProductsTable.$inferInsert)[] = [];

    for (let j = 0; j < batch.length; j++) {
      const row = batch[j]!;
      const rowNum = i + j + 2;

      // Build a mutable field-value map from the CSV row
      const extracted: Record<string, string> = {};
      for (const [header, value] of Object.entries(row)) {
        const field = fieldMap[header];
        if (field && value) {
          extracted[field] = value;
        }
      }

      // Apply column transforms (may produce secondary fields)
      for (const [header, transformId] of Object.entries(transformMap)) {
        const transform = getTransform(transformId);
        if (!transform) continue;
        const rawValue = row[header] ?? "";
        const produced = transform.fn(rawValue, row);
        for (const [field, value] of Object.entries(produced)) {
          if (value) extracted[field] = value;
        }
      }

      // Apply field overrides for unmapped required fields
      let hasAiFill = false;
      for (const override of overrides) {
        if (!extracted[override.vareField]) {
          if (override.strategy === "default_value" && override.defaultValue) {
            extracted[override.vareField] = override.defaultValue;
          } else if (override.strategy === "ai_fill") {
            hasAiFill = true;
          }
        }
      }

      const get = (field: string): string | undefined => extracted[field] || undefined;

      const sku = get("sku")?.trim();
      const name = get("name")?.trim();
      if (!sku) { importErrors.push({ row: rowNum, error: "Missing SKU" }); continue; }
      if (!name) { importErrors.push({ row: rowNum, error: "Missing product name" }); continue; }

      const rawPrice = get("price");
      const price = rawPrice ? parseFloat(rawPrice.replace(/[^0-9.-]/g, "")) : undefined;

      const customAttributes: Record<string, string> = {};
      for (const [header, value] of Object.entries(row)) {
        const mapped = fieldMap[header];
        if (!mapped && value) customAttributes[header] = value;
      }

      // AI-fill products get a lower initial score so they enter the LLM enrichment pipeline
      const initialScore = hasAiFill ? 30 : 50;

      values.push({
        merchantId,
        sku,
        productTitle: name,
        description: get("description") ?? null,
        shortDescription: get("short_description") ?? null,
        brand: get("brand") ?? null,
        manufacturer: get("manufacturer") ?? null,
        mpn: get("mpn") ?? null,
        upc: get("upc") ?? null,
        price: price !== undefined && !isNaN(price) ? String(price) : null,
        categoryPath: get("category") ?? null,
        color: get("color") ?? null,
        finish: get("finish") ?? null,
        weight: get("weight") ? String(parseFloat(get("weight")!)) : null,
        weightUnit: get("weight_unit") ?? null,
        imageUrls: get("image_url") ? [get("image_url")] : null,
        customAttributes: Object.keys(customAttributes).length > 0 ? customAttributes : null,
        normalizationStatus: hasAiFill ? "needs_review" : "pending",
        agentReadinessScore: initialScore,
      });
    }

    if (values.length > 0) {
      try {
        await db
          .insert(normalizedProductsTable)
          .values(values)
          .onConflictDoUpdate({
            target: [normalizedProductsTable.merchantId, normalizedProductsTable.sku],
            set: {
              productTitle: normalizedProductsTable.productTitle,
              description: normalizedProductsTable.description,
              brand: normalizedProductsTable.brand,
              price: normalizedProductsTable.price,
              updatedAt: new Date(),
            },
          });
        imported += values.length;
      } catch (err) {
        importErrors.push({ row: i + 2, error: `Batch insert failed: ${err instanceof Error ? err.message : "unknown"}` });
      }
    }
  }

  await db
    .update(csvUploadsTable)
    .set({
      status: importErrors.length === rows.length ? "failed" : "completed",
      importedCount: imported,
      errorCount: importErrors.length,
      errors: importErrors.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(csvUploadsTable.id, uploadId));

  return { imported, errors: importErrors.length };
}
