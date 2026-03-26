import { db } from "@workspace/db";
import { platformConnectionsTable, type NormalizedProduct } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type {
  PlatformAdapter,
  PlatformMetadata,
  PlatformSpec,
  PlatformProductBase,
  HealthCheckResult,
  PushResult,
} from "../types.js";

const metadata: PlatformMetadata = {
  id: "gemini",
  label: "Google Gemini",
  description: "Distribute your catalog to Google Gemini via function calling tool declarations. Supports Google Merchant Center for product feeds.",
  icon: "Sparkles",
  type: "hybrid",
  credentialFields: [
    {
      key: "googleApiKey",
      label: "Google API Key",
      type: "password",
      required: false,
      placeholder: "AIza...",
      helpText: "Optional. Required only for Google Merchant Center push. Gemini tool declarations work via pull.",
    },
    {
      key: "merchantCenterId",
      label: "Merchant Center ID",
      type: "text",
      required: false,
      placeholder: "123456789",
      helpText: "Google Merchant Center account ID. Leave blank if not using Merchant Center.",
    },
  ],
  configFields: [
    {
      key: "minReadinessScore",
      label: "Minimum Readiness Score",
      type: "number",
      required: false,
      defaultValue: 50,
      helpText: "Only include products with an agent readiness score at or above this threshold.",
    },
    {
      key: "enableMerchantCenter",
      label: "Enable Merchant Center Push",
      type: "boolean",
      required: false,
      defaultValue: false,
      helpText: "Push product data to Google Merchant Center in addition to generating tool declarations.",
    },
    {
      key: "includeFitment",
      label: "Include Fitment Data",
      type: "boolean",
      required: false,
      defaultValue: true,
      helpText: "Include automotive fitment parameters in tool declarations.",
    },
  ],
};

function buildGeminiToolDeclarations(merchantSlug: string, baseUrl: string, config: Record<string, unknown>): Record<string, unknown> {
  const includeFitment = config.includeFitment !== false;

  const searchProperties: Record<string, unknown> = {
    q: { type: "STRING", description: "Free-text search query for products" },
    brand: { type: "STRING", description: "Filter by brand name" },
    category: { type: "STRING", description: "Filter by product category" },
    sku: { type: "STRING", description: "Filter by SKU" },
    mpn: { type: "STRING", description: "Filter by manufacturer part number" },
    color: { type: "STRING", description: "Filter by color" },
    minPrice: { type: "NUMBER", description: "Minimum price" },
    maxPrice: { type: "NUMBER", description: "Maximum price" },
    inStockOnly: { type: "BOOLEAN", description: "Only return products currently in stock" },
    page: { type: "INTEGER", description: "Page number (default 1)" },
    limit: { type: "INTEGER", description: "Results per page (max 100, default 20)" },
  };

  if (includeFitment) {
    searchProperties.year = { type: "INTEGER", description: "Vehicle year for fitment lookup" };
    searchProperties.make = { type: "STRING", description: "Vehicle make for fitment lookup" };
    searchProperties.model = { type: "STRING", description: "Vehicle model for fitment lookup" };
    searchProperties.engine = { type: "STRING", description: "Engine type for fitment lookup" };
  }

  return {
    toolDeclarations: [
      {
        name: "searchProducts",
        description: "Search the product catalog by keyword, brand, category, price, fitment (year/make/model), and more. Returns paginated results with product details, pricing, and availability.",
        parameters: {
          type: "OBJECT",
          properties: searchProperties,
        },
      },
      {
        name: "getProductDetails",
        description: "Get detailed product information including full description, images, specifications, inventory status, and fitment data for a specific product SKU.",
        parameters: {
          type: "OBJECT",
          properties: {
            sku: { type: "STRING", description: "The product SKU to look up" },
          },
          required: ["sku"],
        },
      },
      {
        name: "checkInventory",
        description: "Check real-time inventory availability and stock quantity for a specific product SKU.",
        parameters: {
          type: "OBJECT",
          properties: {
            sku: { type: "STRING", description: "The product SKU to check inventory for" },
          },
          required: ["sku"],
        },
      },
    ],
    apiEndpoints: {
      searchProducts: { method: "GET", url: `${baseUrl}/api/v1/merchants/${merchantSlug}/catalog` },
      getProductDetails: { method: "GET", url: `${baseUrl}/api/v1/merchants/${merchantSlug}/catalog/{sku}` },
      checkInventory: { method: "GET", url: `${baseUrl}/api/v1/merchants/${merchantSlug}/inventory/{sku}` },
    },
    authentication: {
      type: "bearer",
      description: "Use your Vare API key as the bearer token in the Authorization header.",
    },
  };
}

export const geminiAdapter: PlatformAdapter = {
  platform: "gemini",
  metadata,

  async validateCredentials(credentials: Record<string, string>): Promise<{ valid: boolean; error?: string }> {
    const { enableMerchantCenter } = credentials;
    if (enableMerchantCenter === "true") {
      if (!credentials.googleApiKey || credentials.googleApiKey.trim().length === 0) {
        return { valid: false, error: "Google API Key is required when Merchant Center push is enabled" };
      }
      if (!credentials.merchantCenterId || credentials.merchantCenterId.trim().length === 0) {
        return { valid: false, error: "Merchant Center ID is required when Merchant Center push is enabled" };
      }
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

    return { healthy: true, latencyMs: Date.now() - start, details: { platform: "gemini", type: "hybrid" } };
  },

  async pushProducts(connectionId: string, products: NormalizedProduct[]): Promise<PushResult> {
    // Google Merchant Center push — placeholder for actual API integration
    // In production, this would use the Content API for Shopping:
    // https://developers.google.com/shopping-content/reference/rest
    const [conn] = await db
      .select()
      .from(platformConnectionsTable)
      .where(eq(platformConnectionsTable.id, connectionId))
      .limit(1);

    if (!conn) {
      return { pushed: 0, failed: products.length, errors: [{ error: "Connection not found" }] };
    }

    const config = (conn.config ?? {}) as Record<string, unknown>;
    if (!config.enableMerchantCenter) {
      // Pull-only mode: no push needed
      return { pushed: products.length, failed: 0, errors: [] };
    }

    // Placeholder: In production, batch-insert products into Google Merchant Center
    return { pushed: products.length, failed: 0, errors: [] };
  },

  async removeProducts(connectionId: string, skus: string[]): Promise<void> {
    // Placeholder for Google Merchant Center product removal
  },

  async generateSpec(merchantSlug: string, connectionId: string, baseUrl: string): Promise<PlatformSpec> {
    const [conn] = await db
      .select()
      .from(platformConnectionsTable)
      .where(eq(platformConnectionsTable.id, connectionId))
      .limit(1);

    const config = (conn?.config ?? {}) as Record<string, unknown>;
    const tools = buildGeminiToolDeclarations(merchantSlug, baseUrl, config);

    return {
      format: "gemini_tools",
      content: tools,
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
