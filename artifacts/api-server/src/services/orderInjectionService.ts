import { db } from "@workspace/db";
import {
  merchantsTable,
  magentoConnectionsTable,
  normalizedProductsTable,
  agentOrdersTable,
  transactionEventsTable,
  agentCartsTable,
} from "@workspace/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { MagentoConnector } from "./magentoConnector.js";
import { decrypt } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";

export interface CartItem {
  sku: string;
  quantity: number;
  unitPrice?: number;
  productTitle?: string;
}

export interface CartResult {
  cartId: string;
  items: CartItemResult[];
  subtotal: number;
  tax: number;
  shipping: number;
  total: number;
  currency: string;
}

export interface CartItemResult extends CartItem {
  productTitle: string;
  unitPrice: number;
  lineTotal: number;
  available: boolean;
  inventoryStatus: "in_stock" | "out_of_stock" | "unknown";
}

export interface CheckoutResult {
  orderId: string;
  magentoOrderId: string | null;
  status: "placed" | "failed" | "simulated";
  confirmation: string;
  items: CartItemResult[];
  total: number;
  currency: string;
  paymentMethod: string;
  shippingMethod: string;
  isTestOrder: boolean;
  errorMessage?: string;
}

export interface OrderInjectionOptions {
  agentPlatform?: string;
  sessionId?: string;
  customerEmail?: string;
  shippingMethod?: string;
  paymentMethod?: string;
  isTestOrder?: boolean;
  shippingAddress?: Record<string, unknown>;
}

async function getConnector(merchantId: string): Promise<{ connector: MagentoConnector; connection: Record<string, string> } | null> {
  const [conn] = await db
    .select()
    .from(magentoConnectionsTable)
    .where(and(eq(magentoConnectionsTable.merchantId, merchantId), eq(magentoConnectionsTable.connectionStatus, "connected")))
    .limit(1);

  if (!conn) return null;

  const connector = new MagentoConnector({
    storeUrl: conn.storeUrl,
    accessToken: conn.accessToken ? decrypt(conn.accessToken) : null,
  });

  return { connector, connection: { storeUrl: conn.storeUrl } };
}

export async function buildCart(
  merchantId: string,
  items: CartItem[],
  options: OrderInjectionOptions = {},
): Promise<CartResult> {
  const skus = items.map((i) => i.sku);

  const products = skus.length > 0
    ? await db
        .select({
          sku: normalizedProductsTable.sku,
          productTitle: normalizedProductsTable.productTitle,
          price: normalizedProductsTable.price,
          currency: normalizedProductsTable.currency,
        })
        .from(normalizedProductsTable)
        .where(and(
          eq(normalizedProductsTable.merchantId, merchantId),
          inArray(normalizedProductsTable.sku, skus),
        ))
    : [];

  const productMap = new Map(products.map((p) => [p.sku, p]));

  const cartItems: CartItemResult[] = items.map((item) => {
    const product = productMap.get(item.sku);
    const unitPrice = item.unitPrice ?? (product?.price ? parseFloat(String(product.price)) : 0);
    const productTitle = item.productTitle ?? product?.productTitle ?? item.sku;
    const available = !!product;
    return {
      sku: item.sku,
      quantity: item.quantity,
      unitPrice,
      productTitle,
      lineTotal: unitPrice * item.quantity,
      available,
      inventoryStatus: available ? "in_stock" : "unknown",
    };
  });

  const subtotal = cartItems.reduce((sum, i) => sum + i.lineTotal, 0);
  const taxRate = 0.08;
  const tax = Math.round(subtotal * taxRate * 100) / 100;
  const shipping = subtotal > 0 ? 9.99 : 0;
  const total = subtotal + tax + shipping;

  const currency = products[0]?.currency ?? "USD";

  const [cart] = await db
    .insert(agentCartsTable)
    .values({
      merchantId,
      agentPlatform: options.agentPlatform ?? "api",
      sessionId: options.sessionId ?? null,
      items: cartItems as unknown as Record<string, unknown>[],
      subtotalCents: Math.round(subtotal * 100),
      taxCents: Math.round(tax * 100),
      shippingCents: Math.round(shipping * 100),
      totalCents: Math.round(total * 100),
      customerEmail: options.customerEmail ?? null,
      shippingMethod: options.shippingMethod ?? "flatrate_flatrate",
      paymentMethod: options.paymentMethod ?? "vare_ai",
    })
    .returning({ id: agentCartsTable.id });

  return {
    cartId: cart.id,
    items: cartItems,
    subtotal: Math.round(subtotal * 100) / 100,
    tax: Math.round(tax * 100) / 100,
    shipping,
    total: Math.round(total * 100) / 100,
    currency,
  };
}

export async function injectOrder(
  merchantId: string,
  cartId: string,
  options: OrderInjectionOptions = {},
): Promise<CheckoutResult> {
  const startTime = Date.now();

  const [cart] = await db
    .select()
    .from(agentCartsTable)
    .where(and(eq(agentCartsTable.id, cartId), eq(agentCartsTable.merchantId, merchantId)))
    .limit(1);

  if (!cart) {
    throw new Error("Cart not found");
  }

  const cartItems = (cart.items ?? []) as CartItemResult[];
  const isTestOrder = options.isTestOrder ?? false;
  const total = (cart.totalCents ?? 0) / 100;
  const paymentMethod = options.paymentMethod ?? cart.paymentMethod ?? "vare_ai";
  const shippingMethod = options.shippingMethod ?? cart.shippingMethod ?? "flatrate_flatrate";

  let magentoOrderId: string | null = null;
  let orderStatus: "placed" | "failed" | "simulated" = "simulated";
  let errorMessage: string | undefined;
  let internalOrderId = `vare-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (!isTestOrder) {
    try {
      const conn = await getConnector(merchantId);
      if (conn) {
        const { connector } = conn;
        const customerEmail = options.customerEmail ?? cart.customerEmail ?? "agent@vare.ai";
        const shippingAddr = options.shippingAddress ?? {
          region: "CA",
          region_id: 12,
          region_code: "CA",
          country_id: "US",
          street: ["123 Agent St"],
          postcode: "90210",
          city: "Beverly Hills",
          firstname: "AI",
          lastname: "Agent",
          email: customerEmail,
          telephone: "5555555555",
        };

        const magentoResult = await createMagentoOrder(
          connector,
          customerEmail,
          cartItems,
          shippingAddr,
          shippingMethod,
          paymentMethod,
        );

        magentoOrderId = magentoResult.orderId;
        orderStatus = "placed";
      } else {
        orderStatus = "simulated";
        errorMessage = "No Magento connection available; order simulated";
      }
    } catch (err) {
      orderStatus = "failed";
      errorMessage = String(err);
      logger.error({ merchantId, cartId, err }, "Order injection failed");
    }
  }

  await db
    .update(agentCartsTable)
    .set({ status: orderStatus === "failed" ? "failed" : "checked_out", updatedAt: new Date() })
    .where(eq(agentCartsTable.id, cartId));

  for (const item of cartItems) {
    await db.insert(agentOrdersTable).values({
      merchantId,
      magentoOrderId,
      agentPlatform: options.agentPlatform ?? cart.agentPlatform ?? "api",
      agentSessionId: options.sessionId ?? cart.sessionId ?? null,
      sku: item.sku,
      productTitle: item.productTitle,
      quantity: item.quantity,
      unitPrice: String(item.unitPrice),
      totalPrice: String(item.lineTotal),
      orderStatus,
      paymentMethod,
      shippingMethod,
      errorMessage: errorMessage ?? null,
    });
  }

  await db.insert(transactionEventsTable).values({
    merchantId,
    sessionId: options.sessionId ?? cart.sessionId ?? null,
    agentPlatform: options.agentPlatform ?? cart.agentPlatform ?? "api",
    sku: cartItems[0]?.sku ?? null,
    eventType: "checkout",
    status: orderStatus === "failed" ? "error" : "success",
    durationMs: Date.now() - startTime,
    metadata: {
      cartId,
      magentoOrderId,
      isTestOrder,
      itemCount: cartItems.length,
      total,
    },
  });

  const confirmation = magentoOrderId
    ? `Order #${magentoOrderId} placed successfully`
    : isTestOrder
      ? `Test order simulated — ref: ${internalOrderId}`
      : `Order simulated — ref: ${internalOrderId}`;

  return {
    orderId: internalOrderId,
    magentoOrderId,
    status: orderStatus,
    confirmation,
    items: cartItems,
    total: Math.round(total * 100) / 100,
    currency: "USD",
    paymentMethod,
    shippingMethod,
    isTestOrder,
    errorMessage,
  };
}

async function createMagentoOrder(
  connector: MagentoConnector,
  customerEmail: string,
  items: CartItemResult[],
  shippingAddress: Record<string, unknown>,
  shippingMethod: string,
  paymentMethod: string,
): Promise<{ orderId: string }> {
  const guestCartId = await connector.createGuestCart();

  for (const item of items) {
    await connector.addItemToGuestCart(guestCartId, item.sku, item.quantity);
  }

  await connector.setGuestShipping(guestCartId, customerEmail, shippingAddress, shippingMethod);
  const orderId = await connector.placeGuestOrder(guestCartId, paymentMethod, { source: "vare_ai" });

  return { orderId: String(orderId) };
}

export async function cancelTestOrder(merchantId: string, orderId: string): Promise<{ cancelled: boolean; message: string }> {
  const orders = await db
    .select()
    .from(agentOrdersTable)
    .where(and(eq(agentOrdersTable.merchantId, merchantId), eq(agentOrdersTable.magentoOrderId, orderId)));

  if (orders.length === 0) {
    return { cancelled: false, message: "Order not found" };
  }

  if (orders[0].orderStatus === "simulated" || orders[0].orderStatus === "placed") {
    await db
      .update(agentOrdersTable)
      .set({ orderStatus: "cancelled", updatedAt: new Date() })
      .where(and(eq(agentOrdersTable.merchantId, merchantId), eq(agentOrdersTable.magentoOrderId, orderId)));
    return { cancelled: true, message: `Order ${orderId} cancelled` };
  }

  return { cancelled: false, message: `Cannot cancel order in status: ${orders[0].orderStatus}` };
}
