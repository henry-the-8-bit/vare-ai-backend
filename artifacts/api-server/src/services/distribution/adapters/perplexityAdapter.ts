import { db } from "@workspace/db";
import { platformConnectionsTable, type NormalizedProduct } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type {
  PlatformAdapter,
  PlatformMetadata,
  PlatformSpec,
  PlatformProductBase,
  HealthCheckResult,
} from "../types.js";

const metadata: PlatformMetadata = {
  id: "perplexity",
  label: "Perplexity",
  description: "Distribute your catalog to Perplexity Shopping. Perplexity queries your API to surface products in shopping results.",
  icon: "Search",
  type: "pull",
  credentialFields: [
    {
      key: "verificationToken",
      label: "Verification Token",
      type: "password",
      required: false,
      placeholder: "Optional authentication token",
      helpText: "Token for Perplexity to authenticate when calling your catalog API. Leave blank to use your merchant API key.",
    },
  ],
  configFields: [
    {
      key: "minReadinessScore",
      label: "Minimum Readiness Score",
      type: "number",
      required: false,
      defaultValue: 60,
      helpText: "Only include products scoring at or above this threshold. Perplexity recommends higher quality thresholds.",
    },
    {
      key: "includeInventory",
      label: "Include Inventory Data",
      type: "boolean",
      required: false,
      defaultValue: true,
      helpText: "Include real-time stock availability in feed responses.",
    },
    {
      key: "maxProducts",
      label: "Max Products in Feed",
      type: "number",
      required: false,
      defaultValue: 10000,
      helpText: "Maximum number of products to include in the product feed.",
    },
  ],
};

function buildPerplexityFeedSpec(merchantSlug: string, baseUrl: string, config: Record<string, unknown>): Record<string, unknown> {
  return {
    feedInfo: {
      version: "1.0",
      merchant: merchantSlug,
      generatedAt: new Date().toISOString(),
      productCount: 0, // Filled at generation time with actual count
    },
    endpoints: {
      searchProducts: {
        method: "GET",
        url: `${baseUrl}/api/v1/merchants/${merchantSlug}/catalog`,
        description: "Search products by keyword, brand, category, price, and fitment",
        parameters: {
          q: { type: "string", description: "Search query" },
          brand: { type: "string", description: "Brand filter" },
          category: { type: "string", description: "Category filter" },
          minPrice: { type: "number", description: "Min price" },
          maxPrice: { type: "number", description: "Max price" },
          inStockOnly: { type: "boolean", description: "In-stock filter" },
          year: { type: "integer", description: "Vehicle year (fitment)" },
          make: { type: "string", description: "Vehicle make (fitment)" },
          model: { type: "string", description: "Vehicle model (fitment)" },
          page: { type: "integer", description: "Page number" },
          limit: { type: "integer", description: "Results per page (max 100)" },
        },
      },
      getProduct: {
        method: "GET",
        url: `${baseUrl}/api/v1/merchants/${merchantSlug}/catalog/{sku}`,
        description: "Get product details by SKU",
      },
      checkInventory: {
        method: "GET",
        url: `${baseUrl}/api/v1/merchants/${merchantSlug}/inventory/{sku}`,
        description: "Check real-time inventory for a SKU",
      },
    },
    authentication: {
      type: "bearer",
      header: "Authorization",
      description: "Bearer token using your Vare API key",
    },
    productSchema: {
      type: "object",
      properties: {
        sku: { type: "string" },
        productTitle: { type: "string" },
        brand: { type: "string" },
        price: { type: "string", description: "Decimal price" },
        currency: { type: "string" },
        imageUrls: { type: "array", items: { type: "string" } },
        categoryPath: { type: "string" },
        agentReadinessScore: { type: "integer" },
        color: { type: "string" },
        mpn: { type: "string" },
        fitmentData: {
          type: "object",
          properties: {
            make: { type: "string" },
            model: { type: "string" },
            years: { type: "array", items: { type: "integer" } },
            engine: { type: "string" },
          },
        },
      },
    },
    shoppingMetadata: {
      supportedCurrencies: ["USD"],
      supportsFitment: true,
      supportsInventory: config.includeInventory !== false,
      supportsOrdering: true,
      vertical: "auto_parts",
    },
  };
}

export const perplexityAdapter: PlatformAdapter = {
  platform: "perplexity",
  metadata,

  async validateCredentials(credentials: Record<string, string>): Promise<{ valid: boolean; error?: string }> {
    const token = credentials.verificationToken;
    if (token !== undefined && token.trim().length === 0) {
      return { valid: false, error: "Verification token cannot be empty if provided" };
    }
    return { valid: true };
  },

  async testConnection(connectionId: string): Promise<HealthCheckResult> {
    const start = Date.now();
    const [conn] = await db
      .select()
      .from(platformConnectionsTable)
      .where(eq(platformConnectionsTable.id, connectionId))
      .limit(1);

    if (!conn) {
      return { healthy: false, latencyMs: Date.now() - start, error: "Connection not found" };
    }

    return { healthy: true, latencyMs: Date.now() - start, details: { platform: "perplexity", type: "pull" } };
  },

  async generateSpec(merchantSlug: string, connectionId: string, baseUrl: string): Promise<PlatformSpec> {
    const [conn] = await db
      .select()
      .from(platformConnectionsTable)
      .where(eq(platformConnectionsTable.id, connectionId))
      .limit(1);

    const config = (conn?.config ?? {}) as Record<string, unknown>;
    const feed = buildPerplexityFeedSpec(merchantSlug, baseUrl, config);

    return {
      format: "feed_json",
      content: feed,
      generatedAt: new Date().toISOString(),
    };
  },

  async healthCheck(connectionId: string): Promise<HealthCheckResult> {
    return this.testConnection(connectionId);
  },

  transformProduct(product: NormalizedProduct, _config: Record<string, unknown>): PlatformProductBase {
    return {
      sku: product.sku,
      title: product.productTitle ?? product.sku,
      description: product.description ?? product.shortDescription ?? "",
      price: product.price ? Number(product.price) : 0,
      currency: product.currency ?? "USD",
      brand: product.brand ?? null,
      imageUrls: Array.isArray(product.imageUrls) ? (product.imageUrls as string[]) : [],
      category: product.categoryPath ?? null,
      inStock: true,
    };
  },
};
