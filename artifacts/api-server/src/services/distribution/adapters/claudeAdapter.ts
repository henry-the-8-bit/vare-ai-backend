import type { NormalizedProduct } from "@workspace/db/schema";
import type { PlatformAdapter, PlatformMetadata, PlatformSpec, MerchantDistributionConfig } from "../types.js";

const metadata: PlatformMetadata = {
  id: "claude",
  label: "Anthropic Claude",
  description: "Make your products discoverable in Claude conversations via MCP tool declarations. Vare handles the integration — just toggle it on.",
  icon: "Brain",
  type: "pull",
};

function buildMcpToolSpec(baseUrl: string): Record<string, unknown> {
  return {
    server: {
      name: "vare-ai-catalog",
      version: "1.0.0",
      baseUrl,
    },
    tools: [
      {
        name: "searchProducts",
        description: "Search a merchant's product catalog by keyword, brand, category, price, fitment (year/make/model), and more. Returns paginated results with product details, pricing, and availability.",
        inputSchema: {
          type: "object",
          properties: {
            merchant_slug: { type: "string", description: "Merchant identifier (required)" },
            q: { type: "string", description: "Free-text search query for products" },
            brand: { type: "string", description: "Filter by brand name" },
            category: { type: "string", description: "Filter by product category" },
            sku: { type: "string", description: "Filter by SKU" },
            mpn: { type: "string", description: "Filter by manufacturer part number" },
            color: { type: "string", description: "Filter by color" },
            minPrice: { type: "number", description: "Minimum price" },
            maxPrice: { type: "number", description: "Maximum price" },
            inStockOnly: { type: "boolean", description: "Only return products currently in stock" },
            year: { type: "integer", description: "Vehicle year for fitment lookup" },
            make: { type: "string", description: "Vehicle make for fitment lookup" },
            model: { type: "string", description: "Vehicle model for fitment lookup" },
            engine: { type: "string", description: "Engine type for fitment lookup" },
            page: { type: "integer", description: "Page number (default 1)" },
            limit: { type: "integer", description: "Results per page (max 100, default 20)" },
          },
          required: ["merchant_slug"],
        },
      },
      {
        name: "getProductDetails",
        description: "Get detailed product information including full description, images, specifications, inventory status, and fitment data for a specific product SKU.",
        inputSchema: {
          type: "object",
          properties: {
            merchant_slug: { type: "string", description: "Merchant identifier" },
            sku: { type: "string", description: "The product SKU to look up" },
          },
          required: ["merchant_slug", "sku"],
        },
      },
      {
        name: "checkInventory",
        description: "Check real-time inventory availability and stock quantity for a specific product SKU.",
        inputSchema: {
          type: "object",
          properties: {
            merchant_slug: { type: "string", description: "Merchant identifier" },
            sku: { type: "string", description: "The product SKU to check inventory for" },
          },
          required: ["merchant_slug", "sku"],
        },
      },
    ],
    apiEndpoints: {
      searchProducts: { method: "GET", url: `${baseUrl}/api/v1/merchants/{merchant_slug}/catalog` },
      getProductDetails: { method: "GET", url: `${baseUrl}/api/v1/merchants/{merchant_slug}/catalog/{sku}` },
      checkInventory: { method: "GET", url: `${baseUrl}/api/v1/merchants/{merchant_slug}/inventory/{sku}` },
    },
    authentication: {
      type: "bearer",
      description: "Vare platform API key in the Authorization header.",
    },
  };
}

export const claudeAdapter: PlatformAdapter = {
  platform: "claude",
  metadata,

  generateSpec(baseUrl: string): PlatformSpec {
    return {
      format: "mcp_tools",
      content: buildMcpToolSpec(baseUrl),
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
