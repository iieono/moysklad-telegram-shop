import {
  getCustomerOrder,
  listCustomerOrderPositions,
  listOrderDemands,
  listDemandPositions
} from "./mosklad.js";

type DemandPosition = {
  assortmentId?: string | null;
  name: string;
  quantity: number;
  price: number | null;
};

type DemandPdfPosition = DemandPosition & {
  remainingQty?: number | null;
  remainingSum?: number | null;
};

type DemandLike = {
  id?: string;
  customerOrder?: { meta?: { href?: string } };
  sum?: number;
};

function normalizeName(name: string | undefined | null) {
  if (!name) return "";
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export async function buildDemandPdfData(
  demand: DemandLike,
  demandPositions: DemandPosition[]
): Promise<{ positions: DemandPdfPosition[]; leftToPay: number | null }> {
  const orderId = extractIdFromHref(demand.customerOrder?.meta?.href, "/entity/customerorder/");
  if (!orderId) {
    return { positions: demandPositions, leftToPay: null };
  }

  try {
    const [order, orderPositions, orderDemands] = await Promise.all([
      getCustomerOrder(orderId),
      listCustomerOrderPositions(orderId).catch(() => [] as Awaited<ReturnType<typeof listCustomerOrderPositions>>),
      listOrderDemands(orderId).catch(() => [] as Awaited<ReturnType<typeof listOrderDemands>>)
    ]);

    const demandQtyById = new Map<string, number>();
    const demandQtyByName = new Map<string, number>();
    for (const pos of demandPositions) {
      const key = normalizeName(pos.name);
      if (key) {
        demandQtyByName.set(key, (demandQtyByName.get(key) || 0) + pos.quantity);
      }
      if (pos.assortmentId) {
        demandQtyById.set(pos.assortmentId, (demandQtyById.get(pos.assortmentId) || 0) + pos.quantity);
      }
    }

    const orderQtyById = new Map<string, number>();
    const orderPriceById = new Map<string, number>();
    const orderQtyByName = new Map<string, number>();
    const orderPriceByName = new Map<string, number>();
    for (const pos of orderPositions) {
      const key = normalizeName(pos.name);
      if (key) {
        orderQtyByName.set(key, (orderQtyByName.get(key) || 0) + pos.quantity);
        if (typeof pos.price === "number") orderPriceByName.set(key, pos.price);
      }
      if (!pos.assortmentId) continue;
      orderQtyById.set(pos.assortmentId, (orderQtyById.get(pos.assortmentId) || 0) + pos.quantity);
      if (typeof pos.price === "number") orderPriceById.set(pos.assortmentId, pos.price);
    }

    const demandRefs = new Map<string, { id: string }>();
    for (const d of order.demands ?? []) {
      if (d?.id) demandRefs.set(d.id, { id: d.id });
    }

    const demandPositionLists = await Promise.all(
      Array.from(demandRefs.values()).map((d) =>
        listDemandPositions(d.id).catch(() => [] as Awaited<ReturnType<typeof listDemandPositions>>)
      )
    );

    const shippedQtyById = new Map<string, number>();
    const shippedQtyByName = new Map<string, number>();
    let shippedTotal = 0;
    for (const positions of demandPositionLists) {
      for (const pos of positions) {
        const key = normalizeName(pos.name);
        if (key) {
          shippedQtyByName.set(key, (shippedQtyByName.get(key) || 0) + pos.quantity);
        }
        if (pos.assortmentId) {
          const nextQty = (shippedQtyById.get(pos.assortmentId) || 0) + pos.quantity;
          shippedQtyById.set(pos.assortmentId, nextQty);
        }
        const unitPrice = pos.assortmentId
          ? (orderPriceById.get(pos.assortmentId) ?? orderPriceByName.get(key || "") ?? pos.price)
          : (orderPriceByName.get(key || "") ?? pos.price);
        if (typeof unitPrice === "number") {
          shippedTotal += unitPrice * pos.quantity;
        }
      }
    }

    const rawOrderTotal = typeof order.sum === "number" ? order.sum / 100 : null;
    const computedTotal = orderPositions.reduce((sum, pos) => {
      if (typeof pos.price !== "number") return sum;
      return sum + pos.price * pos.quantity;
    }, 0);
    const orderTotal = rawOrderTotal && rawOrderTotal > 0
      ? rawOrderTotal
      : computedTotal > 0
        ? computedTotal
        : null;

    const leftToPay = orderTotal !== null
      ? Math.max(0, Math.round((orderTotal - shippedTotal) * 100) / 100)
      : null;

    const positions: DemandPdfPosition[] = orderPositions.map((pos) => {
      const key = normalizeName(pos.name);
      const hasIdMatch = !!pos.assortmentId && orderQtyById.has(pos.assortmentId);
      const hasNameMatch = key ? orderQtyByName.has(key) : false;
      const orderedQty = hasIdMatch
        ? (orderQtyById.get(pos.assortmentId!) ?? 0)
        : (orderQtyByName.get(key) ?? 0);
      const shippedQty = hasIdMatch
        ? (shippedQtyById.get(pos.assortmentId!) ?? 0)
        : (shippedQtyByName.get(key || "") ?? 0);
      const currentQty = hasIdMatch
        ? (demandQtyById.get(pos.assortmentId!) ?? 0)
        : (demandQtyByName.get(key || "") ?? 0);
      const remainingQty = Math.max(0, orderedQty - shippedQty);
      const unitPrice = typeof pos.price === "number"
        ? pos.price
        : orderPriceByName.get(key || "") ?? null;
      const remainingSum = typeof unitPrice === "number"
        ? remainingQty * unitPrice
        : null;
      return {
        assortmentId: pos.assortmentId ?? null,
        name: pos.name,
        quantity: currentQty,
        price: typeof unitPrice === "number" ? unitPrice : null,
        remainingQty,
        remainingSum
      };
    });

    for (const pos of demandPositions) {
      const key = normalizeName(pos.name);
      const hasIdMatch = pos.assortmentId && orderQtyById.has(pos.assortmentId);
      const hasNameMatch = key ? orderQtyByName.has(key) : false;
      if (hasIdMatch || hasNameMatch) continue;
      const unitPrice = typeof pos.price === "number" ? pos.price : null;
      positions.push({
        ...pos,
        quantity: pos.quantity,
        price: unitPrice,
        remainingQty: null,
        remainingSum: null
      });
    }

    return { positions, leftToPay };
  } catch {
    return { positions: demandPositions, leftToPay: null };
  }
}

function extractIdFromHref(href: string | undefined, marker: string) {
  if (!href) return null;
  const index = href.indexOf(marker);
  if (index === -1) return null;
  return href.slice(index + marker.length).split("?")[0].split("/")[0] || null;
}
