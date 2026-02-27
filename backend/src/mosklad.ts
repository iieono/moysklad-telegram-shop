import { prisma } from "./db.js";

const baseUrl = process.env.MOSKLAD_BASE_URL || "https://api.moysklad.ru/api/remap/1.2";
const token = process.env.MOSKLAD_TOKEN || "";

type FetchOptions = {
  method?: string;
  body?: unknown;
};

async function moskladFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  if (!token) {
    throw new Error("MOSKLAD_TOKEN is not set");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Basic ${token}`,
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Mosklad request failed: ${response.status} ${text}`);
  }

  return (await response.json()) as T;
}

// ── Stock cache ───────────────────────────────────────────────────────────────

let _stockCache: { data: Map<string, number>; expiresAt: number } | null = null;
let _currencyCache: { code: string | null; expiresAt: number } | null = null;
let _organizationCache: { id: string | null; expiresAt: number } | null = null;
let _storeCache: { id: string | null; expiresAt: number } | null = null;

async function getStockMap(): Promise<Map<string, number>> {
  const now = Date.now();
  if (_stockCache && _stockCache.expiresAt > now) {
    return _stockCache.data;
  }

  const data = await moskladFetch<{
    rows: Array<{ meta: { href: string; type: string }; stock: number }>;
  }>("/report/stock/all?filter=stockMode=all&limit=1000");

  const map = new Map<string, number>();
  for (const row of data.rows) {
    if (row.meta.type !== "product") continue;
    const parts = row.meta.href.split("/");
    const id = parts[parts.length - 1].split("?")[0];
    if (id) map.set(id, Math.max(0, Math.floor(row.stock)));
  }

  _stockCache = { data: map, expiresAt: now + 5 * 60 * 1000 };
  return map;
}

// ── Pagination helper ─────────────────────────────────────────────────────────

async function fetchAllPages<T>(basePath: string): Promise<T[]> {
  const limit = 100;
  let offset = 0;
  const allRows: T[] = [];

  while (true) {
    const sep = basePath.includes("?") ? "&" : "?";
    const data = await moskladFetch<{ meta: { size: number }; rows: T[] }>(
      `${basePath}${sep}limit=${limit}&offset=${offset}`
    );
    allRows.push(...data.rows);
    offset += data.rows.length;
    if (data.rows.length === 0 || offset >= (data.meta?.size ?? 0)) break;
  }

  return allRows;
}

// ── Products ──────────────────────────────────────────────────────────────────

type MoyskladProduct = {
  id: string;
  name: string;
  article?: string;
  salePrices?: Array<{ value: number; priceType?: { name?: string }; currency?: { isoCode?: string; name?: string; symbol?: string } }>;
  images?: { meta?: { size?: number } };
};

function pickSalePrice(
  prices?: Array<{ value: number; priceType?: { name?: string }; currency?: { isoCode?: string; name?: string; symbol?: string } }>
) {
  if (!prices || prices.length === 0) return { value: 0, currency: null as string | null };
  const saleName = "Цена продажи";
  const preferred =
    prices.find((p) => (p.priceType?.name || "") === saleName) ||
    prices.find((p) => (p.priceType?.name || "").toLowerCase().includes("sale"));
  const price = preferred || prices[0];
  const currency = price?.currency?.isoCode || price?.currency?.symbol || price?.currency?.name || null;
  return { value: price?.value ? price.value / 100 : 0, currency };
}

function mapProduct(row: MoyskladProduct, stockMap: Map<string, number>, baseCurrency: string | null) {
  const pickedPrice = pickSalePrice(row.salePrices);
  return {
    id: row.id,
    name: row.name,
    article: row.article || null,
    price: pickedPrice.value,
    priceCurrency: pickedPrice.currency || baseCurrency,
    stock: stockMap.get(row.id) ?? 0,
    imageCount: row.images?.meta?.size ?? 0
  };
}

export async function listProducts() {
  const [rows, stockMap, baseCurrency] = await Promise.all([
    fetchAllPages<MoyskladProduct>("/entity/product?expand=salePrices.currency"),
    getStockMap(),
    getBaseCurrencyCode()
  ]);
  return rows.map((row) => mapProduct(row, stockMap, baseCurrency));
}

export async function listCategories() {
  const rows = await fetchAllPages<{ id: string; name: string }>("/entity/productfolder");
  if (rows.length === 0) {
    return [{ id: "all", name: "All products" }];
  }
  return rows.map((row) => ({ id: row.id, name: row.name }));
}

export async function listProductsByCategory(categoryId: string) {
  if (categoryId === "all") {
    return listProducts();
  }
  const [rows, stockMap, baseCurrency] = await Promise.all([
    fetchAllPages<MoyskladProduct>(
      `/entity/product?expand=salePrices.currency&filter=productFolder=${encodeURIComponent(`${baseUrl}/entity/productfolder/${categoryId}`)}`
    ),
    getStockMap(),
    getBaseCurrencyCode()
  ]);
  return rows.map((row) => mapProduct(row, stockMap, baseCurrency));
}

export async function getProductsByIds(ids: string[]) {
  const uniqueIds = Array.from(new Set(ids)).filter(Boolean);
  const [results, stockMap, baseCurrency] = await Promise.all([
    Promise.all(
      uniqueIds.map((id) => moskladFetch<MoyskladProduct>(`/entity/product/${id}?expand=salePrices.currency`))
    ),
    getStockMap(),
    getBaseCurrencyCode()
  ]);
  return results.map((row) => mapProduct(row, stockMap, baseCurrency));
}

export async function fetchProductImages(productId: string): Promise<Array<{ id: string; url: string }>> {
  const data = await moskladFetch<{
    rows: Array<{ meta: { href: string } }>;
  }>(`/entity/product/${productId}/images?limit=10`);

  return data.rows.map((row) => {
    const parts = row.meta.href.split("/");
    const imageId = parts[parts.length - 1].split("?")[0];
    return { id: imageId, url: `/api/product-image/${productId}/${imageId}` };
  });
}

// ── Counterparty ──────────────────────────────────────────────────────────────

export async function findCounterpartyByPhone(phoneNumber: string): Promise<string | null> {
  const search = await moskladFetch<{ rows: Array<{ id: string }> }>(
    `/entity/counterparty?filter=phone=${encodeURIComponent(phoneNumber)}`
  );
  return search.rows[0]?.id || null;
}

export async function updateCounterpartyAttrs(
  counterpartyId: string,
  telegramId: string,
  username?: string
): Promise<void> {
  const usernameAttr = process.env.MOSKLAD_COUNTERPARTY_USERNAME_ATTR;
  const telegramIdAttr = process.env.MOSKLAD_COUNTERPARTY_TELEGRAM_ID_ATTR;
  if (!usernameAttr && !telegramIdAttr) return;

  const attributes: Array<{ meta: object; value: string }> = [];
  if (telegramIdAttr) {
    attributes.push({
      meta: {
        href: `${baseUrl}/entity/counterparty/metadata/attributes/${telegramIdAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: telegramId
    });
  }
  if (usernameAttr && username) {
    attributes.push({
      meta: {
        href: `${baseUrl}/entity/counterparty/metadata/attributes/${usernameAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: username
    });
  }

  if (attributes.length === 0) return;

  await moskladFetch(`/entity/counterparty/${counterpartyId}`, {
    method: "PUT",
    body: { attributes }
  });
}

export async function updateCounterpartyAddress(
  counterpartyId: string,
  opts: { location?: string | null; addressName?: string | null; addressExtra?: string | null }
): Promise<void> {
  const locationAttr = process.env.MOSKLAD_COUNTERPARTY_LOCATION_ATTR;
  const addressAttr = process.env.MOSKLAD_COUNTERPARTY_ADDRESS_ATTR;
  const addressDetailsAttr = process.env.COUNTERPARTY_ADDRESS_DETAILS;

  const attributes: object[] = [];
  if (locationAttr && opts.location) {
    attributes.push({
      meta: {
        href: `${baseUrl}/entity/counterparty/metadata/attributes/${locationAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: opts.location
    });
  }
  if (addressAttr && opts.addressName) {
    attributes.push({
      meta: {
        href: `${baseUrl}/entity/counterparty/metadata/attributes/${addressAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: opts.addressName
    });
  }
  if (addressDetailsAttr && opts.addressExtra) {
    attributes.push({
      meta: {
        href: `${baseUrl}/entity/counterparty/metadata/attributes/${addressDetailsAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: opts.addressExtra
    });
  }
  if (attributes.length === 0) return;

  await moskladFetch(`/entity/counterparty/${counterpartyId}`, {
    method: "PUT",
    body: { attributes }
  });
}

export async function getCounterparty(counterpartyId: string) {
  return moskladFetch<{
    id: string;
    name?: string;
    attributes?: Array<{ id?: string; value: any; meta?: { href?: string } }>;
  }>(`/entity/counterparty/${counterpartyId}`);
}

export async function createCounterparty(
  telegramId: string,
  phoneNumber: string,
  name: string,
  username?: string
): Promise<string> {
  const usernameAttr = process.env.MOSKLAD_COUNTERPARTY_USERNAME_ATTR;
  const telegramIdAttr = process.env.MOSKLAD_COUNTERPARTY_TELEGRAM_ID_ATTR;

  const attributes: Array<{ meta: object; value: string }> = [];
  if (telegramIdAttr) {
    attributes.push({
      meta: {
        href: `${baseUrl}/entity/counterparty/metadata/attributes/${telegramIdAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: telegramId
    });
  }
  if (usernameAttr && username) {
    attributes.push({
      meta: {
        href: `${baseUrl}/entity/counterparty/metadata/attributes/${usernameAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: username
    });
  }

  const body: Record<string, unknown> = { name, phone: phoneNumber };
  if (attributes.length > 0) body.attributes = attributes;

  const created = await moskladFetch<{ id: string }>(`/entity/counterparty`, {
    method: "POST",
    body
  });

  await prisma.user.update({
    where: { telegramId },
    data: { moskladCounterpartyId: created.id }
  });

  return created.id;
}

export async function getOrCreateCounterparty(
  telegramId: string,
  phoneNumber: string,
  name?: string,
  username?: string
) {
  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) throw new Error("User not found");

  if (user.moskladCounterpartyId) {
    const exists = await moskladFetch(`/entity/counterparty/${user.moskladCounterpartyId}`)
      .then(() => true)
      .catch((err: Error) => {
        if (err.message.includes("404")) return false;
        throw err;
      });
    if (exists) return user.moskladCounterpartyId;

    // Counterparty was deleted from MoySklad — unlink and force re-registration
    await prisma.user.update({
      where: { telegramId },
      data: { moskladCounterpartyId: null }
    });
    throw new Error("COUNTERPARTY_DELETED");
  }

  const existing = await findCounterpartyByPhone(phoneNumber);
  if (existing) {
    await prisma.user.update({
      where: { telegramId },
      data: { moskladCounterpartyId: existing }
    });
    await updateCounterpartyAttrs(existing, telegramId, username);
    return existing;
  }

  return createCounterparty(
    telegramId,
    phoneNumber,
    name || user.firstName || user.username || phoneNumber,
    username
  );
}

// ── Balance & Orders ──────────────────────────────────────────────────────────

export async function getCustomerBalance(counterpartyId: string) {
  const data = await moskladFetch<{ balance: number }>(
    `/report/counterparty/${counterpartyId}`
  );
  return (data.balance ?? 0) / 100;
}

export async function getBaseCurrencyCode(): Promise<string | null> {
  const now = Date.now();
  if (_currencyCache && _currencyCache.expiresAt > now) {
    return _currencyCache.code;
  }

  const data = await moskladFetch<{
    currency?: { isoCode?: string; name?: string; symbol?: string };
  }>("/context/companysettings");
  const code = data.currency?.isoCode || data.currency?.symbol || data.currency?.name || null;
  _currencyCache = { code, expiresAt: now + 10 * 60 * 1000 };
  return code;
}

async function getDefaultOrganizationId(): Promise<string | null> {
  const now = Date.now();
  if (_organizationCache && _organizationCache.expiresAt > now) {
    return _organizationCache.id;
  }

  const data = await moskladFetch<{ rows: Array<{ id: string }> }>("/entity/organization?limit=1");
  const id = data.rows?.[0]?.id || null;
  _organizationCache = { id, expiresAt: now + 10 * 60 * 1000 };
  return id;
}

async function getDefaultStoreId(): Promise<string | null> {
  const now = Date.now();
  if (_storeCache && _storeCache.expiresAt > now) {
    return _storeCache.id;
  }

  const data = await moskladFetch<{ rows: Array<{ id: string }> }>("/entity/store?limit=1");
  const id = data.rows?.[0]?.id || null;
  _storeCache = { id, expiresAt: now + 10 * 60 * 1000 };
  return id;
}

export async function listCustomerOrders(counterpartyId: string, offset = 0, limit = 10) {
  const data = await moskladFetch<{
    meta: { size: number };
    rows: Array<{
      id: string;
      name: string;
      moment: string;
      sum: number;
      state?: { name?: string };
      attributes?: Array<{ name: string; value: string | number | boolean | null }>;
    }>;
  }>(
    `/entity/customerorder?filter=agent=${encodeURIComponent(`${baseUrl}/entity/counterparty/${counterpartyId}`)}&order=moment,desc&limit=${limit}&offset=${offset}&expand=state`
  );

  return {
    rows: data.rows.map((row) => ({
      id: row.id,
      name: row.name,
      moment: row.moment,
      sum: row.sum / 100,
      state: row.state?.name || null,
      driverInfo: extractDriverInfo(row.attributes || [])
    })),
    total: data.meta?.size ?? 0
  };
}

type OrderItem = { id: string; quantity: number; price?: number | null };
type DeliveryInfo = {
  deliveryMethod?: "pickup" | "delivery";
  orderNote?: string | null;
  addressText?: string | null;
  locationLat?: number | null;
  locationLng?: number | null;
  addressExtra?: string | null;
};

export async function createCustomerOrder(
  counterpartyId: string,
  items: OrderItem[],
  deliveryInfo: DeliveryInfo = {}
) {
  const organizationId = process.env.MOSKLAD_ORGANIZATION_ID || (await getDefaultOrganizationId());
  if (!organizationId) {
    throw new Error("No organization found for order creation");
  }
  const storeId = process.env.MOSKLAD_STORE_ID || (await getDefaultStoreId());

  const positions = items.map((item) => ({
    quantity: item.quantity,
    ...(typeof item.price === "number" ? { price: Math.round(item.price * 100) } : {}),
    assortment: {
      meta: {
        href: `${baseUrl}/entity/product/${item.id}`,
        type: "product",
        mediaType: "application/json"
      }
    }
  }));

  const trimmedNote = deliveryInfo.orderNote?.trim() || undefined;

  const orderBody: Record<string, unknown> = {
    organization: {
      meta: {
        href: `${baseUrl}/entity/organization/${organizationId}`,
        type: "organization",
        mediaType: "application/json"
      }
    },
    ...(storeId
      ? {
          store: {
            meta: {
              href: `${baseUrl}/entity/store/${storeId}`,
              type: "store",
              mediaType: "application/json"
            }
          }
        }
      : {}),
    agent: {
      meta: {
        href: `${baseUrl}/entity/counterparty/${counterpartyId}`,
        type: "counterparty",
        mediaType: "application/json"
      }
    },
    positions,
    shipmentAddress: deliveryInfo.addressText || undefined
  };

  const orderLocationAttr = process.env.MOSKLAD_ORDER_LOCATION_ATTR;
  const orderAddressAttr = process.env.MOSKLAD_ORDER_ADDRESS_ATTR;
  const orderAddressDetailsAttr = process.env.ORDER_ADDRESS_DETAILS;
  const deliveryMethodAttr = process.env.MOSKLAD_DELIVERY_METHOD_ATTR;
  const deliveryMethodPickup = process.env.MOSKLAD_DELIVERY_METHOD_PICKUP;
  const deliveryMethodDelivery = process.env.MOSKLAD_DELIVERY_METHOD_DELIVERY;
  const orderNoteAttr = process.env.MOSKLAD_ORDER_NOTE_ATTR;
  const orderAttributes: object[] = [];
  if (orderLocationAttr && deliveryInfo.locationLat && deliveryInfo.locationLng) {
    orderAttributes.push({
      meta: {
        href: `${baseUrl}/entity/customerorder/metadata/attributes/${orderLocationAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: formatYandexMapsLink(deliveryInfo.locationLat, deliveryInfo.locationLng)
    });
  }
  if (orderAddressAttr && deliveryInfo.addressText) {
    orderAttributes.push({
      meta: {
        href: `${baseUrl}/entity/customerorder/metadata/attributes/${orderAddressAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: deliveryInfo.addressText
    });
  }
  if (deliveryMethodAttr && deliveryInfo.deliveryMethod) {
    const optionId =
      deliveryInfo.deliveryMethod === "pickup" ? deliveryMethodPickup : deliveryMethodDelivery;
    if (optionId) {
      const href = buildCustomEntityHref(optionId);
      orderAttributes.push({
        meta: {
          href: `${baseUrl}/entity/customerorder/metadata/attributes/${deliveryMethodAttr}`,
          type: "attributemetadata",
          mediaType: "application/json"
        },
        value: {
          meta: {
            href,
            type: "customentity",
            mediaType: "application/json"
          }
        }
      });
    }
  }
  if (orderNoteAttr && trimmedNote) {
    orderAttributes.push({
      meta: {
        href: `${baseUrl}/entity/customerorder/metadata/attributes/${orderNoteAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: trimmedNote
    });
  }
  if (orderAddressDetailsAttr && deliveryInfo.addressExtra) {
    orderAttributes.push({
      meta: {
        href: `${baseUrl}/entity/customerorder/metadata/attributes/${orderAddressDetailsAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: deliveryInfo.addressExtra
    });
  }
  if (orderAttributes.length > 0) orderBody.attributes = orderAttributes;

  const data = await moskladFetch<{ id: string; name: string }>(`/entity/customerorder`, {
    method: "POST",
    body: orderBody
  });

  return data;
}

function formatYandexMapsLink(lat: number, lng: number) {
  return `https://yandex.ru/maps/?ll=${lng},${lat}&z=16&pt=${lng},${lat}`;
}

function buildCustomEntityHref(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  if (trimmed.startsWith("/entity/customentity/")) {
    return `${baseUrl}${trimmed}`;
  }
  if (trimmed.startsWith("entity/customentity/")) {
    return `${baseUrl}/${trimmed}`;
  }
  if (trimmed.startsWith("customentity/")) {
    return `${baseUrl}/entity/${trimmed}`;
  }
  if (trimmed.includes("/")) {
    return `${baseUrl}/entity/customentity/${trimmed}`;
  }
  return `${baseUrl}/entity/customentity/${trimmed}`;
}

export async function listCustomerShipments(counterpartyId: string) {
  const data = await moskladFetch<{
    rows: Array<{
      id: string;
      name: string;
      moment: string;
      sum: number;
      state?: { name?: string };
      attributes?: Array<{ name: string; value: string | number | boolean | null }>;
    }>;
  }>(`/entity/demand?filter=agent=${encodeURIComponent(`${baseUrl}/entity/counterparty/${counterpartyId}`)}&order=moment,desc&limit=10`);

  return data.rows.map((row) => ({
    id: row.id,
    name: row.name,
    moment: row.moment,
    sum: row.sum / 100,
    state: row.state?.name || null,
    driverInfo: extractDriverInfo(row.attributes || [])
  }));
}

export async function listOrderDemands(orderId: string) {
  const rows = await fetchAllPages<{
    id: string;
    name: string;
    moment: string;
    sum: number;
    state?: { name?: string };
    attributes?: Array<{ name: string; value: string | number | boolean | null }>;
  }>(`/entity/customerorder/${orderId}/demands?expand=state`);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    moment: row.moment,
    sum: row.sum / 100,
    state: row.state?.name || null,
    driverInfo: extractDriverInfo(row.attributes || [])
  }));
}

export async function getCustomerOrder(orderId: string) {
  return moskladFetch<{
    id: string;
    name: string;
    applicable?: boolean;
    moment?: string;
    sum?: number;
    payedSum?: number;
    description?: string;
    shipmentAddress?: string;
    state?: { name?: string };
    agent?: { meta?: { href?: string }; name?: string; phone?: string };
    attributes?: Array<{ id?: string; name: string; value: any; meta?: { href?: string } }>;
    demands?: Array<{ id: string; name: string; moment: string; sum: number; state?: { name?: string } }>;
  }>(`/entity/customerorder/${orderId}?expand=state,demands,demands.state,agent`);
}

export async function listCustomerOrderPositions(orderId: string) {
  const data = await moskladFetch<{
    rows: Array<{
      quantity: number;
      price?: number;
      assortment?: { name?: string; meta?: { href?: string } };
    }>;
  }>(`/entity/customerorder/${orderId}/positions?expand=assortment`);

  return data.rows.map((row) => ({
    assortmentId: extractIdFromHref(row.assortment?.meta?.href),
    name: row.assortment?.name || "Item",
    quantity: row.quantity,
    price: typeof row.price === "number" ? row.price / 100 : null
  }));
}

export async function fetchOrdersInRange(startStr: string, endStr: string) {
  const filter = `moment>=${startStr};moment<=${endStr}`;
  const data = await moskladFetch<{
    rows: Array<{ sum: number }>;
  }>(`/entity/customerorder?filter=${encodeURIComponent(filter)}&limit=1000`);
  return data.rows;
}

export async function fetchTopProductsInRange(startStr: string, endStr: string, limit = 5) {
  try {
    const data = await moskladFetch<{
      rows: Array<{
        assortment?: { name?: string };
        sellQuantity?: number;
      }>;
    }>(`/report/sales/byproduct?momentFrom=${encodeURIComponent(startStr)}&momentTo=${encodeURIComponent(endStr)}&limit=100`);
    return data.rows
      .sort((a, b) => (b.sellQuantity ?? 0) - (a.sellQuantity ?? 0))
      .slice(0, limit);
  } catch (err) {
    console.error('[mosklad] fetchTopProductsInRange error:', err);
    return [];
  }
}

export async function getDemand(demandId: string) {
  return moskladFetch<{
    id: string;
    name: string;
    applicable?: boolean;
    moment?: string;
    sum?: number;
    shipmentAddress?: string;
    state?: { name?: string };
    agent?: { meta?: { href?: string }; name?: string; phone?: string };
    customerOrder?: { meta?: { href?: string } };
    attributes?: Array<{ name: string; value: string | number | boolean | null }>;
  }>(`/entity/demand/${demandId}?expand=state,agent,customerOrder`);
}

export async function listDemandPositions(demandId: string) {
  const data = await moskladFetch<{
    rows: Array<{
      quantity: number;
      price?: number;
      assortment?: { name?: string; meta?: { href?: string } };
    }>;
  }>(`/entity/demand/${demandId}/positions?expand=assortment`);

  return data.rows.map((row) => ({
    assortmentId: extractIdFromHref(row.assortment?.meta?.href),
    name: row.assortment?.name || "Item",
    quantity: row.quantity,
    price: typeof row.price === "number" ? row.price / 100 : null
  }));
}

export async function getIncomingPayment(paymentId: string) {
  return moskladFetch<{
    id: string;
    name: string;
    moment?: string;
    sum?: number;
    description?: string;
    agent?: { meta?: { href?: string }; name?: string };
  }>(`/entity/paymentin/${paymentId}?expand=agent`);
}

export async function getCashIn(cashinId: string) {
  return moskladFetch<{
    id: string;
    name: string;
    moment?: string;
    sum?: number;
    description?: string;
    agent?: { meta?: { href?: string }; name?: string };
  }>(`/entity/cashin/${cashinId}?expand=agent`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractDriverInfo(attributes: Array<{ name: string; value: string | number | boolean | null }>) {
  const modelKeys = envList("MOSKLAD_DRIVER_MODEL_ATTRS");
  const numberKeys = envList("MOSKLAD_DRIVER_NUMBER_ATTRS");

  const findValue = (names: string[]) =>
    attributes.find((attr) => names.includes(attr.name))?.value?.toString() || null;

  const model = findValue(modelKeys);
  const number = findValue(numberKeys);

  if (!model && !number) return null;
  return { model, number };
}

function envList(name: string) {
  return (process.env[name] || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function extractIdFromHref(href?: string) {
  if (!href) return null;
  const parts = href.split("/");
  const last = parts[parts.length - 1];
  return last ? last.split("?")[0] : null;
}
