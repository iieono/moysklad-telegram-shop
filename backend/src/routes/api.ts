import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import {
  listCategories,
  listProducts,
  listProductsByCategory,
  getProductsByIds,
  getCustomerOrder,
  getOrCreateCounterparty,
  createCustomerOrder,
  fetchProductImages,
  getCustomerBalance,
  getBaseCurrencyCode,
  listCustomerOrders,
  listCustomerOrderPositions,
  getDemand,
  listDemandPositions,
  getIncomingPayment,
  getCashIn,
  updateCounterpartyAddress,
  getCounterparty
} from "../mosklad.js";
import { generateDemandPdf, makePdfFilename } from "../pdf.js";
import { buildDemandPdfData } from "../demand-pdf.js";
import { createOrderReminders } from "../reminders.js";
import { cache } from "../cache.js";

function parseDefaultAddress(addr: string | null): { lat: number; lng: number } | null {
  if (!addr) return null;
  const match = addr.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = parseFloat(match[1]);
  const lng = parseFloat(match[2]);
  if (isNaN(lat) || isNaN(lng)) return null;
  return { lat, lng };
}

export function registerApiRoutes(server: FastifyInstance) {
  server.get("/api/categories", async () => {
    const cacheKey = "categories";
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const data = await listCategories();
    cache.set(cacheKey, data, 300); // 5 minutes
    return data;
  });

  server.get("/api/user-info", async (request, reply) => {
    const { telegramId } = request.query as { telegramId?: string };
    if (!telegramId) {
      reply.code(400);
      return { error: "telegramId required" };
    }

    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user || !user.phoneNumber || !user.moskladCounterpartyId) {
      return { isRegistered: false, language: user?.language || "uz" };
    }

    try {
      const [balance, balanceCurrency, counterparty] = await Promise.all([
        getCustomerBalance(user.moskladCounterpartyId),
        getBaseCurrencyCode(),
        getCounterparty(user.moskladCounterpartyId).catch(() => null)
      ]);
      const coords = parseDefaultAddress(user.defaultAddress);
      const addressAttrId = process.env.MOSKLAD_COUNTERPARTY_ADDRESS_ATTR;
      const addressDetailsAttrId = process.env.COUNTERPARTY_ADDRESS_DETAILS;
      let defaultAddressText: string | null = null;
      let defaultAddressExtra: string | null = null;
      if (counterparty?.attributes) {
        if (addressAttrId) {
          const m = counterparty.attributes.find((a: any) => a.id === addressAttrId || (a.meta?.href || "").includes(addressAttrId));
          if (m && typeof m.value === "string") defaultAddressText = m.value;
        }
        if (addressDetailsAttrId) {
          const m = counterparty.attributes.find((a: any) => a.id === addressDetailsAttrId || (a.meta?.href || "").includes(addressDetailsAttrId));
          if (m && typeof m.value === "string") defaultAddressExtra = m.value;
        }
      }
      return {
        isRegistered: true,
        language: user.language || "uz",
        balance,
        balanceCurrency,
        firstName: user.firstName,
        phoneNumber: user.phoneNumber ?? null,
        counterpartyName: counterparty?.name ?? null,
        defaultLat: coords?.lat ?? null,
        defaultLng: coords?.lng ?? null,
        defaultAddressText,
        defaultAddressExtra
      };
    } catch {
      const coords = parseDefaultAddress(user.defaultAddress);
      return {
        isRegistered: true,
        language: user.language || "uz",
        balance: 0,
        balanceCurrency: null,
        firstName: user.firstName,
        phoneNumber: user.phoneNumber ?? null,
        counterpartyName: null,
        defaultLat: coords?.lat ?? null,
        defaultLng: coords?.lng ?? null,
        defaultAddressText: null,
        defaultAddressExtra: null
      };
    }
  });

  server.get("/api/products", async (request) => {
    const query = request.query as { categoryId?: string };
    const cacheKey = query.categoryId ? `products:${query.categoryId}` : "products:all";

    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const data = query.categoryId
      ? await listProductsByCategory(query.categoryId)
      : await listProducts();

    cache.set(cacheKey, data, 300); // 5 minutes
    return data;
  });

  server.get("/api/products/:productId/images", async (request, reply) => {
    const { productId } = request.params as { productId: string };
    try {
      return await fetchProductImages(productId);
    } catch {
      reply.code(404);
      return [];
    }
  });

  server.get("/api/product-image/:productId/:imageId", async (request, reply) => {
    const { productId, imageId } = request.params as { productId: string; imageId: string };
    const moskladToken = process.env.MOSKLAD_TOKEN;
    const base = process.env.MOSKLAD_BASE_URL || "https://api.moysklad.ru/api/remap/1.2";
    const response = await fetch(
      `${base}/entity/product/${productId}/images/${imageId}/download`,
      { headers: { Authorization: `Basic ${moskladToken}` } }
    );
    if (!response.ok) {
      reply.code(404);
      return;
    }
    const contentType = response.headers.get("content-type") || "image/jpeg";
    reply.header("content-type", contentType);
    reply.header("cache-control", "public, max-age=3600");
    return reply.send(Buffer.from(await response.arrayBuffer()));
  });

  server.post("/api/draft-order", async (request, reply) => {
    const body = request.body as {
      telegramId: string;
      items: Array<{ id: string; quantity: number }>;
      language?: string;
      deliveryMethod?: "pickup" | "delivery";
      orderNote?: string | null;
      locationLat?: number | null;
      locationLng?: number | null;
      addressDetails?: string | null;
      addressExtra?: string | null;
    };

    const user = await prisma.user.upsert({
      where: { telegramId: body.telegramId },
      update: { language: body.language || undefined },
      create: {
        telegramId: body.telegramId,
        phoneNumber: null,
        language: body.language || "uz"
      }
    });

    if (!body.items?.length) {
      reply.code(400);
      return { error: "Cart is empty" };
    }

    const products = await getProductsByIds(body.items.map((item) => item.id));
    const productMap = new Map(products.map((product) => [product.id, product]));

    const items = body.items
      .map((item) => {
        const product = productMap.get(item.id);
        if (!product) return null;
        return {
          productId: product.id,
          name: product.name,
          price: Math.round(product.price * 100),
          quantity: Math.max(1, Math.round(item.quantity))
        };
      })
      .filter(Boolean) as Array<{ productId: string; name: string; price: number; quantity: number }>;

    if (!items.length) {
      reply.code(400);
      return { error: "No valid items" };
    }

    const orderNote = body.orderNote?.trim() || null;
    const draft = await prisma.draftOrder.upsert({
      where: { userId: user.id },
      update: {
        deliveryMethod: body.deliveryMethod || null,
        orderNote,
        addressText: body.addressDetails ?? null,
        locationLat: body.locationLat ?? null,
        locationLng: body.locationLng ?? null,
        items: {
          deleteMany: {},
          create: items
        }
      },
      create: {
        userId: user.id,
        deliveryMethod: body.deliveryMethod || null,
        orderNote,
        addressText: body.addressDetails ?? null,
        locationLat: body.locationLat ?? null,
        locationLng: body.locationLng ?? null,
        items: {
          create: items
        }
      },
      include: { items: true }
    });

    // Update last order time and create reminders
    await prisma.user.update({
      where: { id: user.id },
      data: { lastOrderAt: new Date() }
    });
    await createOrderReminders(user.id);

    // Handle pickup: create order immediately in MoySklad
    if (body.deliveryMethod === "pickup" && user.phoneNumber) {
      try {
        const counterpartyId = await getOrCreateCounterparty(
          user.telegramId,
          user.phoneNumber,
          user.firstName || undefined,
          user.username || undefined
        );
        const order = await createCustomerOrder(counterpartyId, items.map((i) => ({ id: i.productId, quantity: i.quantity, price: i.price / 100 })), {
          deliveryMethod: "pickup",
          orderNote
        });
        // Clear draft after order created
        await prisma.draftOrder.delete({ where: { userId: user.id } }).catch(() => {});

        const lang = user.language || "uz";
        const receivedMsg =
          lang === "ru"
            ? "📝 Заказ получен."
            : lang === "uzc"
              ? "📝 Буюртма қабул қилинди."
              : "📝 Buyurtma qabul qilindi.";
        await sendTelegramMessage(user.telegramId, receivedMsg);

        return { orderName: order.name };
      } catch (err) {
        // If MoySklad fails, fall through and return draftId
        console.error("Failed to create pickup order:", err);
        return { draftId: draft.id };
      }
    }

    // Handle delivery with location from webapp: create order immediately
    if (body.deliveryMethod === "delivery" && user.phoneNumber && body.locationLat && body.locationLng) {
      try {
        const counterpartyId = await getOrCreateCounterparty(
          user.telegramId,
          user.phoneNumber,
          user.firstName || undefined,
          user.username || undefined
        );
        const order = await createCustomerOrder(counterpartyId, items.map((i) => ({ id: i.productId, quantity: i.quantity, price: i.price / 100 })), {
          deliveryMethod: "delivery",
          orderNote,
          locationLat: body.locationLat,
          locationLng: body.locationLng,
          addressText: body.addressDetails || null,
          addressExtra: body.addressExtra || null
        });
        await prisma.draftOrder.delete({ where: { userId: user.id } }).catch(() => {});

        const lang = user.language || "uz";
        const receivedMsg =
          lang === "ru"
            ? "📝 Заказ получен."
            : lang === "uzc"
              ? "📝 Буюртма қабул қилинди."
              : "📝 Buyurtma qabul qilindi.";
        await sendTelegramMessage(user.telegramId, receivedMsg);

        // Save delivery location as user's default address
        const gpsString = `${body.locationLat},${body.locationLng}`;
        const yandexMapsLink = `https://yandex.ru/maps/?ll=${body.locationLng},${body.locationLat}&z=16&pt=${body.locationLng},${body.locationLat}`;
        await prisma.user.update({ where: { id: user.id }, data: { defaultAddress: gpsString } });
        await updateCounterpartyAddress(counterpartyId, {
          location: yandexMapsLink,
          addressName: body.addressDetails || null,
          addressExtra: body.addressExtra || null
        }).catch(() => {});

        return { orderName: order.name };
      } catch (err) {
        console.error("Failed to create delivery order:", err);
        return { draftId: draft.id };
      }
    }

    // Handle delivery: save draft and send address request via Telegram
    if (body.deliveryMethod === "delivery" && user.phoneNumber) {
      const lang = user.language || "uz";
      await sendDeliveryAddressRequest(user.telegramId, lang, user.defaultAddress || null);
      return { draftId: draft.id, awaitingLocation: true };
    }

    return { draftId: draft.id };
  });

  server.post("/api/webhooks/mosklad", async (request) => {
    const body = request.body as any;
    const events = Array.isArray(body?.events) ? body.events : Array.isArray(body) ? body : [body];

    // Track counterparties for which a demand CREATE was processed in this batch,
    // so we can suppress the redundant customerorder UPDATE notification MoySklad fires.
    const demandCreatedCounterparties = new Set<string>();

    for (const event of events) {
      const href = event?.meta?.href || event?.href || event?.entity?.meta?.href;
      const eventAction: string = (event?.action || event?.eventType || "").toUpperCase();

      // Handle counterparty DELETE - clear user's link and prompt re-registration
      const entityType = event?.meta?.type || extractTypeFromHref(href);
      if (entityType === "counterparty" && eventAction === "DELETE") {
        const counterpartyId = extractIdFromHref(href, "/entity/counterparty/");
        if (!counterpartyId) continue;

        const user = await prisma.user.findFirst({ where: { moskladCounterpartyId: counterpartyId } });
        if (!user) continue;

        // Full reset - user must re-register from scratch
        await prisma.user.update({
          where: { id: user.id },
          data: {
            moskladCounterpartyId: null,
            phoneNumber: null,
            defaultAddress: null,
            pendingState: null
          }
        });

        const lang = user.language || "uz";
        const msg =
          lang === "ru"
            ? "⚠️ Ваш аккаунт был удалён из системы. Пожалуйста, зарегистрируйтесь заново через /start."
            : lang === "uzc"
              ? "⚠️ Ҳисобингиз тизимдан ўчирилди. Илтимос, /start орқали қайта рўйхатдан ўтинг."
              : "⚠️ Hisobingiz tizimdan o'chirildi. Iltimos, /start orqali qayta ro'yxatdan o'ting.";
        await sendTelegramMessage(user.telegramId, msg, undefined, true);
        continue;
      }

      const updatedFields = Array.isArray(event?.updatedFields)
        ? (event.updatedFields as string[])
        : [];
      const updatedFieldSet = new Set(updatedFields.map((field: string) => field.toLowerCase()));

      if (entityType === "demand") {
        const demandId =
          event?.orderId ||
          event?.entityId ||
          extractIdFromHref(href, "/entity/demand/");
        if (!demandId) continue;

        if (eventAction === "DELETE") {
          continue;
        }

        // Skip deletion-related UPDATE: MoySklad fires this before the DELETE event.
        // Check updatedFields first (no API fetch needed, no race condition).
        if (updatedFieldSet.has("applicable")) continue;

        // Skip UPDATE events triggered by a payment being linked to this demand
        if (updatedFieldSet.has("payments") || updatedFieldSet.has("payedsum")) continue;

        const [demand, currencyCode, demandPositions] = await Promise.all([
          getDemand(demandId),
          getBaseCurrencyCode().catch(() => null),
          listDemandPositions(demandId).catch(() => [] as Awaited<ReturnType<typeof listDemandPositions>>)
        ]);

        const counterpartyId = extractIdFromHref(demand.agent?.meta?.href, "/entity/counterparty/");
        if (!counterpartyId) continue;

        // Fallback check in case updatedFields wasn't included in the webhook payload
        if (demand.applicable === false) continue;

        const user = await prisma.user.findFirst({
          where: { moskladCounterpartyId: counterpartyId }
        });
        if (!user) continue;

        const lang = user.language || "uz";
        const totalSum = typeof demand.sum === "number" ? demand.sum / 100 : null;
        const totalText =
          totalSum !== null ? formatMoneyWithCurrency(totalSum, currencyCode, lang) : null;
        const statusText = mapStatus(demand.state?.name || "", lang);

        if (eventAction === "CREATE") {
          demandCreatedCounterparties.add(counterpartyId);
          // Suppress the order UPDATE that MoySklad fires when a demand is created,
          // even if it arrives in a separate webhook batch (60-second window).
          cache.set(`demand_created:${counterpartyId}`, true, 60);

          const msg =
            lang === "ru"
              ? `📦 Отгрузка создана: ${demand.name}\nСтатус: ${statusText}${totalText ? `\nСумма: ${totalText}` : ""}`
              : lang === "uzc"
                ? `📦 Йўлга чиқариш ҳужжати яратилди: ${demand.name}\nҲолат: ${statusText}${totalText ? `\nЖами: ${totalText}` : ""}`
                : `📦 Yo'lga chiqarish hujjati yaratildi: ${demand.name}\nHolat: ${statusText}${totalText ? `\nJami: ${totalText}` : ""}`;
          await sendTelegramMessage(user.telegramId, msg);

          // Send PDF receipt
          const balanceAfterDemand = await getCustomerBalance(counterpartyId).catch(() => null);
          // Demand creation decreases balance (customer owes more), so balanceBefore = balanceAfter + demandSum
          const balanceBeforeDemand = balanceAfterDemand !== null && totalSum !== null
            ? balanceAfterDemand + totalSum
            : null;
          const { positions: pdfPositions, leftToPay } = await buildDemandPdfData(demand, demandPositions);
          generateDemandPdf({
            demand: { ...demand, sum: typeof demand.sum === "number" ? demand.sum / 100 : undefined },
            positions: pdfPositions,
            client: { firstName: demand.agent?.name || user.firstName, lastName: null, phoneNumber: user.phoneNumber },
            lang,
            currencyCode,
            balanceBefore: balanceBeforeDemand,
            balanceAfter: balanceAfterDemand,
            leftToPay,
            deliveryAddress: demand.shipmentAddress || null
          }).then((pdfBuffer) =>
            sendTelegramDocument(user.telegramId, pdfBuffer, makePdfFilename(demand))
          ).catch((err) => console.error("Failed to send demand PDF:", err));

          // Notify admins about new demand
          await notifyAdminsByType("newOrder", (adminLang) => {
            const header = adminLang === "ru"
              ? `📦 Новая отгрузка: ${demand.name}`
              : adminLang === "uzc"
                ? `📦 Янги йўлга чиқариш ҳужжати: ${demand.name}`
                : `📦 Yangi yo'lga chiqarish hujjati: ${demand.name}`;
            const clientLabel = adminLang === "ru" ? "Клиент" : adminLang === "uzc" ? "Мижоз" : "Mijoz";
            const phoneLabel = adminLang === "ru" || adminLang === "uzc" ? "Телефон" : "Telefon";
            const statusLabel = adminLang === "ru" ? "Статус" : adminLang === "uzc" ? "Ҳолат" : "Holat";
            const totalLabel = adminLang === "ru" ? "Сумма" : adminLang === "uzc" ? "Жами" : "Jami";
            const adminStatus = mapStatus(demand.state?.name || "", adminLang);
            const adminTotal = totalSum !== null ? formatMoneyWithCurrency(totalSum, currencyCode, adminLang) : null;
            const clientName = demand.agent?.name || `${user.firstName || ""} ${user.lastName || ""}`.trim();
            const itemsLines = demandPositions.length
              ? "\n" + demandPositions.map((p) => `  • ${p.name}: ${formatQuantity(p.quantity)}`).join("\n")
              : "";
            let msg = `${header}\n${clientLabel}: ${clientName}\n${phoneLabel}: ${user.phoneNumber || ""}\n${statusLabel}: ${adminStatus}`;
            if (adminTotal) msg += `\n${totalLabel}: ${adminTotal}`;
            if (itemsLines) msg += itemsLines;
            return msg;
          });

        } else {
          const detailLines = buildDemandUpdateDetails(updatedFieldSet, lang, totalText, statusText);
          const detailsText = detailLines.length ? `\n${detailLines.join("\n")}` : "";
          const msg =
            lang === "ru"
              ? `🔄 Отгрузка ${demand.name} обновлена.${detailsText}`
              : lang === "uzc"
                ? `🔄 Йўлга чиқариш ҳужжати ${demand.name} янгиланди.${detailsText}`
                : `🔄 Yo'lga chiqarish hujjati ${demand.name} yangilandi.${detailsText}`;
          const pdfBtnLabel = "📄 PDF";
          await sendTelegramMessageWithKeyboard(user.telegramId, msg, [[{ text: pdfBtnLabel, callback_data: `demand:pdf:${demand.id}` }]]);
        }

        continue;
      }

      if (entityType === "paymentin" || entityType === "cashin") {
        if (eventAction !== "CREATE") continue;

        const marker = entityType === "paymentin" ? "/entity/paymentin/" : "/entity/cashin/";
        const paymentId = extractIdFromHref(href, marker);
        if (!paymentId) continue;

        const payment = await (entityType === "paymentin"
          ? getIncomingPayment(paymentId)
          : getCashIn(paymentId));

        const counterpartyId = extractIdFromHref(payment.agent?.meta?.href, "/entity/counterparty/");
        if (!counterpartyId) continue;

        const user = await prisma.user.findFirst({ where: { moskladCounterpartyId: counterpartyId } });
        if (!user) continue;

        const [currencyCode, balance] = await Promise.all([
          getBaseCurrencyCode().catch(() => null),
          getCustomerBalance(counterpartyId).catch(() => null)
        ]);

        const lang = user.language || "uz";
        const totalSum = typeof payment.sum === "number" ? payment.sum / 100 : null;
        const totalText = totalSum !== null ? formatMoneyWithCurrency(totalSum, currencyCode, lang) : null;
        const balanceText = balance !== null ? formatMoneyWithCurrency(balance, currencyCode, lang) : null;

        const paymentTypeLabel =
          entityType === "cashin"
            ? (lang === "ru" ? "Наличные" : lang === "uzc" ? "Нақд пул" : "Naqd pul")
            : (lang === "ru" ? "Безнал" : lang === "uzc" ? "Банк ўтказмаси" : "Bank o'tkazmasi");

        const userMsg =
          lang === "ru"
            ? `💰 Ваш платёж принят!\nТип: ${paymentTypeLabel}${totalText ? `\nСумма: ${totalText}` : ""}${balanceText ? `\nБаланс: ${balanceText}` : ""}`
            : lang === "uzc"
              ? `💰 Тўловингиз қабул қилинди!\nТури: ${paymentTypeLabel}${totalText ? `\nСумма: ${totalText}` : ""}${balanceText ? `\nБалансингиз: ${balanceText}` : ""}`
              : `💰 To'lovingiz qabul qilindi!\nTuri: ${paymentTypeLabel}${totalText ? `\nSumma: ${totalText}` : ""}${balanceText ? `\nBalansingiz: ${balanceText}` : ""}`;

        await sendTelegramMessage(user.telegramId, userMsg);

        await notifyAdminsByType("payment", (adminLang) => {
          const adminTotal = totalSum !== null ? formatMoneyWithCurrency(totalSum, currencyCode, adminLang) : "—";
          const clientName = `${user.firstName || ""}${user.lastName ? " " + user.lastName : ""}`.trim();
          const adminPayType =
            entityType === "cashin"
              ? (adminLang === "ru" ? "Наличные" : adminLang === "uzc" ? "Нақд пул" : "Naqd pul")
              : (adminLang === "ru" ? "Безнал" : adminLang === "uzc" ? "Банк ўтказмаси" : "Bank o'tkazmasi");
          if (adminLang === "ru") {
            return `💰 Новый платёж!\nКлиент: ${clientName}\nТел: ${user.phoneNumber || ""}\nТип: ${adminPayType}\nСумма: ${adminTotal}`;
          }
          if (adminLang === "uzc") {
            return `💰 Янги тўлов!\nМижоз: ${clientName}\nТел: ${user.phoneNumber || ""}\nТури: ${adminPayType}\nСумма: ${adminTotal}`;
          }
          return `💰 Yangi to'lov!\nMijoz: ${clientName}\nTel: ${user.phoneNumber || ""}\nTuri: ${adminPayType}\nSumma: ${adminTotal}`;
        });

        continue;
      }

      const orderId =
        event?.orderId ||
        event?.entityId ||
        extractIdFromHref(href, "/entity/customerorder/");
      if (!orderId) continue;

      if (eventAction === "DELETE") {
        continue;
      }

      const [order, positions, currencyCode] = await Promise.all([
        getCustomerOrder(orderId),
        listCustomerOrderPositions(orderId).catch(() => []),
        getBaseCurrencyCode().catch(() => null)
      ]);
      // Skip when MoySklad voids the order before deletion (applicable=false)
      if (order.applicable === false) continue;
      const agentHref = order.agent?.meta?.href;
      const counterpartyId = extractIdFromHref(agentHref, "/entity/counterparty/");
      if (!counterpartyId) continue;

      const user = await prisma.user.findFirst({
        where: { moskladCounterpartyId: counterpartyId }
      });
      if (!user) continue;

      const lang = user.language || "uz";

      const deliveryMethod = extractDeliveryMethod(order);
      const totalSum = typeof order.sum === "number" ? order.sum / 100 : null;
      const computedSum = positions.reduce((sum, pos) => {
        if (typeof (pos as any).price !== "number") return sum;
        return sum + (pos as any).price * pos.quantity;
      }, 0);
      const effectiveTotal = totalSum && totalSum > 0 ? totalSum : computedSum > 0 ? computedSum : null;
      const totalText = formatMoneyWithCurrency(effectiveTotal ?? 0, currencyCode, lang);
      const itemsText = positions.length ? formatPositionsTable(positions, lang) : null;

      if (eventAction === "CREATE") {
        // New order created - confirm to user (MoySklad)
        const deliveryLine = formatDeliveryWithEmoji(deliveryMethod, lang);
        const addrLines = buildOrderAddressLines(order, lang);
        // Empty line between delivery type and address block
        const addrBlock = addrLines ? `\n\n${addrLines}` : "";
        const totalLabel = lang === "ru" ? "Сумма" : lang === "uzc" ? "Жами" : "Jami";
        // Extra empty line before total when address block is present
        const totalLine = totalText ? (addrLines ? `\n\n${totalLabel}: ${totalText}` : `\n${totalLabel}: ${totalText}`) : "";
        // Due amount (on create, nothing is paid yet so due = total)
        const orderDueAmount = (order.sum ?? 0) / 100;
        const dueLabel = lang === "ru" ? "Осталось оплатить" : lang === "uzc" ? "Қолган тўлов" : "Qolgan to'lov";
        const dueLine = orderDueAmount > 0 ? `\n⚠️ ${dueLabel}: ${formatMoneyWithCurrency(orderDueAmount, currencyCode, lang)}` : "";
        // Put items label inside <pre> block so it renders as one monospace section
        const itemsInner = itemsText ? itemsText.replace(/^<pre>/, "").replace(/<\/pre>$/, "") : null;
        const itemsLabel = lang === "ru" ? "Товары" : lang === "uzc" ? "Маҳсулотлар" : "Mahsulotlar";
        const itemsBlock = itemsInner ? `\n\n<pre>${itemsLabel}:\n${itemsInner}</pre>` : "";
        const msg =
          lang === "ru"
            ? `✅ Ваш заказ ${order.name} создан.\n${deliveryLine}${addrBlock}${totalLine}${dueLine}${itemsBlock}`
            : lang === "uzc"
              ? `✅ Сиз учун ${order.name} рақамли буюртма яратилди.\n${deliveryLine}${addrBlock}${totalLine}${dueLine}${itemsBlock}`
              : `✅ Siz uchun ${order.name} raqamli buyurtma yaratildi.\n${deliveryLine}${addrBlock}${totalLine}${dueLine}${itemsBlock}`;

        const locationPin = extractLocationFromAttributes(order.attributes);
        if (locationPin) {
          const mapUrl = `https://yandex.ru/maps/?ll=${locationPin.lng},${locationPin.lat}&z=16&pt=${locationPin.lng},${locationPin.lat}`;
          const mapLabel = lang === "ru" ? "🗺 Открыть на карте" : lang === "uzc" ? "🗺 Картада очиш" : "🗺 Kartada ochish";
          await sendTelegramMessageWithKeyboard(user.telegramId, msg, [[{ text: mapLabel, url: mapUrl }]], itemsBlock ? "HTML" : undefined);
        } else {
          await sendTelegramMessage(user.telegramId, msg, itemsBlock ? "HTML" : undefined);
        }

        await notifyAdminsByType("newOrder", (adminLang) => {
          const header = adminLang === "ru" ? `🛒 Новый заказ: ${order.name}` : adminLang === "uzc" ? `🛒 Янги буюртма: ${order.name}` : `🛒 Yangi buyurtma: ${order.name}`;
          const clientLabel = adminLang === "ru" ? "Клиент" : adminLang === "uzc" ? "Мижоз" : "Mijoz";
          const phoneLabel = adminLang === "ru" || adminLang === "uzc" ? "Телефон" : "Telefon";
          const deliveryLabel = adminLang === "ru" ? "Доставка" : adminLang === "uzc" ? "Топшириш" : "Yetkazish";
          const totalLabel = adminLang === "ru" ? "Сумма" : adminLang === "uzc" ? "Жами" : "Jami";
          const clientName = order.agent?.name || `${user.firstName || ""} ${user.lastName || ""}`.trim();
          const adminDelivery = formatDeliveryWithEmoji(deliveryMethod, adminLang);
          const adminTotal = formatMoneyWithCurrency(effectiveTotal ?? 0, currencyCode, adminLang);
          const itemsLines = positions.length
            ? "\n" + positions.map((p) => `  • ${p.name}: ${formatQuantity(p.quantity)}`).join("\n")
            : "";
          return `${header}\n${clientLabel}: ${clientName}\n${phoneLabel}: ${user.phoneNumber || ""}\n${deliveryLabel}: ${adminDelivery}\n${totalLabel}: ${adminTotal}${itemsLines}`;
        });
      } else if (
        !demandCreatedCounterparties.has(counterpartyId) &&
        !cache.get(`demand_created:${counterpartyId}`) &&
        !updatedFieldSet.has("demands") &&
        !updatedFieldSet.has("shipments") &&
        !updatedFieldSet.has("payments") &&
        !updatedFieldSet.has("payedsum")
      ) {
        // Status update — skip if triggered by demand creation/deletion (same batch, cache, or demands field)
        const rawStatus = order.state?.name?.trim() || null;
        const statusLabel = lang === "ru" ? "Статус" : lang === "uzc" ? "Ҳолат" : "Holat";

        // Delivery type
        const orderDeliveryMethod = extractDeliveryMethod(order);
        const deliveryTypeText = orderDeliveryMethod ? formatDeliveryWithEmoji(orderDeliveryMethod, lang) : null;
        const deliveryLabel = lang === "ru" ? "Тип доставки" : lang === "uzc" ? "Топшириш тури" : "Yetkazib berish turi";

        // Address text + extra details (kv/kirish/qavat/domofon)
        const addressText = extractAttributeValue(order.attributes || [], envList("MOSKLAD_ORDER_ADDRESS_ATTR"))
          || order.shipmentAddress || null;
        const addressLabel = lang === "ru" ? "Адрес доставки" : lang === "uzc" ? "Етказиб бериш манзили" : "Yetkazib berish manzili";
        const addressExtra = extractAttributeValue(order.attributes || [], envList("ORDER_ADDRESS_DETAILS"));
        const extraLine = addressExtra ? formatAddressExtraLine(addressExtra, lang) : null;

        // Driver info
        const driverInfo = extractDriverInfo(order.attributes as Array<{ name: string; value: string | number | boolean | null }> || []);
        const driverModelLabel = lang === "ru" ? "Модель машины" : lang === "uzc" ? "Машина модели" : "Mashina modeli";
        const driverNumLabel = lang === "ru" ? "Номер машины" : lang === "uzc" ? "Машина рақами" : "Mashina raqami";

        // Paid / due amounts
        const orderPaid = (order.payedSum ?? 0) / 100;
        const orderDue = Math.max(0, (order.sum ?? 0) / 100 - orderPaid);
        const paidLabel = lang === "ru" ? "Оплачено" : lang === "uzc" ? "Тўланган" : "To'langan";
        const dueLabel2 = lang === "ru" ? "Осталось оплатить" : lang === "uzc" ? "Қолган тўлов" : "Qolgan to'lov";

        // Build sections, each separated by an empty line
        const sections: string[] = [];
        if (rawStatus) sections.push(`${statusLabel}: ${rawStatus}`);
        if (deliveryTypeText) sections.push(`${deliveryLabel}: ${deliveryTypeText}`);
        const addressLines: string[] = [];
        if (addressText) addressLines.push(`${addressLabel}: ${addressText}`);
        if (driverInfo?.model) addressLines.push(`${driverModelLabel}: ${driverInfo.model}`);
        if (driverInfo?.number) addressLines.push(`${driverNumLabel}: ${driverInfo.number}`);
        if (extraLine) addressLines.push(extraLine);
        if (addressLines.length) sections.push(addressLines.join("\n"));
        if (orderPaid > 0) sections.push(`💳 ${paidLabel}: ${formatMoneyWithCurrency(orderPaid, currencyCode, lang)}`);
        if (orderDue > 0) sections.push(`⚠️ ${dueLabel2}: ${formatMoneyWithCurrency(orderDue, currencyCode, lang)}`);

        const detailsText = sections.length ? `\n\n${sections.join("\n\n")}` : "";
        const msg =
          lang === "ru"
            ? `🔄 Ваш заказ ${order.name} обновлён.${detailsText}`
            : lang === "uzc"
              ? `🔄 Буюртмангиз ${order.name} янгиланди.${detailsText}`
              : `🔄 Buyurtmangiz ${order.name} yangilandi.${detailsText}`;
        const orderLocationPin = extractLocationFromAttributes(order.attributes);
        if (orderLocationPin) {
          const mapUrl = `https://yandex.ru/maps/?ll=${orderLocationPin.lng},${orderLocationPin.lat}&z=16&pt=${orderLocationPin.lng},${orderLocationPin.lat}`;
          const mapLabel = lang === "ru" ? "🗺 Открыть на карте" : lang === "uzc" ? "🗺 Картада очиш" : "🗺 Kartada ochish";
          await sendTelegramMessageWithKeyboard(user.telegramId, msg, [[{ text: mapLabel, url: mapUrl }]]);
        } else {
          await sendTelegramMessage(user.telegramId, msg);
        }

        await notifyAdminsByType("orderUpdate", (adminLang) => {
          const adminRawStatus = order.state?.name?.trim() || "";
          const header = adminLang === "ru" ? `🔄 Заказ ${order.name} обновлён` : adminLang === "uzc" ? `🔄 Буюртма ${order.name} янгиланди` : `🔄 Buyurtma ${order.name} yangilandi`;
          const aStatusLabel = adminLang === "ru" ? "Статус" : adminLang === "uzc" ? "Ҳолат" : "Holat";
          const clientLabel = adminLang === "ru" ? "Клиент" : adminLang === "uzc" ? "Мижоз" : "Mijoz";
          const phoneLabel = adminLang === "ru" || adminLang === "uzc" ? "Телефон" : "Telefon";
          const totalLabel = adminLang === "ru" ? "Сумма" : adminLang === "uzc" ? "Жами" : "Jami";
          const clientName = order.agent?.name || `${user.firstName || ""} ${user.lastName || ""}`.trim();
          const adminTotal = formatMoneyWithCurrency(effectiveTotal ?? 0, currencyCode, adminLang);
          return `${header}\n${aStatusLabel}: ${adminRawStatus}\n${clientLabel}: ${clientName}\n${phoneLabel}: ${user.phoneNumber || ""}\n${totalLabel}: ${adminTotal}`;
        });
      }

    }

    return { ok: true };
  });

  // GET /api/liked?telegramId=
  server.get("/api/liked", async (request, reply) => {
    const { telegramId } = request.query as { telegramId?: string };
    if (!telegramId) { reply.code(400); return { error: "telegramId required" }; }
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return { productIds: [] };
    const liked = await prisma.likedProduct.findMany({ where: { userId: user.id } });
    return { productIds: liked.map((l) => l.productId) };
  });

  // POST /api/liked  body: { telegramId, productId }
  server.post("/api/liked", async (request, reply) => {
    const { telegramId, productId } = request.body as { telegramId?: string; productId?: string };
    if (!telegramId || !productId) { reply.code(400); return { error: "telegramId and productId required" }; }
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) { reply.code(404); return { error: "User not found" }; }
    const existing = await prisma.likedProduct.findUnique({
      where: { userId_productId: { userId: user.id, productId } }
    });
    if (existing) {
      await prisma.likedProduct.delete({ where: { id: existing.id } });
      return { liked: false };
    } else {
      await prisma.likedProduct.create({ data: { userId: user.id, productId } });
      return { liked: true };
    }
  });

  // GET /api/orders?telegramId=
  server.get("/api/orders", async (request, reply) => {
    const { telegramId } = request.query as { telegramId?: string };
    if (!telegramId) { reply.code(400); return { error: "telegramId required" }; }
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user || !user.moskladCounterpartyId) return { rows: [], total: 0 };
    try {
      const result = await listCustomerOrders(user.moskladCounterpartyId, 0, 50);
      return result;
    } catch {
      return { rows: [], total: 0 };
    }
  });

  // GET /api/orders/:orderId/positions
  server.get("/api/orders/:orderId/positions", async (request, reply) => {
    const { orderId } = request.params as { orderId: string };
    try {
      const [order, positions] = await Promise.all([
        getCustomerOrder(orderId),
        listCustomerOrderPositions(orderId)
      ]);
      const deliveryMethod = extractDeliveryMethod(order);
      const driverInfo = extractDriverInfo((order.attributes || []) as Array<{ name: string; value: string | number | boolean | null }>);
      const addressText = extractAttributeValue(order.attributes || [], envList("MOSKLAD_ORDER_ADDRESS_ATTR"))
        || order.shipmentAddress || null;
      const addressExtra = extractAttributeValue(order.attributes || [], envList("ORDER_ADDRESS_DETAILS"));
      const paid = (order.payedSum ?? 0) / 100;
      const due = Math.max(0, (order.sum ?? 0) / 100 - paid);
      return { order, positions, deliveryMethod, driverInfo, addressText, addressExtra, paidAmount: paid, dueAmount: due };
    } catch {
      reply.code(404);
      return { error: "Order not found" };
    }
  });

  // POST /api/demands/:demandId/pdf?telegramId=
  server.post("/api/demands/:demandId/pdf", async (request, reply) => {
    const { demandId } = request.params as { demandId: string };
    const { telegramId } = request.query as { telegramId?: string };
    if (!telegramId) { reply.code(400); return { error: "telegramId required" }; }
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) { reply.code(404); return { error: "User not found" }; }
    try {
      const [demand, positions, currencyCode] = await Promise.all([
        getDemand(demandId),
        listDemandPositions(demandId).catch(() => [] as Awaited<ReturnType<typeof listDemandPositions>>),
        getBaseCurrencyCode().catch(() => null)
      ]);
      // Verify ownership
      const demandCounterpartyId = extractIdFromHref(demand.agent?.meta?.href, "/entity/counterparty/");
      if (!demandCounterpartyId || demandCounterpartyId !== user.moskladCounterpartyId) {
        reply.code(403); return { error: "Forbidden" };
      }
      const demandSum = typeof demand.sum === "number" ? demand.sum / 100 : null;
      const balanceAfter = await getCustomerBalance(demandCounterpartyId).catch(() => null);
      const balanceBefore = balanceAfter !== null && demandSum !== null
        ? balanceAfter + demandSum
        : null;
      const { positions: pdfPositions, leftToPay } = await buildDemandPdfData(demand, positions);
      const pdfBuffer = await generateDemandPdf({
        demand: { ...demand, sum: demandSum ?? undefined },
        positions: pdfPositions,
        client: { firstName: demand.agent?.name || user.firstName, lastName: null, phoneNumber: user.phoneNumber },
        lang: user.language || "uz",
        currencyCode,
        leftToPay,
        balanceBefore,
        balanceAfter,
        deliveryAddress: demand.shipmentAddress || null
      });
      await sendTelegramDocument(user.telegramId, pdfBuffer, makePdfFilename(demand));
      return { ok: true };
    } catch (err) {
      console.error("demand PDF error:", err);
      reply.code(500); return { error: "Failed to generate PDF" };
    }
  });
}

function extractIdFromHref(href: string | undefined, marker: string) {
  if (!href) return null;
  const index = href.indexOf(marker);
  if (index === -1) return null;
  return href.slice(index + marker.length).split("?")[0].split("/")[0] || null;
}

function extractTypeFromHref(href: string | undefined): string | null {
  if (!href) return null;
  const match = href.match(/\/entity\/([^/?]+)/);
  return match ? match[1] : null;
}

function mapStatus(name: string, lang: string) {
  const normalized = name.trim().toLowerCase();
  const map: Record<string, { uz: string; uzc: string; ru: string }> = {
    "\u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D": {
      uz: "Tasdiqlandi",
      uzc: "\u0422\u0430\u0441\u0434\u0438\u049B\u043B\u0430\u043D\u0434\u0438",
      ru: "\u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D"
    },
    "\u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u043E": {
      uz: "Tasdiqlandi",
      uzc: "\u0422\u0430\u0441\u0434\u0438\u049B\u043B\u0430\u043D\u0434\u0438",
      ru: "\u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u043E"
    },
    "\u0441\u043E\u0431\u0438\u0440\u0430\u0435\u0442\u0441\u044F": {
      uz: "Yig'ilmoqda",
      uzc: "\u0419\u0438\u0493\u0438\u043B\u043C\u043E\u049B\u0434\u0430",
      ru: "\u0421\u043E\u0431\u0438\u0440\u0430\u0435\u0442\u0441\u044F"
    },
    "\u043F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u0442\u0441\u044F": {
      uz: "Tekshirilmoqda",
      uzc: "\u0422\u0435\u043A\u0448\u0438\u0440\u0438\u043B\u043C\u043E\u049B\u0434\u0430",
      ru: "\u041F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u0442\u0441\u044F"
    },
    "\u043E\u0442\u0433\u0440\u0443\u0436\u0435\u043D": {
      uz: "Yuklandi",
      uzc: "\u042E\u043A\u043B\u0430\u043D\u0434\u0438",
      ru: "\u041E\u0442\u0433\u0440\u0443\u0436\u0435\u043D"
    },
    "\u043E\u0442\u0433\u0440\u0443\u0436\u0435\u043D\u043E": {
      uz: "Yuklandi",
      uzc: "\u042E\u043A\u043B\u0430\u043D\u0434\u0438",
      ru: "\u041E\u0442\u0433\u0440\u0443\u0436\u0435\u043D\u043E"
    },
    "\u0434\u043E\u0441\u0442\u0430\u0432\u043B\u044F\u0435\u0442\u0441\u044F": {
      uz: "Yetkazilmoqda",
      uzc: "\u0419\u0435\u0442\u043A\u0430\u0437\u0438\u043B\u043C\u043E\u049B\u0434\u0430",
      ru: "\u0414\u043E\u0441\u0442\u0430\u0432\u043B\u044F\u0435\u0442\u0441\u044F"
    },
    "\u043E\u0442\u043C\u0435\u043D\u0435\u043D": {
      uz: "Bekor qilindi",
      uzc: "\u0411\u0435\u043A\u043E\u0440 \u049B\u0438\u043B\u0438\u043D\u0434\u0438",
      ru: "\u041E\u0442\u043C\u0435\u043D\u0435\u043D"
    },
    "\u043E\u0442\u043C\u0435\u043D\u0435\u043D\u043E": {
      uz: "Bekor qilindi",
      uzc: "\u0411\u0435\u043A\u043E\u0440 \u049B\u0438\u043B\u0438\u043D\u0434\u0438",
      ru: "\u041E\u0442\u043C\u0435\u043D\u0435\u043D\u043E"
    },
    "\u043D\u043E\u0432\u044B\u0439": {
      uz: "Yangi",
      uzc: "\u042F\u043D\u0433\u0438",
      ru: "\u041D\u043E\u0432\u044B\u0439"
    },
    "\u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D": {
      uz: "Bajarildi",
      uzc: "\u0411\u0430\u0436\u0430\u0440\u0438\u043B\u0434\u0438",
      ru: "\u0412\u044B\u043F\u043E\u043B\u043D\u0435\u043D"
    }
  };

  const mapped = map[normalized];
  if (mapped) {
    if (lang === "ru") return mapped.ru;
    if (lang === "uzc") return mapped.uzc;
    return mapped.uz;
  }

  if (name) return name;
  return lang === "ru"
    ? "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u043E"
    : lang === "uzc"
      ? "\u041D\u043E\u043C\u0430\u043B\u0443\u043C"
      : "Noma'lum";
}

function extractDeliveryMethod(order: { attributes?: Array<{ id?: string; value: any; meta?: { href?: string } }> }) {
  const attrId = process.env.MOSKLAD_DELIVERY_METHOD_ATTR;
  const pickupId = process.env.MOSKLAD_DELIVERY_METHOD_PICKUP || "";
  const deliveryId = process.env.MOSKLAD_DELIVERY_METHOD_DELIVERY || "";
  const attr = attrId && order.attributes
    ? order.attributes.find((item) => item.id === attrId || (item.meta?.href || "").includes(attrId))
    : null;
  const name = attr?.value?.name as string | undefined;
  const href = attr?.value?.meta?.href as string | undefined;
  if (!name && !href) return null;
  if (href) {
    if (pickupId && href.includes(pickupId.split("/").pop() || "")) return "pickup";
    if (deliveryId && href.includes(deliveryId.split("/").pop() || "")) return "delivery";
  }
  if (!name) return null;
  const lower = name.toLowerCase();
  if (lower.includes("delivery") || lower.includes("доставка") || lower.includes("етказиб") || lower.includes("yetkazib")) {
    return "delivery";
  }
  if (lower.includes("pickup") || lower.includes("самовывоз") || lower.includes("олиб")) {
    return "pickup";
  }
  return null;
}


function formatDeliveryLabel(method: "pickup" | "delivery" | null, lang: string) {
  if (!method) {
    return lang === "ru"
      ? "\u041D\u0435 \u0443\u043A\u0430\u0437\u0430\u043D\u043E"
      : lang === "uzc"
        ? "\u041A\u045E\u0440\u0441\u0430\u0442\u0438\u043B\u043C\u0430\u0433\u0430\u043D"
        : "Ko'rsatilmagan";
  }
  if (method === "pickup") {
    return lang === "ru"
      ? "\u0421\u0430\u043C\u043E\u0432\u044B\u0432\u043E\u0437"
      : lang === "uzc"
        ? "\u04E8\u0437\u0438 \u043E\u043B\u0438\u0431 \u043A\u0435\u0442\u0438\u0448"
        : "Olib ketish";
  }
  return lang === "ru"
    ? "\u0414\u043E\u0441\u0442\u0430\u0432\u043A\u0430"
    : lang === "uzc"
      ? "\u0415\u0442\u043A\u0430\u0437\u0438\u0431 \u0431\u0435\u0440\u0438\u0448"
      : "Yetkazib berish";
}

function formatMoneyWithCurrency(amount: number, currencyCode: string | null, lang: string) {
  const label = formatCurrencyLabel(currencyCode, lang);
  const rounded = Math.round(amount * 100) / 100;
  const text = rounded.toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return `${text} ${label}`;
}

function formatCurrencyLabel(currencyCode: string | null, lang: string) {
  const code = (currencyCode || "").toUpperCase();
  if (code === "USD") return "USD";
  if (code === "EUR") return "EUR";
  if (code === "RUB") return lang === "ru" ? "\u0440\u0443\u0431." : lang === "uzc" ? "\u0440\u0443\u0431." : "rubl";
  if (code === "UZS") return lang === "ru" ? "\u0441\u0443\u043C" : lang === "uzc" ? "\u0421\u045E\u043C" : "So'm";
  return code || (lang === "ru" ? "\u0432\u0430\u043B\u044E\u0442\u0430" : lang === "uzc" ? "\u0432\u0430\u043B\u044E\u0442\u0430" : "valyuta");
}

function formatPositionsTable(
  positions: Array<{ name: string; quantity: number }>,
  _lang: string
) {
  const maxNameLen = Math.min(
    40,
    positions.reduce((max, pos) => Math.max(max, pos.name.length), 0)
  );
  const rows = positions.map((pos) => {
    const trimmed =
      pos.name.length > maxNameLen
        ? pos.name.slice(0, Math.max(0, maxNameLen - 3)) + "..."
        : pos.name;
    const padded = trimmed.padEnd(maxNameLen, " ");
    return `${escapeHtml(padded)}  x${formatQuantity(pos.quantity)}`;
  });
  return `<pre>${rows.join("\n")}</pre>`;
}

function formatQuantity(quantity: number) {
  const rounded = Math.round(quantity * 100) / 100;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(2);
}

function buildOrderUpdateDetails(
  _updatedFields: Set<string>,
  order: {
    attributes?: Array<{ id?: string; name: string; value: any; meta?: { href?: string } }>;
    state?: { name?: string };
  },
  lang: string,
  statusText: string,
  _totalText: string | null
) {
  const lines: string[] = [];

  const statusLabel =
    lang === "ru"
      ? "\u0421\u0442\u0430\u0442\u0443\u0441"
      : lang === "uzc"
        ? "\u04B2\u043E\u043B\u0430\u0442"
        : "Holat";
  const rawStatus = order.state?.name?.trim();
  const showRawStatus =
    rawStatus && rawStatus.toLowerCase() !== statusText.trim().toLowerCase();
  const statusLine = showRawStatus ? `${statusText} (${rawStatus})` : statusText;
  lines.push(`${statusLabel}: ${statusLine}`);

  if (order.attributes?.length) {
    const mapped = mapCustomOrderAttributes(order.attributes, lang);
    for (const entry of mapped) {
      lines.push(`${entry.label}: ${entry.value}`);
    }
  }

  return lines;
}

function buildDemandUpdateDetails(
  updatedFields: Set<string>,
  lang: string,
  totalText: string | null,
  statusText: string
) {
  const lines: string[] = [];
  if (updatedFields.has("state")) {
    const label =
      lang === "ru"
        ? "\u041D\u043E\u0432\u044B\u0439 \u0441\u0442\u0430\u0442\u0443\u0441"
        : lang === "uzc"
          ? "\u042F\u043D\u0433\u0438 \u04B3\u043E\u043B\u0430\u0442"
          : "Yangi holat";
    lines.push(`${label}: ${statusText}`);
  }
  if (updatedFields.has("sum") && totalText) {
    const label =
      lang === "ru"
        ? "\u0421\u0443\u043C\u043C\u0430"
        : lang === "uzc"
          ? "\u0416\u0430\u043C\u0438"
          : "Jami";
    lines.push(`${label}: ${totalText}`);
  }
  return lines;
}

function extractAttributeValue(
  attributes: Array<{ id?: string; name: string; value: any; meta?: { href?: string } }>,
  ids: string[]
) {
  if (!ids.length) return null;
  const match = attributes.find((attr) =>
    ids.some((id) => attr.id === id || (attr.meta?.href || "").includes(id))
  );
  if (!match || match.value == null) return null;
  if (typeof match.value === "object" && match.value?.name) return String(match.value.name);
  return String(match.value);
}

function extractDriverInfo(attributes: Array<{ name: string; value: string | number | boolean | null }>) {
  const modelKeys = envList("MOSKLAD_DRIVER_MODEL_ATTRS");
  const numberKeys = envList("MOSKLAD_DRIVER_NUMBER_ATTRS");

  const model = extractAttributeValue(attributes, modelKeys);
  const number = extractAttributeValue(attributes, numberKeys);

  if (!model && !number) return null;
  return { model, number };
}

function mapCustomOrderAttributes(
  attributes: Array<{ id?: string; name: string; value: any; meta?: { href?: string } }>,
  lang: string
) {
  const entries: Array<{ label: string; value: string }> = [];
  const address = extractAttributeValue(attributes, envList("MOSKLAD_ORDER_ADDRESS_ATTR"));
  if (address) {
    const label =
      lang === "ru"
        ? "\u0410\u0434\u0440\u0435\u0441 \u0434\u043E\u0441\u0442\u0430\u0432\u043A\u0438"
        : lang === "uzc"
          ? "\u0415\u0442\u043A\u0430\u0437\u0438\u0431 \u0431\u0435\u0440\u0438\u0448 \u043C\u0430\u043D\u0437\u0438\u043B\u0438"
          : "Yetkazib berish manzili";
    entries.push({ label, value: address });
  }

  // Location is sent as a Telegram location pin in the update handler, not as text

  const delivery = extractAttributeValue(attributes, envList("MOSKLAD_DELIVERY_METHOD_ATTR"));
  if (delivery) {
    const lower = delivery.toLowerCase();
    const method: "pickup" | "delivery" | null =
      lower.includes("доставка") || lower.includes("yetkazib") || lower.includes("delivery") || lower.includes("етказ") ? "delivery" :
      lower.includes("самовывоз") || lower.includes("olib") || lower.includes("pickup") || lower.includes("олиб") ? "pickup" : null;
    const localizedDelivery = method ? formatDeliveryWithEmoji(method, lang) : delivery;
    const label = lang === "ru" ? "Тип доставки" : lang === "uzc" ? "Топшириш тури" : "Yetkazib berish turi";
    entries.push({ label, value: localizedDelivery });
  }

  const driverInfo = extractDriverInfo(attributes as Array<{ name: string; value: string | number | boolean | null }>);
  if (driverInfo?.model) {
    const label = lang === "ru" ? "\u041C\u043E\u0434\u0435\u043B\u044C \u043C\u0430\u0448\u0438\u043D\u044B" : lang === "uzc" ? "\u041C\u0430\u0448\u0438\u043D\u0430 \u043C\u043E\u0434\u0435\u043B\u0438" : "Mashina modeli";
    entries.push({ label, value: driverInfo.model });
  }
  if (driverInfo?.number) {
    const label = lang === "ru" ? "\u041D\u043E\u043C\u0435\u0440 \u043C\u0430\u0448\u0438\u043D\u044B" : lang === "uzc" ? "\u041C\u0430\u0448\u0438\u043D\u0430 \u0440\u0430\u049B\u0430\u043C\u0438" : "Mashina raqami";
    entries.push({ label, value: driverInfo.number });
  }

  return entries;
}

function envList(name: string) {
  return (process.env[name] || "").split(",").map((value) => value.trim()).filter(Boolean);
}

function formatAddressExtraLine(extra: string, lang: string): string {
  const parts = extra.split(";").map((s) => s.trim()).filter(Boolean);
  const lines: string[] = [];
  for (const part of parts) {
    const kv = part.match(/^kv\.\s*(.+)$/i);
    if (kv) {
      const label = lang === "ru" ? "Квартира" : lang === "uzc" ? "Квартира" : "Kvartira";
      lines.push(`${label}: ${kv[1].trim()}`); continue;
    }
    const ki = part.match(/^kirish\s+(.+)$/i);
    if (ki) {
      const label = lang === "ru" ? "Подъезд" : lang === "uzc" ? "Кириш" : "Kirish";
      lines.push(`${label}: ${ki[1].trim()}`); continue;
    }
    const qa = part.match(/^qavat\s+(.+)$/i);
    if (qa) {
      const label = lang === "ru" ? "Этаж" : lang === "uzc" ? "Қават" : "Qavat";
      lines.push(`${label}: ${qa[1].trim()}`); continue;
    }
    const dm = part.match(/^domofon\s+(.+)$/i);
    if (dm) {
      const label = lang === "ru" ? "Домофон" : lang === "uzc" ? "Домофон рақами" : "Domofon raqami";
      lines.push(`${label}: ${dm[1].trim()}`); continue;
    }
    lines.push(part);
  }
  return lines.join("\n");
}

function buildOrderAddressLines(
  order: { shipmentAddress?: string; attributes?: Array<{ id?: string; name: string; value: any; meta?: { href?: string } }> },
  lang: string
): string {
  const addressText = extractAttributeValue(order.attributes || [], envList("MOSKLAD_ORDER_ADDRESS_ATTR"))
    || order.shipmentAddress || null;
  const addressExtra = extractAttributeValue(order.attributes || [], envList("ORDER_ADDRESS_DETAILS"));
  const lines: string[] = [];
  if (addressText) {
    const label = lang === "ru" ? "Адрес" : lang === "uzc" ? "Манзил" : "Manzil";
    lines.push(`${label}: ${addressText}`);
  }
  if (addressExtra) {
    const formatted = formatAddressExtraLine(addressExtra, lang);
    if (formatted) lines.push(formatted);
  }
  return lines.join("\n");
}


function formatDeliveryWithEmoji(method: "pickup" | "delivery" | null, lang: string) {
  if (!method) {
    return lang === "ru" ? "Не указано" : lang === "uzc" ? "Кўрсатилмаган" : "Ko'rsatilmagan";
  }
  if (method === "pickup") {
    return lang === "ru" ? "🏪 Самовывоз" : lang === "uzc" ? "🏪 Ўзи олиб кетиш" : "🏪 Olib ketish";
  }
  return lang === "ru" ? "🚚 Доставка" : lang === "uzc" ? "🚚 Йетказиб бериш" : "🚚 Yetkazib berish";
}

function extractLocationFromAttributes(
  attributes?: Array<{ id?: string; name: string; value: any; meta?: { href?: string } }>
): { lat: number; lng: number } | null {
  if (!attributes?.length) return null;
  const ids = envList("MOSKLAD_ORDER_LOCATION_ATTR");
  if (!ids.length) return null;
  const match = attributes.find((a) =>
    ids.some((id) => a.id === id || (a.meta?.href || "").includes(id))
  );
  if (!match || typeof match.value !== "string") return null;
  return parseLatLngFromText(match.value);
}

async function sendTelegramMessage(chatId: string, text: string, parseMode?: "HTML", removeKeyboard?: boolean) {
  const token = process.env.BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(removeKeyboard ? { reply_markup: { remove_keyboard: true } } : {})
    })
  });
}

async function sendTelegramMessageWithKeyboard(
  chatId: string,
  text: string,
  inlineKeyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>,
  parseMode?: "HTML"
) {
  const token = process.env.BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      reply_markup: { inline_keyboard: inlineKeyboard }
    })
  });
}

async function sendTelegramDocument(chatId: string, buffer: Buffer, filename: string) {
  const token = process.env.BOT_TOKEN;
  if (!token) return;
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("document", new Blob([new Uint8Array(buffer)], { type: "application/pdf" }), filename);
  await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    body: formData
  });
}

async function sendTelegramLocation(chatId: string, latitude: number, longitude: number) {
  const token = process.env.BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendLocation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, latitude, longitude })
  });
}

async function sendDeliveryAddressRequest(chatId: string, lang: string, savedAddress: string | null) {
  const token = process.env.BOT_TOKEN;
  if (!token) return;

  const locationBtnLabel =
    lang === "ru"
      ? "\u{1F4CD} Отправить локацию"
      : lang === "uzc"
        ? "\u{1F4CD} Локацияни юбориш"
        : "\u{1F4CD} Lokatsiyani yuborish";

  const keyboard: any[][] = [];
  const textWithSaved =
    lang === "ru"
      ? "Используйте сохранённый адрес или отправьте новый адрес/локацию:"
      : lang === "uzc"
        ? "Сақланган манзилдан фойдаланинг ёки янги манзил/локация юборинг:"
        : "Saqlangan manzildan foydalaning yoki yangi manzil/lokatsiya yuboring:";
  const textWithoutSaved =
    lang === "ru"
      ? "Напишите адрес или отправьте локацию."
      : lang === "uzc"
        ? "Манзилни ёзинг ёки локацияни юборинг."
        : "Manzilni yozing yoki lokatsiyani yuboring.";

  if (savedAddress && !parseLatLngFromText(savedAddress)) {
    const displayAddr = formatAddressForDisplay(savedAddress);
    keyboard.push([{ text: locationBtnLabel, request_location: true }]);
    keyboard.push([displayAddr]);
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: textWithSaved,
        reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: true }
      })
    });
    return;
  }

  keyboard.push([{ text: locationBtnLabel, request_location: true }]);
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: textWithoutSaved,
      reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: true }
    })
  });
}





function formatAddressForDisplay(addr: string): string {
  const parsed = parseLatLngFromText(addr);
  if (parsed) {
    return `GPS (${parsed.lat.toFixed(4)}, ${parsed.lng.toFixed(4)})`;
  }
  return addr.length > 30 ? addr.slice(0, 27) + "..." : addr;
}

function parseLatLngFromText(text: string): { lat: number; lng: number } | null {
  const trimmed = text.trim();
  const direct = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (direct) {
    const lat = parseFloat(direct[1]);
    const lng = parseFloat(direct[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) return { lat, lng };
  }

  const atMatch = trimmed.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (atMatch) {
    const lat = parseFloat(atMatch[1]);
    const lng = parseFloat(atMatch[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) return { lat, lng };
  }

  const qMatch = trimmed.match(/[?&]q=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (qMatch) {
    const lat = parseFloat(qMatch[1]);
    const lng = parseFloat(qMatch[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) return { lat, lng };
  }

  // Yandex Maps: ll=lng,lat (longitude first)
  const llMatch = trimmed.match(/[?&]ll=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (llMatch) {
    const lng = parseFloat(llMatch[1]);
    const lat = parseFloat(llMatch[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) return { lat, lng };
  }

  // Yandex Maps: pt=lng,lat (longitude first)
  const ptMatch = trimmed.match(/[?&]pt=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (ptMatch) {
    const lng = parseFloat(ptMatch[1]);
    const lat = parseFloat(ptMatch[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) return { lat, lng };
  }

  return null;
}


async function notifyAdminsByType(
  type: "newUser" | "newOrder" | "orderUpdate" | "payment",
  msgBuilder: (lang: string) => string
) {
  const adminIds = (process.env.ADMIN_TELEGRAM_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  for (const adminId of adminIds) {
    const user = await prisma.user.findUnique({ where: { telegramId: adminId } });
    if (!user) continue;

    const settings = await prisma.adminSettings.findUnique({ where: { userId: user.id } });
    if (!settings) continue;

    const shouldNotify: Record<string, boolean> = {
      newUser: settings.notifyNewUser,
      newOrder: settings.notifyNewOrder,
      // Merge orderStatus and orderUpdate into one check
      orderUpdate: settings.notifyOrderUpdate || settings.notifyOrderStatus,
      payment: settings.notifyPayment
    };

    if (shouldNotify[type]) {
      await sendTelegramMessage(adminId, msgBuilder(user.language || "uz"));
    }
  }
}


function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
