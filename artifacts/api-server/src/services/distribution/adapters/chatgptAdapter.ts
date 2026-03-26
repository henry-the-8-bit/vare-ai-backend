import { db } from "@workspace/db";
import { platformConnectionsTable, type NormalizedProduct } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { decrypt } from "../../../lib/crypto.js";
import type {
  PlatformAdapter,
  PlatformMetadata,
  PlatformSpec,
  PlatformProductBase,
  HealthCheckResult,
  PushResult,
} from "../types.js";

const metadata: PlatformMetadata = {
  id: "chatgpt",
  label: "ChatGPT",
  description: "Distribute your catalog to ChatGPT via GPT Actions (OpenAPI spec). ChatGPT calls your API directly.",
  icon: "MessageSquare",
  type: "pull",
  credentialFields: [
    {
      key: "verificationToken",
      label: "Verification Token",
      type: "password",
      required: false,
      placeholder: "Optional token for action authentication",
      helpText: "Token that ChatGPT sends in the Authorization header when calling your catalog API. Leave blank to use your merchant API key.",
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
      key: "includeInventory",
      label: "Include Inventory Data",
      type: "boolean",
      required: false,
      defaultValue: true,
      helpText: "Include real-time stock availability in catalog responses.",
    },
    {
      key: "includeFitment",
      label: "Include Fitment Data",
      type: "boolean",
      required: false,
      defaultValue: true,
      helpText: "Include automotive fitment (year/make/model) in catalog responses.",
    },
  ],
};

function buildOpenApiSpec(merchantSlug: string, baseUrl: string, config: Record<string, unknown>): Record<string, unknown> {
  const includeFitment = config.includeFitment !== false;
  const includeInventory = config.includeInventory !== false;

  const productProperties: Record<string, unknown> = {
    id: { type: "string", format: "uuid" },
    sku: { type: "string" },
    productTitle: { type: "string" },
    brand: { type: "string", nullable: true },
    manufacturer: { type: "string", nullable: true },
    mpn: { type: "string", nullable: true },
    upc: { type: "string", nullable: true },
    price: { type: "string", description: "Decimal price" },
    currency: { type: "string" },
    color: { type: "string", nullable: true },
    finish: { type: "string", nullable: true },
    categoryPath: { type: "string", nullable: true },
    imageUrls: { type: "array", items: { type: "string", format: "uri" }, nullable: true },
    agentReadinessScore: { type: "integer", minimum: 0, maximum: 100 },
    normalizationStatus: { type: "string", enum: ["normalized", "reviewed"] },
  };

  if (includeFitment) {
    productProperties.fitmentData = {
      type: "object",
      nullable: true,
      properties: {
        make: { type: "string" },
        model: { type: "string" },
        years: { type: "array", items: { type: "integer" } },
        engine: { type: "string" },
      },
    };
  }

  const catalogParameters: unknown[] = [
    { name: "q", in: "query", schema: { type: "string" }, description: "Free-text search across title, description, brand, SKU, and MPN" },
    { name: "brand", in: "query", schema: { type: "string" }, description: "Filter by brand name (partial match)" },
    { name: "category", in: "query", schema: { type: "string" }, description: "Filter by category path (partial match)" },
    { name: "sku", in: "query", schema: { type: "string" }, description: "Filter by SKU (partial match)" },
    { name: "mpn", in: "query", schema: { type: "string" }, description: "Filter by manufacturer part number" },
    { name: "color", in: "query", schema: { type: "string" }, description: "Filter by color" },
    { name: "minPrice", in: "query", schema: { type: "number" }, description: "Minimum price filter" },
    { name: "maxPrice", in: "query", schema: { type: "number" }, description: "Maximum price filter" },
    { name: "inStockOnly", in: "query", schema: { type: "boolean" }, description: "Only return in-stock products" },
    { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 }, description: "Page number" },
    { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 }, description: "Results per page" },
  ];

  if (includeFitment) {
    catalogParameters.push(
      { name: "year", in: "query", schema: { type: "integer" }, description: "Filter by vehicle year" },
      { name: "make", in: "query", schema: { type: "string" }, description: "Filter by vehicle make" },
      { name: "model", in: "query", schema: { type: "string" }, description: "Filter by vehicle model" },
      { name: "engine", in: "query", schema: { type: "string" }, description: "Filter by engine type" },
    );
  }

  const paths: Record<string, unknown> = {
    [`/api/v1/merchants/${merchantSlug}/catalog`]: {
      get: {
        operationId: "searchProducts",
        summary: "Search the product catalog",
        description: "Search and filter products by keyword, brand, category, price range, fitment, and more. Returns paginated results with facets.",
        parameters: catalogParameters,
        responses: {
          "200": {
            description: "Paginated product list with facets",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { type: "object", properties: productProperties } },
                    total: { type: "integer" },
                    page: { type: "integer" },
                    limit: { type: "integer" },
                    facets: {
                      type: "object",
                      properties: {
                        categories: { type: "array", items: { type: "object", properties: { value: { type: "string" }, count: { type: "integer" } } } },
                        brands: { type: "array", items: { type: "object", properties: { value: { type: "string" }, count: { type: "integer" } } } },
                        priceRange: { type: "object", nullable: true, properties: { min: { type: "number" }, max: { type: "number" }, avg: { type: "number" } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    [`/api/v1/merchants/${merchantSlug}/catalog/{sku}`]: {
      get: {
        operationId: "getProductBySku",
        summary: "Get detailed product information by SKU",
        description: "Returns full product details including description, images, attributes, and real-time inventory status.",
        parameters: [{ name: "sku", in: "path", required: true, schema: { type: "string" }, description: "Product SKU" }],
        responses: {
          "200": {
            description: "Product details with inventory",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        ...productProperties,
                        description: { type: "string", nullable: true },
                        shortDescription: { type: "string", nullable: true },
                        weight: { type: "string", nullable: true },
                        weightUnit: { type: "string", nullable: true },
                        customAttributes: { type: "object", nullable: true },
                        ...(includeInventory
                          ? {
                              inventory: {
                                type: "object",
                                properties: {
                                  sku: { type: "string" },
                                  in_stock: { type: "boolean" },
                                  quantity: { type: "integer", nullable: true },
                                  low_stock: { type: "boolean" },
                                  last_checked: { type: "string", format: "date-time", nullable: true },
                                },
                              },
                            }
                          : {}),
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  if (includeInventory) {
    paths[`/api/v1/merchants/${merchantSlug}/inventory/{sku}`] = {
      get: {
        operationId: "checkInventory",
        summary: "Check real-time inventory for a product",
        description: "Returns current stock availability, quantity, and last-checked timestamp for a specific SKU.",
        parameters: [{ name: "sku", in: "path", required: true, schema: { type: "string" }, description: "Product SKU" }],
        responses: {
          "200": {
            description: "Inventory status",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        sku: { type: "string" },
                        in_stock: { type: "boolean" },
                        quantity: { type: "integer", nullable: true },
                        low_stock: { type: "boolean" },
                        last_checked: { type: "string", format: "date-time", nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: `Product Catalog API — ${merchantSlug}`,
      description: "Search, browse, and retrieve product catalog data including pricing, inventory, and automotive fitment information.",
      version: "1.0.0",
    },
    servers: [{ url: baseUrl }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Use your Vare API key as the bearer token.",
        },
      },
    },
    security: [{ bearerAuth: [] }],
  };
}

export const chatgptAdapter: PlatformAdapter = {
  platform: "chatgpt",
  metadata,

  async validateCredentials(credentials: Record<string, string>): Promise<{ valid: boolean; error?: string }> {
    // ChatGPT is a pull platform — credentials are optional (verification token)
    // If provided, just ensure it's a non-empty string
    const token = credentials.verificationToken;
    if (token !== undefined && token.trim().length === 0) {
      return { valid: false, error: "Verification token cannot be empty if provided" };
    }
    return { valid: true };
  },

  async testConnection(connectionId: string): Promise<HealthCheckResult> {
    const start = Date.now();
    // For pull platforms, "testing" means verifying the connection record exists and is valid
    const [conn] = await db
      .select()
      .from(platformConnectionsTable)
      .where(eq(platformConnectionsTable.id, connectionId))
      .limit(1);

    if (!conn) {
      return { healthy: false, latencyMs: Date.now() - start, error: "Connection not found" };
    }

    return { healthy: true, latencyMs: Date.now() - start, details: { platform: "chatgpt", type: "pull" } };
  },

  async generateSpec(merchantSlug: string, connectionId: string, baseUrl: string): Promise<PlatformSpec> {
    const [conn] = await db
      .select()
      .from(platformConnectionsTable)
      .where(eq(platformConnectionsTable.id, connectionId))
      .limit(1);

    const config = (conn?.config ?? {}) as Record<string, unknown>;
    const spec = buildOpenApiSpec(merchantSlug, baseUrl, config);

    return {
      format: "openapi",
      content: spec,
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
