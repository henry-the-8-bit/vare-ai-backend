import type { NormalizedProduct } from "@workspace/db/schema";
import type { PlatformAdapter, PlatformMetadata, PlatformSpec, MerchantDistributionConfig } from "../types.js";

const metadata: PlatformMetadata = {
  id: "chatgpt",
  label: "ChatGPT",
  description: "Make your products discoverable in ChatGPT conversations. Vare handles the integration — just toggle it on.",
  icon: "MessageSquare",
  type: "pull",
};

function buildOpenApiSpec(baseUrl: string): Record<string, unknown> {
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
    fitmentData: {
      type: "object",
      nullable: true,
      properties: {
        make: { type: "string" },
        model: { type: "string" },
        years: { type: "array", items: { type: "integer" } },
        engine: { type: "string" },
      },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Vare AI Product Catalog API",
      description: "Search, browse, and retrieve product catalog data across merchants. Includes pricing, inventory, automotive fitment, and more.",
      version: "1.0.0",
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/api/v1/merchants/{merchant_slug}/catalog": {
        get: {
          operationId: "searchProducts",
          summary: "Search a merchant's product catalog",
          description: "Search and filter products by keyword, brand, category, price range, fitment, and more. Returns paginated results with facets.",
          parameters: [
            { name: "merchant_slug", in: "path", required: true, schema: { type: "string" }, description: "Merchant identifier" },
            { name: "q", in: "query", schema: { type: "string" }, description: "Free-text search across title, description, brand, SKU, and MPN" },
            { name: "brand", in: "query", schema: { type: "string" }, description: "Filter by brand name" },
            { name: "category", in: "query", schema: { type: "string" }, description: "Filter by category path" },
            { name: "sku", in: "query", schema: { type: "string" }, description: "Filter by SKU" },
            { name: "mpn", in: "query", schema: { type: "string" }, description: "Filter by manufacturer part number" },
            { name: "color", in: "query", schema: { type: "string" }, description: "Filter by color" },
            { name: "minPrice", in: "query", schema: { type: "number" }, description: "Minimum price" },
            { name: "maxPrice", in: "query", schema: { type: "number" }, description: "Maximum price" },
            { name: "inStockOnly", in: "query", schema: { type: "boolean" }, description: "Only return in-stock products" },
            { name: "year", in: "query", schema: { type: "integer" }, description: "Vehicle year for fitment" },
            { name: "make", in: "query", schema: { type: "string" }, description: "Vehicle make for fitment" },
            { name: "model", in: "query", schema: { type: "string" }, description: "Vehicle model for fitment" },
            { name: "engine", in: "query", schema: { type: "string" }, description: "Engine type for fitment" },
            { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 }, description: "Page number" },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 }, description: "Results per page" },
          ],
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
      "/api/v1/merchants/{merchant_slug}/catalog/{sku}": {
        get: {
          operationId: "getProductBySku",
          summary: "Get detailed product information by SKU",
          description: "Returns full product details including description, images, attributes, inventory status, and fitment data.",
          parameters: [
            { name: "merchant_slug", in: "path", required: true, schema: { type: "string" }, description: "Merchant identifier" },
            { name: "sku", in: "path", required: true, schema: { type: "string" }, description: "Product SKU" },
          ],
          responses: {
            "200": {
              description: "Product details with inventory",
              content: { "application/json": { schema: { type: "object", properties: { data: { type: "object", properties: productProperties } } } } },
            },
          },
        },
      },
      "/api/v1/merchants/{merchant_slug}/inventory/{sku}": {
        get: {
          operationId: "checkInventory",
          summary: "Check real-time inventory for a product",
          parameters: [
            { name: "merchant_slug", in: "path", required: true, schema: { type: "string" }, description: "Merchant identifier" },
            { name: "sku", in: "path", required: true, schema: { type: "string" }, description: "Product SKU" },
          ],
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
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Vare platform API key.",
        },
      },
    },
    security: [{ bearerAuth: [] }],
  };
}

export const chatgptAdapter: PlatformAdapter = {
  platform: "chatgpt",
  metadata,

  generateSpec(baseUrl: string): PlatformSpec {
    return {
      format: "openapi",
      content: buildOpenApiSpec(baseUrl),
      generatedAt: new Date().toISOString(),
    };
  },

  transformProduct(product: NormalizedProduct, _config: MerchantDistributionConfig): Record<string, unknown> {
    return {
      sku: product.sku,
      title: product.productTitle ?? product.sku,
      description: product.description ?? product.shortDescription ?? "",
      price: product.price ? Number(product.price) : 0,
      currency: product.currency ?? "USD",
      brand: product.brand ?? null,
      imageUrls: Array.isArray(product.imageUrls) ? product.imageUrls : [],
      category: product.categoryPath ?? null,
    };
  },
};
