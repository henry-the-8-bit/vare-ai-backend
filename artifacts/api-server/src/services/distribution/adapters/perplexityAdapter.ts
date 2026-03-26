import type { NormalizedProduct } from "@workspace/db/schema";
import type { PlatformAdapter, PlatformMetadata, PlatformSpec, MerchantDistributionConfig } from "../types.js";

const metadata: PlatformMetadata = {
  id: "perplexity",
  label: "Perplexity",
  description: "Make your products appear in Perplexity Shopping results. Vare handles the integration — just toggle it on.",
  icon: "Search",
  type: "pull",
};

function buildPerplexityFeedSpec(baseUrl: string): Record<string, unknown> {
  return {
    feedInfo: {
      provider: "Vare AI",
      version: "1.0",
      generatedAt: new Date().toISOString(),
    },
    endpoints: {
      searchProducts: {
        method: "GET",
        url: `${baseUrl}/api/v1/merchants/{merchant_slug}/catalog`,
        description: "Search products by keyword, brand, category, price, and fitment",
        parameters: {
          merchant_slug: { type: "string", required: true, description: "Merchant identifier" },
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
        url: `${baseUrl}/api/v1/merchants/{merchant_slug}/catalog/{sku}`,
        description: "Get product details by SKU",
      },
      checkInventory: {
        method: "GET",
        url: `${baseUrl}/api/v1/merchants/{merchant_slug}/inventory/{sku}`,
        description: "Check real-time inventory for a SKU",
      },
    },
    authentication: {
      type: "bearer",
      header: "Authorization",
      description: "Vare platform API key.",
    },
    productSchema: {
      type: "object",
      properties: {
        sku: { type: "string" },
        productTitle: { type: "string" },
        brand: { type: "string" },
        price: { type: "string" },
        currency: { type: "string" },
        imageUrls: { type: "array", items: { type: "string" } },
        categoryPath: { type: "string" },
        agentReadinessScore: { type: "integer" },
        fitmentData: { type: "object" },
      },
    },
    shoppingMetadata: {
      supportedCurrencies: ["USD"],
      supportsFitment: true,
      supportsInventory: true,
      supportsOrdering: true,
      vertical: "auto_parts",
    },
  };
}

export const perplexityAdapter: PlatformAdapter = {
  platform: "perplexity",
  metadata,

  generateSpec(baseUrl: string): PlatformSpec {
    return {
      format: "feed_json",
      content: buildPerplexityFeedSpec(baseUrl),
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
