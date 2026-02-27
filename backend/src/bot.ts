import { Telegraf, Markup } from "telegraf";
import { prisma } from "./db.js";
import {
  createCustomerOrder,
  getCustomerBalance,
  getOrCreateCounterparty,
  listCustomerOrders,
  getCustomerOrder,
  listCustomerOrderPositions,
  getDemand,
  listDemandPositions,
  getBaseCurrencyCode,
  findCounterpartyByPhone,
  updateCounterpartyAttrs,
  createCounterparty,
  updateCounterpartyAddress,
  getCounterparty
} from "./mosklad.js";
import { generateDemandPdf, makePdfFilename } from "./pdf.js";
import { buildDemandPdfData } from "./demand-pdf.js";

const ORDER_PAGE_SIZE = 10;

function getAdminIds(): string[] {
  return (process.env.ADMIN_TELEGRAM_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function isAdmin(telegramId: string | number): boolean {
  return getAdminIds().includes(String(telegramId));
}

export function createBot(token: string) {
  const bot = new Telegraf(token);

  // ── Registration guard middleware ─────────────────────────────────────────
  // Registration = having a valid MoySklad counterpartyId. Phone alone is not enough.
  bot.use(async (ctx, next) => {
    const upd = ctx.update as any;

    // Always allow: /start command
    if (upd.message?.text?.startsWith("/start")) return next();

    // Always allow: lang: callback actions (language selection)
    if (upd.callback_query?.data?.startsWith("lang:")) return next();

    // Always allow: contact sharing (phone registration step)
    if (upd.message?.contact) return next();

    const telegramId = ctx.from?.id ? String(ctx.from.id) : null;
    if (!telegramId) return next();

    const user = await prisma.user.findUnique({ where: { telegramId } });

    // Fully registered — allow everything
    if (user?.moskladCounterpartyId) return next();

    // Block everything else — simple warning, no phone button
    const lang = user?.language || "uz";
    if (upd.callback_query?.id) {
      await ctx.telegram.answerCbQuery(upd.callback_query.id).catch(() => {});
    }
    const msg =
      lang === "ru"
        ? "Вы не зарегистрированы. Нажмите /start для регистрации."
        : lang === "uzc"
          ? "Сиз рўйхатдан ўтмагансиз. Рўйхатдан ўтиш учун /start ни босинг."
          : "Siz ro'yxatdan o'tmagansiz. Ro'yxatdan o'tish uchun /start ni bosing.";
    await ctx.reply(msg);
    return;
  });

  // ── Draft cancel for commands/menu while awaiting address ────────────────
  bot.use(async (ctx, next) => {
    const text = ctx.message && "text" in ctx.message ? ctx.message.text?.trim() : null;
    if (!text) return next();
    if (!ctx.from) return next();

    const user = await getUser(ctx.from.id);
    if (!user) return next();

    const draft = await getDraftOrder(user.id);
    const needsAddress =
      draft?.deliveryMethod === "delivery" && !draft.addressText && !draft.locationLat;
    if (!needsAddress) return next();

    const lang = user.language || "uz";
    if (text.startsWith("/") || isMenuText(text, lang)) {
      await clearDraft(user.id);
    }

    return next();
  });

  // ── /start ────────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    const telegramId = String(ctx.from?.id || "");
    if (!telegramId) return;

    const user = await prisma.user.findUnique({ where: { telegramId } });

    if (!user) {
      const languageKeyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback("O'zbek", "lang:uz"),
          Markup.button.callback("Ўзбек", "lang:uzc"),
          Markup.button.callback("Русский", "lang:ru")
        ]
      ]);
      await ctx.reply("Tilni tanlang / Выберите язык", languageKeyboard);
      return;
    }

    const lang = user.language || "uz";

    if (!user.phoneNumber) {
      await sendRegistrationPrompt(ctx, lang);
      return;
    }

    await ctx.reply(t(lang, "alreadyRegistered"), mainMenu(lang, telegramId));
    const draft = await getDraftOrder(user.id);
    if (draft?.items?.length) {
      await ctx.reply(t(lang, "draftReady"));
    }
  });

  // ── Commands ───────────────────────────────────────────────────────────────
  bot.command("help", async (ctx) => {
    const lang = await getLanguage(ctx.from?.id);
    await ctx.reply(t(lang, "help"));
  });

  bot.command("balance", async (ctx) => {
    await handleBalance(ctx);
  });

  bot.command("orders", async (ctx) => {
    await handleOrders(ctx, 0);
  });

  // ── hears: Balance ─────────────────────────────────────────────────────────
  bot.hears(["💰 Balans", "💰 Баланс"], async (ctx) => {
    await handleBalance(ctx);
  });

  // ── hears: Orders ─────────────────────────────────────────────────────────
  bot.hears(["📦 Buyurtmalar", "📦 Буюртмалар", "📦 Заказы"], async (ctx) => {
    await handleOrders(ctx, 0);
  });

  // ── hears: Language ────────────────────────────────────────────────────────
  bot.hears(["🌐 Til", "🌐 Тил", "🌐 Язык"], async (ctx) => {
    const languageKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback("O'zbek", "lang:uz"),
        Markup.button.callback("Ўзбек", "lang:uzc"),
        Markup.button.callback("Русский", "lang:ru")
      ]
    ]);
    await ctx.reply("Tilni tanlang / Выберите язык", languageKeyboard);
  });

  // ── hears: Admin settings ──────────────────────────────────────────────────
  bot.hears(["⚙️ Sozlamalar", "⚙️ Созламалар", "⚙️ Настройки"], async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await showAdminPanel(ctx, bot);
  });

  // ── action: Language selection ─────────────────────────────────────────────
  bot.action(/lang:(uzc|uz|ru)/, async (ctx) => {
    const lang = ctx.match[1] as string;
    if (!ctx.from) return;
    const telegramId = String(ctx.from.id);
    const user = await prisma.user.upsert({
      where: { telegramId },
      update: { language: lang },
      create: { telegramId, phoneNumber: null, language: lang }
    });
    await ctx.answerCbQuery();
    // Already fully registered — show language changed message + menu
    if (user.phoneNumber && user.moskladCounterpartyId && user.pendingState !== "registrationAddress") {
      await ctx.reply(t(lang, "languageChanged"), mainMenu(lang, telegramId));
      return;
    }

    // Not registered — ask for phone
    await sendRegistrationPrompt(ctx, lang);
  });

  // ── action: Delivery method ────────────────────────────────────────────────
  bot.action(/delivery:(pickup|delivery)/, async (ctx) => {
    if (!ctx.from) return;
    const lang = await getLanguage(ctx.from.id);
    const user = await getUser(ctx.from.id);
    if (!user?.phoneNumber) {
      await sendRegistrationPrompt(ctx, lang);
      return;
    }

    const deliveryMethod = ctx.match[1] as "pickup" | "delivery";
    const draft = await getDraftOrder(user.id);
    if (!draft) {
      await ctx.reply(t(lang, "cartEmpty"));
      return;
    }

    await prisma.draftOrder.update({
      where: { userId: user.id },
      data: { deliveryMethod, addressText: null, locationLat: null, locationLng: null }
    });

    await ctx.answerCbQuery();

    if (deliveryMethod === "pickup") {
      await sendOrderConfirmation(ctx, user.id, lang);
      return;
    }

    await askForAddressOrLocation(ctx, lang, user);
  });

  // —— action: Use saved address (inline button) ——
  bot.action("addr:useSaved", async (ctx) => {
    if (!ctx.from) return;
    const lang = await getLanguage(ctx.from.id);
    const user = await getUser(ctx.from.id);
    if (!user?.defaultAddress) {
      await ctx.answerCbQuery();
      return;
    }

    const draft = await getDraftOrder(user.id);
    if (!draft || draft.deliveryMethod !== "delivery") {
      await ctx.answerCbQuery();
      return;
    }

    if (draft.addressText || draft.locationLat) {
      await ctx.answerCbQuery();
      return;
    }

    const locationData: { locationLat?: number; locationLng?: number } = {};
    if (user.moskladCounterpartyId) {
      const counterpartyLocation = await getCounterpartyLocation(user.moskladCounterpartyId);
      if (counterpartyLocation) {
        locationData.locationLat = counterpartyLocation.lat;
        locationData.locationLng = counterpartyLocation.lng;
      }
    }
    await prisma.draftOrder.update({
      where: { userId: user.id },
      data: { addressText: user.defaultAddress, ...locationData }
    });

    await ctx.answerCbQuery();
    await sendOrderConfirmation(ctx, user.id, lang);
  });

  // ── action: Order confirm/cancel ───────────────────────────────────────────
  bot.action(/order:(confirm|cancel)/, async (ctx) => {
    if (!ctx.from) return;
    const lang = await getLanguage(ctx.from.id);
    const user = await getUser(ctx.from.id);
    if (!user?.phoneNumber) {
      await sendRegistrationPrompt(ctx, lang);
      return;
    }

    const action = ctx.match[1];
    try {
      await ctx.editMessageReplyMarkup(undefined as any);
    } catch {}

    if (action === "cancel") {
      await clearDraft(user.id);
      await ctx.answerCbQuery();
      await ctx.reply(t(lang, "orderCancelled"), mainMenu(lang, user.telegramId));
      return;
    }

    const draft = await getDraftOrder(user.id);
    if (!draft || !draft.items.length) {
      await ctx.reply(t(lang, "cartEmpty"));
      return;
    }

    if (!draft.deliveryMethod) {
      await ctx.reply(t(lang, "chooseDelivery"), deliveryKeyboard(lang));
      return;
    }

    if (draft.deliveryMethod === "delivery" && !draft.addressText && !draft.locationLat) {
      await askForAddressOrLocation(ctx, lang, user);
      return;
    }

    let counterpartyId: string;
    try {
      counterpartyId = await getOrCreateCounterparty(
        user.telegramId,
        user.phoneNumber!,
        user.firstName || undefined,
        user.username || undefined
      );
    } catch (err: any) {
      if (err.message === "COUNTERPARTY_DELETED") {
        await ctx.answerCbQuery();
        await handleCounterpartyDeleted(ctx, lang);
        return;
      }
      throw err;
    }
    const order = await createCustomerOrder(
      counterpartyId,
      draft.items.map((item) => ({ id: item.productId, quantity: item.quantity, price: item.price / 100 })),
      {
        deliveryMethod: draft.deliveryMethod as "pickup" | "delivery",
        orderNote: draft.orderNote || null,
        addressText: draft.addressText,
        locationLat: draft.locationLat,
        locationLng: draft.locationLng
      }
    );

    await clearDraft(user.id);
    await ctx.answerCbQuery();
    await ctx.reply(t(lang, "orderCreated"), mainMenu(lang, user.telegramId));
  });

  // ── action: Order detail ───────────────────────────────────────────────────
  bot.action(/order:detail:(.+)/, async (ctx) => {
    if (!ctx.from) return;
    const orderId = ctx.match[1];
    const lang = await getLanguage(ctx.from.id);
    await ctx.answerCbQuery();

    try {
      const [order, positions, currencyCode] = await Promise.all([
        getCustomerOrder(orderId),
        listCustomerOrderPositions(orderId).catch(() => []),
        getBaseCurrencyCode().catch(() => null)
      ]);
      const demands = (order.demands ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        moment: d.moment,
        sum: d.sum / 100,
        state: d.state?.name || null,
      }));
      const labels = getOrderDetailLabels(lang);
      const date = order.moment ? formatDate(order.moment) : "";
      const sum = order.sum ? formatMoneyWithCurrency(order.sum / 100, currencyCode, lang) : "";
      const status = order.state?.name ? mapOrderStatus(order.state.name, lang) : "";
      const deliveryMethod = extractDeliveryMethod(order);
      const deliveryLabel = deliveryMethod ? formatDeliveryLabel(deliveryMethod, lang) : "";
      const noteValue = extractOrderNote(order);
      const paid = (order.payedSum ?? 0) / 100;
      const due = Math.max(0, (order.sum ?? 0) / 100 - paid);
      const lines = [
        `📋 ${order.name}`,
        date ? `📅 ${labels.date}: ${date}` : "",
        sum ? `💰 ${labels.total}: ${sum}` : "",
        paid > 0 ? `💳 ${labels.paid}: ${formatMoneyWithCurrency(paid, currencyCode, lang)}` : "",
        due > 0 ? `⚠️ ${labels.due}: ${formatMoneyWithCurrency(due, currencyCode, lang)}` : "",
        status ? `📊 ${labels.status}: ${status}` : "",
        deliveryLabel ? `🚚 ${deliveryLabel}` : "",
        order.shipmentAddress ? `📍 ${labels.address}: ${order.shipmentAddress}` : "",
        noteValue ? `📝 ${labels.note}: ${noteValue}` : ""
      ].filter(Boolean);

      const sections: string[] = [lines.map(escapeHtml).join("\n")];

      if (positions.length) {
        sections.push(formatOrderItemsTable(positions, labels.items));
      }

      if (order.attributes?.length) {
        const fieldLines = order.attributes
          .map((attr) => {
            const value = formatAttributeValue(attr.value);
            if (!value) return null;
            const label = mapCustomFieldLabel(attr.name, lang);
            if (!label) return null;
            return `• ${label}: ${value}`;
          })
          .filter(Boolean) as string[];
        if (fieldLines.length) {
          sections.push(fieldLines.map(escapeHtml).join("\n"));
        }
      }

      const orderLocation = extractOrderLocation(order);
      const actionButtons: any[] = [];

      if (orderLocation) {
        const locLabel = lang === "ru" ? "🗺 Открыть на карте" : lang === "uzc" ? "🗺 Картада очиш" : "🗺 Kartada ochish";
        const mapUrl = `https://yandex.ru/maps/?ll=${orderLocation.lng},${orderLocation.lat}&z=16&pt=${orderLocation.lng},${orderLocation.lat}`;
        actionButtons.push(Markup.button.url(locLabel, mapUrl));
      }
      if (demands.length > 0) {
        const demLabel = lang === "ru" ? "📄 Документы" : lang === "uzc" ? "📄 Ҳужжатлар" : "📄 Hujjatlar";
        actionButtons.push(Markup.button.callback(demLabel, `order:demands:${orderId}`));
      }

      const replyOpts: any = { parse_mode: "HTML" };
      if (actionButtons.length > 0) {
        replyOpts.reply_markup = Markup.inlineKeyboard([actionButtons]).reply_markup;
      }
      await ctx.reply(sections.join("\n\n"), replyOpts);
    } catch {
      await ctx.reply(t(lang, "noOrders"));
    }
  });


  // ── action: Order demands list ────────────────────────────────────────────
  bot.action(/order:demands:(.+)/, async (ctx) => {
    if (!ctx.from) return;
    const orderId = ctx.match[1];
    const lang = await getLanguage(ctx.from.id);
    await ctx.answerCbQuery();
    try {
      const [order, currencyCode] = await Promise.all([
        getCustomerOrder(orderId),
        getBaseCurrencyCode().catch(() => null)
      ]);
      const demands = (order.demands ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        moment: d.moment,
        sum: d.sum / 100,
        state: d.state?.name || null,
      }));
      if (!demands.length) {
        await ctx.reply(lang === "ru" ? "Документов нет." : lang === "uzc" ? "Ҳужжатлар йўқ." : "Hujjatlar yo'q.");
        return;
      }
      const title = lang === "ru" ? "📄 Документы:" : lang === "uzc" ? "📄 Ҳужжатлар:" : "📄 Hujjatlar:";
      const lines = demands.map((d) => {
        const dDate = d.moment ? formatDate(d.moment) : "";
        const dSum  = d.sum ? formatMoneyWithCurrency(d.sum, currencyCode, lang) : "";
        const dSt   = d.state ? mapOrderStatus(d.state, lang) : "";
        const info  = [dSum ? `💰 ${dSum}` : "", dDate ? `📅 ${dDate}` : "", dSt ? `📊 ${dSt}` : ""].filter(Boolean).join(" • ");
        return info ? `• ${d.name} — ${info}` : `• ${d.name}`;
      });
      const pdfButtons = demands.map((d) => [
        Markup.button.callback(`📄 PDF — ${d.name}`, `demand:pdf:${d.id}`)
      ]);
      await ctx.reply(`${title}\n${lines.join("\n")}`, Markup.inlineKeyboard(pdfButtons));
    } catch {
      await ctx.reply(t(lang, "noOrders"));
    }
  });

  // ── action: Demand PDF ────────────────────────────────────────────────────
  bot.action(/demand:pdf:(.+)/, async (ctx) => {
    if (!ctx.from) return;
    const demandId = ctx.match[1];
    const lang = await getLanguage(ctx.from.id);
    await ctx.answerCbQuery(lang === "ru" ? "Формируется PDF…" : lang === "uzc" ? "PDF тайёрланмоқда…" : "PDF tayyorlanmoqda…");
    try {
      const user = await getUser(ctx.from.id);
      const [demand, positions, currencyCode] = await Promise.all([
        getDemand(demandId),
        listDemandPositions(demandId).catch(() => [] as Awaited<ReturnType<typeof listDemandPositions>>),
        getBaseCurrencyCode().catch(() => null)
      ]);
      const demandSum = typeof demand.sum === "number" ? demand.sum / 100 : null;
      const balanceAfter = user?.moskladCounterpartyId
        ? await getCustomerBalance(user.moskladCounterpartyId).catch(() => null)
        : null;
      const balanceBefore = balanceAfter !== null && demandSum !== null
        ? balanceAfter + demandSum
        : null;
      const { positions: pdfPositions, leftToPay } = await buildDemandPdfData(demand, positions);
      const pdfBuffer = await generateDemandPdf({
        demand: { ...demand, sum: demandSum ?? undefined },
        positions: pdfPositions,
        client: {
          firstName: demand.agent?.name || user?.firstName,
          lastName: null,
          phoneNumber: user?.phoneNumber
        },
        lang,
        currencyCode,
        leftToPay,
        balanceBefore,
        balanceAfter,
        deliveryAddress: demand.shipmentAddress || null
      });
      await ctx.replyWithDocument({ source: pdfBuffer, filename: makePdfFilename(demand) });
    } catch (err) {
      console.error("demand:pdf error:", err);
      await ctx.reply(lang === "ru" ? "⚠️ Не удалось создать PDF." : lang === "uzc" ? "⚠️ PDF тайёрлаб бўлмади." : "⚠️ PDF tayyorlab bo'lmadi.");
    }
  });

  // ── action: Orders pagination ──────────────────────────────────────────────
  bot.action(/orders:page:(\d+)/, async (ctx) => {
    if (!ctx.from) return;
    const offset = parseInt(ctx.match[1]) || 0;
    await ctx.answerCbQuery();
    await handleOrders(ctx, offset, true);
  });

  // ── action: Admin toggle (updates display only — no DB save yet) ──────────
  bot.action(/admin:toggle:(newUser|newOrder|orderUpdate|payment):([a-z0-9]+)/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery();
      return;
    }
    await ctx.answerCbQuery();
    const field = ctx.match[1] as keyof AdminPanelStates;
    const states = decodeAdminStates(ctx.match[2]);
    states[field] = !states[field];
    await showAdminPanel(ctx, bot, true, states);
  });

  // ── action: Admin save (persists staged settings to DB) ───────────────────
  bot.action(/admin:save:([a-z0-9]+)/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery();
      return;
    }
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from.id);
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return;
    const states = decodeAdminStates(ctx.match[1]);
    await prisma.adminSettings.upsert({
      where: { userId: user.id },
      update: {
        notifyNewUser: states.newUser,
        notifyNewOrder: states.newOrder,
        notifyOrderStatus: states.orderUpdate,
        notifyOrderUpdate: states.orderUpdate,
        notifyPayment: states.payment
      },
      create: {
        userId: user.id,
        notifyNewUser: states.newUser,
        notifyNewOrder: states.newOrder,
        notifyOrderStatus: states.orderUpdate,
        notifyOrderUpdate: states.orderUpdate,
        notifyPayment: states.payment
      }
    });
    const lang = user.language || "uz";
    await ctx.reply(getAdminPanelLabels(lang).saved);
  });

  // ── action: Admin back (no changes) ───────────────────────────────────────
  bot.action("admin:back", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery();
      return;
    }
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from.id);
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return;
    const lang = user.language || "uz";
    await ctx.reply(t(lang, "menuHint"), mainMenu(lang, telegramId));
  });

  // ── on: Contact shared ─────────────────────────────────────────────────────
  bot.on("contact", async (ctx) => {
    const contact = ctx.message.contact;
    if (!ctx.from || contact.user_id !== ctx.from.id) {
      const lang = await getLanguage(ctx.from?.id);
      await ctx.reply(t(lang, "contactSelfOnly"));
      return;
    }

    const telegramId = String(ctx.from.id);
    const phoneNumber = contact.phone_number;

    await prisma.user.upsert({
      where: { telegramId },
      update: {
        phoneNumber,
        username: ctx.from.username || null,
        firstName: ctx.from.first_name || null,
        lastName: ctx.from.last_name || null
      },
      create: {
        telegramId,
        phoneNumber,
        username: ctx.from.username || null,
        firstName: ctx.from.first_name || null,
        lastName: ctx.from.last_name || null
      }
    });

    const lang = await getLanguage(ctx.from.id);

    // Check MoySklad for existing counterparty by phone
    const existingId = await findCounterpartyByPhone(phoneNumber).catch(() => null);
    if (existingId) {
      // Unlink from any other Telegram account that previously held this counterparty
      await prisma.user.updateMany({
        where: { moskladCounterpartyId: existingId, NOT: { telegramId } },
        data: { moskladCounterpartyId: null }
      });
      await prisma.user.update({
        where: { telegramId },
        data: { moskladCounterpartyId: existingId, pendingState: null }
      });
      await updateCounterpartyAttrs(existingId, telegramId, ctx.from.username || undefined).catch(() => {});
      await notifyAdminsByType(bot, "newUser", (adminLang) => {
        const header = adminLang === "ru" ? "👤 Новый пользователь" : adminLang === "uzc" ? "👤 Янги фойдаланувчи" : "👤 Yangi foydalanuvchi";
        const nameLabel = adminLang === "ru" ? "Имя" : adminLang === "uzc" ? "Исм" : "Ism";
        const phoneLabel = adminLang === "ru" ? "Телефон" : "Telefon";
        return `${header}\n${nameLabel}: ${ctx.from.first_name || ""} ${ctx.from.last_name || ""}\n${phoneLabel}: ${phoneNumber}`;
      });
      await ctx.reply(t(lang, "registered"));
      await ctx.reply(t(lang, "welcome"), mainMenu(lang, telegramId));
    } else {
      // Counterparty not found in MoySklad — create automatically with Telegram name
      const name = ctx.from.first_name || phoneNumber;
      try {
        const counterpartyId = await createCounterparty(
          telegramId,
          phoneNumber,
          name,
          ctx.from.username || undefined
        );
        await prisma.user.update({
          where: { telegramId },
          data: { moskladCounterpartyId: counterpartyId }
        });
      } catch (err) {
        console.error("Failed to create counterparty on registration:", err);
      }
      await notifyAdminsByType(bot, "newUser", (adminLang) => {
        const header = adminLang === "ru" ? "👤 Новый пользователь" : adminLang === "uzc" ? "👤 Янги фойдаланувчи" : "👤 Yangi foydalanuvchi";
        const nameLabel = adminLang === "ru" ? "Имя" : adminLang === "uzc" ? "Исм" : "Ism";
        const phoneLabel = adminLang === "ru" ? "Телефон" : "Telefon";
        return `${header}\n${nameLabel}: ${name}\n${phoneLabel}: ${phoneNumber}`;
      });
      await ctx.reply(t(lang, "registered"));
      await ctx.reply(t(lang, "welcome"), mainMenu(lang, telegramId));
    }
  });

  // ── on: Location shared ────────────────────────────────────────────────────
  bot.on("location", async (ctx) => {
    if (!ctx.from) return;
    const lang = await getLanguage(ctx.from.id);
    const user = await getUser(ctx.from.id);
    if (!user?.phoneNumber) {
      await sendRegistrationPrompt(ctx, lang);
      return;
    }

    const { latitude, longitude } = ctx.message.location;

    // Delivery order: save location to draft
    const draft = await getDraftOrder(user.id);
    if (!draft || draft.deliveryMethod !== "delivery") return;

    await prisma.draftOrder.update({
      where: { userId: user.id },
      data: { locationLat: latitude, locationLng: longitude }
    });

    await ctx.reply(t(lang, "locationSaved"), Markup.removeKeyboard());
    await sendOrderConfirmation(ctx, user.id, lang);
  });

  // ── on: Text message ───────────────────────────────────────────────────────
  bot.on("text", async (ctx) => {
    const textRaw = ctx.message.text?.trim() || "";
    if (textRaw.startsWith("/")) {
      return;
    }

    const lang = await getLanguage(ctx.from?.id);
    const user = await getUser(ctx.from?.id);

    if (!user?.phoneNumber) {
      await ctx.reply(t(lang, "shareContactHint"), sendRegistrationPromptInline(lang));
      return;
    }

    const text = textRaw;

    // Delivery address capture
    const draft = await getDraftOrder(user.id);
    if (draft?.deliveryMethod === "delivery" && !draft.addressText && !draft.locationLat) {
      if (isMenuText(text, lang)) {
        await clearDraft(user.id);
        return;
      }
      const savedLabel = user.defaultAddress ? formatAddress(user.defaultAddress, lang) : null;
      let addressToSave = text;
      let locationData: { locationLat?: number; locationLng?: number } = {};

      // User pressed "use saved address" button
      const usingSavedAddress = user.defaultAddress && isSavedAddressChoice(text, user.defaultAddress, lang);
      if (usingSavedAddress) {
        addressToSave = user.defaultAddress!;
        if (user.moskladCounterpartyId) {
          const counterpartyLocation = await getCounterpartyLocation(user.moskladCounterpartyId);
          if (counterpartyLocation) {
            locationData = { locationLat: counterpartyLocation.lat, locationLng: counterpartyLocation.lng };
          }
        }
      } else {
        const parsed = parseLatLng(addressToSave);
        if (parsed) {
          locationData = { locationLat: parsed.lat, locationLng: parsed.lng };
        }
      }

      await prisma.draftOrder.update({
        where: { userId: user.id },
        data: { addressText: addressToSave, ...locationData }
      });
      await sendOrderConfirmation(ctx, user.id, lang);
      return;
    }

    await ctx.reply(t(lang, "menuHint"), mainMenu(lang, user.telegramId));
  });

  bot.catch((err: unknown, ctx: any) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Bot error for update ${ctx.update?.update_id}:`, msg);
    ctx.reply("⚠️ Xatolik yuz berdi. Keyinroq urinib ko'ring.").catch(() => {});
  });

  return bot;
}

// ── Admin panel ──────────────────────────────────────────────────────────────

type AdminPanelStates = {
  newUser: boolean;
  newOrder: boolean;
  orderUpdate: boolean;
  payment: boolean;
};

function encodeAdminStates(s: AdminPanelStates): string {
  return `nu${s.newUser ? 1 : 0}no${s.newOrder ? 1 : 0}ou${s.orderUpdate ? 1 : 0}pm${s.payment ? 1 : 0}`;
}

function decodeAdminStates(code: string): AdminPanelStates {
  return {
    newUser: code.includes("nu1"),
    newOrder: code.includes("no1"),
    orderUpdate: code.includes("ou1"),
    payment: code.includes("pm1")
  };
}

function getAdminPanelLabels(lang: string) {
  if (lang === "ru") return {
    title: "⚙️ Настройки уведомлений:",
    newUser: "Новый пользователь",
    newOrder: "Новый заказ",
    orderUpdate: "Обновление заказа",
    payment: "Платёж получен",
    save: "Сохранить",
    back: "Назад",
    saved: "✅ Настройки сохранены."
  };
  if (lang === "uzc") return {
    title: "⚙️ Билдиришнома созламалари:",
    newUser: "Янги фойдаланувчи",
    newOrder: "Янги буюртма",
    orderUpdate: "Буюртма янгиланди",
    payment: "Тўлов қабул қилинди",
    save: "Сақлаш",
    back: "Орқага",
    saved: "✅ Созламалар сақланди."
  };
  return {
    title: "⚙️ Bildirishnoma sozlamalari:",
    newUser: "Yangi foydalanuvchi",
    newOrder: "Yangi buyurtma",
    orderUpdate: "Buyurtma yangilandi",
    payment: "To'lov qabul qilindi",
    save: "Saqlash",
    back: "Orqaga",
    saved: "✅ Sozlamalar saqlandi."
  };
}

async function showAdminPanel(ctx: any, _bot: Telegraf, edit = false, pendingStates?: AdminPanelStates) {
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) return;

  const lang = user.language || "uz";
  const settings = await prisma.adminSettings.findUnique({ where: { userId: user.id } });
  const baseStates: AdminPanelStates = {
    newUser: settings?.notifyNewUser ?? false,
    newOrder: settings?.notifyNewOrder ?? false,
    orderUpdate: (settings?.notifyOrderUpdate || settings?.notifyOrderStatus) ?? false,
    payment: settings?.notifyPayment ?? false
  };
  let states: AdminPanelStates;

  if (pendingStates) {
    states = pendingStates;
  } else {
    states = baseStates;
  }

  const hasChanges =
    states.newUser !== baseStates.newUser ||
    states.newOrder !== baseStates.newOrder ||
    states.orderUpdate !== baseStates.orderUpdate ||
    states.payment !== baseStates.payment;

  const stateCode = encodeAdminStates(states);
  const flag = (v: boolean) => (v ? "✅" : "❌");
  const labels = getAdminPanelLabels(lang);

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(`👤 ${labels.newUser}: ${flag(states.newUser)}`, `admin:toggle:newUser:${stateCode}`)],
    [Markup.button.callback(`🛒 ${labels.newOrder}: ${flag(states.newOrder)}`, `admin:toggle:newOrder:${stateCode}`)],
    [Markup.button.callback(`🔄 ${labels.orderUpdate}: ${flag(states.orderUpdate)}`, `admin:toggle:orderUpdate:${stateCode}`)],
    [Markup.button.callback(`💰 ${labels.payment}: ${flag(states.payment)}`, `admin:toggle:payment:${stateCode}`)],
    [hasChanges
      ? Markup.button.callback(`💾 ${labels.save}`, `admin:save:${stateCode}`)
      : Markup.button.callback(`⬅️ ${labels.back}`, "admin:back")
    ]
  ]);

  if (edit) {
    try {
      await ctx.editMessageText(labels.title, keyboard);
    } catch {
      await ctx.reply(labels.title, keyboard);
    }
  } else {
    await ctx.reply(labels.title, keyboard);
  }
}

// ── handleCounterpartyDeleted ─────────────────────────────────────────────────

async function handleCounterpartyDeleted(ctx: any, lang: string) {
  const telegramId = ctx.from?.id ? String(ctx.from.id) : null;
  if (telegramId) {
    // Full reset — user must re-register from scratch
    await prisma.user.updateMany({
      where: { telegramId },
      data: { moskladCounterpartyId: null, phoneNumber: null, defaultAddress: null, pendingState: null }
    });
  }
  await ctx.reply(t(lang, "counterpartyDeleted"), Markup.removeKeyboard());
}

// ── handleBalance ────────────────────────────────────────────────────────────

async function handleBalance(ctx: any) {
  const lang = await getLanguage(ctx.from?.id);
  const user = await getUser(ctx.from?.id);
  if (!user?.phoneNumber) {
    await sendRegistrationPrompt(ctx, lang);
    return;
  }

  try {
    const counterpartyId = await getOrCreateCounterparty(
      user.telegramId,
      user.phoneNumber,
      user.firstName || undefined,
      user.username || undefined
    );
    const [balance, currencyCode] = await Promise.all([
      getCustomerBalance(counterpartyId),
      getBaseCurrencyCode().catch(() => null)
    ]);
    const balanceText = formatMoneyWithCurrency(balance, currencyCode, lang);
    await ctx.reply(t(lang, "balance", balanceText));
  } catch (err: any) {
    if (err.message === "COUNTERPARTY_DELETED") {
      await handleCounterpartyDeleted(ctx, lang);
    } else throw err;
  }
}

// ── handleOrders ─────────────────────────────────────────────────────────────

async function handleOrders(ctx: any, offset: number, edit = false) {
  const lang = await getLanguage(ctx.from?.id);
  const user = await getUser(ctx.from?.id);
  if (!user?.phoneNumber) {
    await sendRegistrationPrompt(ctx, lang);
    return;
  }

  let counterpartyId: string;
  try {
    counterpartyId = await getOrCreateCounterparty(
      user.telegramId,
      user.phoneNumber,
      user.firstName || undefined,
      user.username || undefined
    );
  } catch (err: any) {
    if (err.message === "COUNTERPARTY_DELETED") {
      await handleCounterpartyDeleted(ctx, lang);
      return;
    }
    throw err;
  }

  const [ordersData, currencyCode] = await Promise.all([
    listCustomerOrders(counterpartyId, offset, ORDER_PAGE_SIZE),
    getBaseCurrencyCode().catch(() => null)
  ]);
  const { rows: orders, total } = ordersData;

  const sendMsg = async (text: string, extra?: any) => {
    if (edit) {
      try {
        await ctx.editMessageText(text, extra);
        return;
      } catch { /* fallback to reply if edit fails */ }
    }
    await ctx.reply(text, extra);
  };

  if (orders.length === 0) {
    await sendMsg(t(lang, "noOrders"));
    return;
  }

  const title = lang === "ru" ? "📦 Ваши заказы:" : lang === "uzc" ? "📦 Буюртмаларингиз:" : "📦 Buyurtmalaringiz:";

  const orderLines = orders.map((order, i) => {
    const date = formatDate(order.moment);
    const status = order.state ? mapOrderStatus(order.state, lang) : "";
    const parts = [
      `${offset + i + 1}. ${order.name}`,
      `💰 ${formatMoneyWithCurrency(order.sum, currencyCode, lang)}`,
      `📅 ${date}`,
      status ? `📊 ${status}` : ""
    ].filter(Boolean);
    return parts.join(" • ");
  });

  const orderButtons = orders.map((order, i) => {
    const label = `${offset + i + 1}. ${order.name}`;
    return [Markup.button.callback(label, `order:detail:${order.id}`)];
  });

  const navRow: ReturnType<typeof Markup.button.callback>[] = [];
  if (offset > 0) {
    const prevLabel = lang === "ru" ? "← Назад" : lang === "uzc" ? "← Орқага" : "← Oldingi";
    navRow.push(Markup.button.callback(prevLabel, `orders:page:${offset - ORDER_PAGE_SIZE}`));
  }
  if (offset + ORDER_PAGE_SIZE < total) {
    const nextLabel = lang === "ru" ? "Вперёд →" : lang === "uzc" ? "Кейинги →" : "Keyingi →";
    navRow.push(Markup.button.callback(nextLabel, `orders:page:${offset + ORDER_PAGE_SIZE}`));
  }

  if (navRow.length > 0) orderButtons.push(navRow);

  await sendMsg(`${title}\n${orderLines.join("\n")}`, Markup.inlineKeyboard(orderButtons));

}

// ── sendOrderConfirmation ─────────────────────────────────────────────────────

async function sendOrderConfirmation(ctx: any, userId: string, lang: string) {
  const draft = await getDraftOrder(userId);
  if (!draft || !draft.items.length) {
    await ctx.reply(t(lang, "cartEmpty"));
    return;
  }

  const currencyCode = await getBaseCurrencyCode().catch(() => null);
  const summary = formatDraftSummary(lang, draft, currencyCode);
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(lang === "ru" ? "✅ Подтвердить" : lang === "uzc" ? "✅ Тасдиқлаш" : "✅ Tasdiqlash", "order:confirm")],
    [Markup.button.callback(lang === "ru" ? "❌ Отменить" : lang === "uzc" ? "❌ Бекор қилиш" : "❌ Bekor qilish", "order:cancel")]
  ]);
  await ctx.reply(summary, keyboard);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getUser(telegramId?: number) {
  if (!telegramId) return null;
  return prisma.user.findUnique({ where: { telegramId: String(telegramId) } });
}

async function getLanguage(telegramId?: number) {
  const user = await getUser(telegramId);
  return user?.language || "uz";
}

async function getDraftOrder(userId: string) {
  return prisma.draftOrder.findUnique({
    where: { userId },
    include: { items: true }
  });
}

async function clearDraft(userId: string) {
  try {
    await prisma.draftOrder.delete({ where: { userId } });
  } catch {
    return;
  }
}

function sendRegistrationPrompt(ctx: any, lang: string) {
  const label =
    lang === "ru"
      ? "📱 Отправить номер"
      : lang === "uzc"
        ? "📱 Рақам юбориш"
        : "📱 Telefon raqamini yuborish";
  const keyboard = Markup.keyboard([Markup.button.contactRequest(label)]).oneTime().resize();
  return ctx.reply(t(lang, "registerPrompt"), keyboard);
}

function sendRegistrationPromptInline(lang: string) {
  const label =
    lang === "ru"
      ? "\u{1F4F1} \u041e\u0442\u043f\u0440\u0430\u0432\u0438\u0442\u044c \u043d\u043e\u043c\u0435\u0440"
      : lang === "uzc"
        ? "\u{1F4F1} \u0420\u0430\u049b\u0430\u043c \u044e\u0431\u043e\u0440\u0438\u0448"
        : "\u{1F4F1} Telefon raqamini yuborish";
  return Markup.keyboard([Markup.button.contactRequest(label)]).oneTime().resize();
}

async function askForDefaultAddress(ctx: any, lang: string) {
  const locationLabel =
    lang === "ru"
      ? "\u{1F4CD} \u041e\u0442\u043f\u0440\u0430\u0432\u0438\u0442\u044c \u043b\u043e\u043a\u0430\u0446\u0438\u044e"
      : lang === "uzc"
        ? "\u{1F4CD} \u041b\u043e\u043a\u0430\u0446\u0438\u044f\u043d\u0438 \u044e\u0431\u043e\u0440\u0438\u0448"
        : "\u{1F4CD} Lokatsiyani yuborish";
  const skipLabel = t(lang, "skipAddress");
  await ctx.reply(
    t(lang, "askDefaultAddress"),
    Markup.keyboard([[Markup.button.locationRequest(locationLabel)], [skipLabel]]).resize().oneTime()
  );
}

async function askForAddressOrLocation(ctx: any, lang: string, user: any) {
  const locationLabel =
    lang === "ru"
      ? "\u{1F4CD} \u041e\u0442\u043f\u0440\u0430\u0432\u0438\u0442\u044c \u043b\u043e\u043a\u0430\u0446\u0438\u044e"
      : lang === "uzc"
        ? "\u{1F4CD} \u041b\u043e\u043a\u0430\u0446\u0438\u044f\u043d\u0438 \u044e\u0431\u043e\u0440\u0438\u0448"
        : "\u{1F4CD} Lokatsiyani yuborish";
  const keyboardRows: any[] = [[Markup.button.locationRequest(locationLabel)]];
  let msg = t(lang, "sendAddress");

    if (user?.defaultAddress && !parseLatLng(user.defaultAddress)) {
      const savedLabel = formatAddress(user.defaultAddress, lang);
      msg = t(lang, "sendAddressWithSaved");
      keyboardRows.push([savedLabel]);
      await ctx.reply(msg, Markup.keyboard(keyboardRows).resize().oneTime());
      return;
    }

  await ctx.reply(msg, Markup.keyboard(keyboardRows).resize().oneTime());
}
function mainMenu(lang: string, telegramId: string | number | undefined) {
  const webappUrl = process.env.WEBAPP_URL || "http://localhost:5173";
  const webappWithLang = telegramId ? `${webappUrl}?tgId=${telegramId}` : webappUrl;

  let shopLabel: string, ordersLabel: string, balanceLabel: string, langLabel: string;

  if (lang === "ru") {
    shopLabel = "🛍 Открыть магазин";
    ordersLabel = "📦 Заказы";
    balanceLabel = "💰 Баланс";
    langLabel = "🌐 Язык";
  } else if (lang === "uzc") {
    shopLabel = "🛍 Дўконни очиш";
    ordersLabel = "📦 Буюртмалар";
    balanceLabel = "💰 Баланс";
    langLabel = "🌐 Тил";
  } else {
    shopLabel = "🛍 Do'konni ochish";
    ordersLabel = "📦 Buyurtmalar";
    balanceLabel = "💰 Balans";
    langLabel = "🌐 Til";
  }

  const rows: any[] = [
    [Markup.button.webApp(shopLabel, webappWithLang)],
    [ordersLabel, balanceLabel],
    [langLabel]
  ];

  if (telegramId && isAdmin(telegramId)) {
    const adminLabel =
      lang === "ru" ? "⚙️ Настройки" : lang === "uzc" ? "⚙️ Созламалар" : "⚙️ Sozlamalar";
    rows[2].push(adminLabel);
  }

  return Markup.keyboard(rows).resize();
}

function isSavedAddressChoice(text: string, address: string, lang: string) {
  const cleaned = text.trim();
  const display = formatAddress(address, lang);
  return cleaned === display;
}

function isMenuText(text: string, lang: string) {
  const cleaned = text.trim();
  const base = [
    "📦 Buyurtmalar",
    "📦 Буюртмалар",
    "📦 Заказы",
    "💰 Balans",
    "💰 Баланс",
    "🌐 Til",
    "🌐 Тил",
    "🌐 Язык",
    "⚙️ Sozlamalar",
    "⚙️ Созламалар",
    "⚙️ Настройки"
  ];
  if (lang === "uz") base.push("🛍 Do'konni ochish");
  if (lang === "uzc") base.push("🛍 Дўконни очиш");
  if (lang === "ru") base.push("🛍 Открыть магазин");
  return base.includes(cleaned);
}

function deliveryKeyboard(lang: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(t(lang, "pickup"), "delivery:pickup"),
      Markup.button.callback(t(lang, "delivery"), "delivery:delivery")
    ]
  ]);
}

function parseLatLng(addr: string): { lat: number; lng: number } | null {
  const text = addr.trim();
  const direct = text.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (direct) {
    const lat = parseFloat(direct[1]);
    const lng = parseFloat(direct[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) return { lat, lng };
  }

  const atMatch = text.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (atMatch) {
    const lat = parseFloat(atMatch[1]);
    const lng = parseFloat(atMatch[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) return { lat, lng };
  }

  const qMatch = text.match(/[?&]q=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (qMatch) {
    const lat = parseFloat(qMatch[1]);
    const lng = parseFloat(qMatch[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) return { lat, lng };
  }

  // Yandex Maps: ll=lng,lat (longitude first)
  const llMatch = text.match(/[?&]ll=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (llMatch) {
    const lng = parseFloat(llMatch[1]);
    const lat = parseFloat(llMatch[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) return { lat, lng };
  }

  // Yandex Maps: pt=lng,lat (longitude first)
  const ptMatch = text.match(/[?&]pt=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (ptMatch) {
    const lng = parseFloat(ptMatch[1]);
    const lat = parseFloat(ptMatch[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) return { lat, lng };
  }

  return null;
}

function formatAddress(addr: string, _lang?: string): string {
  const parsed = parseLatLng(addr);
  if (parsed) {
    return `GPS (${parsed.lat.toFixed(4)}, ${parsed.lng.toFixed(4)})`;
  }
  return addr.length > 30 ? addr.slice(0, 27) + "..." : addr;
}

function formatGoogleMapsLink(lat: number, lng: number) {
  return `https://yandex.ru/maps/?ll=${lng},${lat}&z=16&pt=${lng},${lat}`;
}

async function getCounterpartyLocation(counterpartyId: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const counterparty = await getCounterparty(counterpartyId);
    const attrId = process.env.MOSKLAD_COUNTERPARTY_LOCATION_ATTR;
    if (!attrId || !counterparty.attributes?.length) return null;
    const match = counterparty.attributes.find((attr) =>
      attr.id === attrId || (attr.meta?.href || "").includes(attrId)
    );
    if (!match || typeof match.value !== "string") return null;
    return parseLatLng(match.value);
  } catch {
    return null;
  }
}

function formatDraftSummary(lang: string, draft: any, currencyCode: string | null = null) {
  const lines: string[] = [t(lang, "orderSummaryTitle")];
  let total = 0;

  for (const item of draft.items) {
    const lineTotal = (item.price / 100) * item.quantity;
    total += lineTotal;
    lines.push(`• ${item.name} ×${item.quantity} — ${formatMoneyWithCurrency(lineTotal, currencyCode, lang)}`);
  }

  lines.push(`\n💰 ${lang === "ru" ? "Итого" : lang === "uzc" ? "Жами" : "Jami"}: ${formatMoneyWithCurrency(total, currencyCode, lang)}`);

  const deliveryLabel =
    draft.deliveryMethod === "pickup" ? t(lang, "pickup") : draft.deliveryMethod ? t(lang, "delivery") : "";
  if (deliveryLabel) {
    lines.push(`🚚 ${lang === "ru" ? "Доставка" : lang === "uzc" ? "Йетказиш" : "Yetkazish"}: ${deliveryLabel}`);
  }
  if (draft.addressText) {
    lines.push(`📍 ${lang === "ru" ? "Адрес" : lang === "uzc" ? "Манзил" : "Manzil"}: ${draft.addressText}`);
  }
  if (draft.locationLat && draft.locationLng) {
    lines.push(`📍 ${lang === "ru" ? "Локация" : "Lokatsiya"}: ${draft.locationLat}, ${draft.locationLng}`);
  }
  if (draft.orderNote) {
    lines.push(`📝 ${lang === "ru" ? "Комментарий" : lang === "uzc" ? "Изоҳ" : "Izoh"}: ${draft.orderNote}`);
  }

  lines.push(`\n${t(lang, "confirmOrder")}`);
  return lines.join("\n");
}

async function notifyAdminsByType(bot: Telegraf, type: "newUser" | "newOrder" | "orderUpdate" | "payment", msgBuilder: (lang: string) => string) {
  const adminIds = getAdminIds();
  for (const adminId of adminIds) {
    const user = await prisma.user.findUnique({ where: { telegramId: adminId } });
    if (!user) continue;

    const settings = await prisma.adminSettings.findUnique({ where: { userId: user.id } });
    if (!settings) continue;

    const shouldNotify: Record<string, boolean> = {
      newUser: settings.notifyNewUser,
      newOrder: settings.notifyNewOrder,
      orderUpdate: settings.notifyOrderUpdate || settings.notifyOrderStatus,
      payment: settings.notifyPayment
    };

    if (shouldNotify[type]) {
      await bot.telegram.sendMessage(adminId, msgBuilder(user.language || "uz")).catch(() => {});
    }
  }
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
  if (code === "RUB") return lang === "ru" ? "руб." : lang === "uzc" ? "руб." : "rubl";
  if (code === "UZS") return lang === "ru" ? "сум" : lang === "uzc" ? "Сўм" : "So'm";
  return code || (lang === "ru" ? "валюта" : lang === "uzc" ? "валюта" : "valyuta");
}

function formatDate(moment: string) {
  const d = new Date(moment.replace(" ", "T"));
  if (isNaN(d.getTime())) return moment;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} ${hh}:${min}:${ss}`;
}

function mapOrderStatus(name: string, lang: string) {
  const normalized = name.trim().toLowerCase();
  const map: Record<string, { uz: string; uzc: string; ru: string }> = {
    "подтвержден":   { uz: "Tasdiqlandi",      uzc: "Тасдиқланди",     ru: "Подтвержден" },
    "подтверждено":  { uz: "Tasdiqlandi",      uzc: "Тасдиқланди",     ru: "Подтвержден" },
    "собирается":    { uz: "Yig'ilmoqda",      uzc: "Йиғилмоқда",      ru: "Собирается" },
    "проверяется":   { uz: "Tekshirilmoqda",   uzc: "Текширилмоқда",   ru: "Проверяется" },
    "отгружен":      { uz: "Yuklandi",         uzc: "Юкланди",         ru: "Отгружен" },
    "отгружено":     { uz: "Yuklandi",         uzc: "Юкланди",         ru: "Отгружен" },
    "доставляется":  { uz: "Yetkazilmoqda",    uzc: "Йетказилмоқда",   ru: "Доставляется" },
    "отменен":       { uz: "Bekor qilindi",    uzc: "Бекор қилинди",   ru: "Отменен" },
    "отменено":      { uz: "Bekor qilindi",    uzc: "Бекор қилинди",   ru: "Отменен" }
  };
  if (map[normalized]) {
    if (lang === "ru") return map[normalized].ru;
    if (lang === "uzc") return map[normalized].uzc;
    return map[normalized].uz;
  }
  return name;
}

function getOrderDetailLabels(lang: string) {
  if (lang === "ru") {
    return {
      date: "Дата",
      total: "Сумма",
      status: "Статус",
      delivery: "Доставка",
      address: "Адрес",
      note: "Комментарий",
      items: "Товары",
      customFields: "Поля",
      demandTitle: "Документы",
      paid: "Оплачено",
      due: "Осталось оплатить"
    };
  }
  if (lang === "uzc") {
    return {
      date: "Сана",
      total: "Жами",
      status: "Ҳолат",
      delivery: "Етказиб бериш",
      address: "Манзил",
      note: "Изоҳ",
      items: "Маҳсулотлар",
      customFields: "Майдонлар",
      demandTitle: "Ҳужжатлар",
      paid: "Тўланган",
      due: "Қолган тўлов"
    };
  }
  return {
    date: "Sana",
    total: "Jami",
    status: "Holat",
    delivery: "Yetkazib berish",
    address: "Manzil",
    note: "Izoh",
    items: "Mahsulotlar",
    customFields: "Maydonlar",
    demandTitle: "Hujjatlar",
    paid: "To'langan",
    due: "Qolgan to'lov"
  };
}

function formatAttributeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string") return record.name;
    const meta = record.meta as { href?: string } | undefined;
    if (meta?.href) return meta.href.split("/").pop() || meta.href;
    try {
      return JSON.stringify(record);
    } catch {
      return "";
    }
  }
  return String(value);
}

function formatOrderItemsTable(
  items: Array<{ name: string; quantity: number }>,
  title: string
) {
  const maxNameLen = Math.min(
    40,
    items.reduce((max, item) => Math.max(max, item.name.length), 0)
  );
  const rows = items.map((item) => {
    const trimmed =
      item.name.length > maxNameLen
        ? item.name.slice(0, Math.max(0, maxNameLen - 3)) + "..."
        : item.name;
    const padded = trimmed.padEnd(maxNameLen, " ");
    return `${padded}  x${item.quantity}`;
  });
  const safeTitle = escapeHtml(title);
  const safeRows = rows.map(escapeHtml).join("\n");
  return `<b>${safeTitle}:</b>\n<pre>${safeRows}</pre>`;
}

function formatKeyValueList(title: string, rows: string[]) {
  const safeTitle = escapeHtml(title);
  const safeRows = rows.map(escapeHtml).join("\n");
  return `<b>${safeTitle}:</b>\n${safeRows}`;
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function mapCustomFieldLabel(name: string, lang: string) {
  const normalized = name.trim().toLowerCase();
  const modelKeys = envList("MOSKLAD_DRIVER_MODEL_ATTRS").map((value: string) => value.toLowerCase());
  const numberKeys = envList("MOSKLAD_DRIVER_NUMBER_ATTRS").map((value: string) => value.toLowerCase());

  if (modelKeys.includes(normalized)) {
    return lang === "ru"
      ? "Модель машины"
      : lang === "uzc"
        ? "Машина модели"
        : "Mashina modeli";
  }
  if (numberKeys.includes(normalized)) {
    return lang === "ru"
      ? "Номер машины"
      : lang === "uzc"
        ? "Машина рақами"
        : "Mashina raqami";
  }
  return null;
}

function envList(name: string) {
  return (process.env[name] || "").split(",").map((value) => value.trim()).filter(Boolean);
}

function extractOrderNote(order: {
  description?: string;
  attributes?: Array<{ id?: string; name: string; value: any; meta?: { href?: string } }>;
}) {
  const attrId = process.env.MOSKLAD_ORDER_NOTE_ATTR;
  if (attrId && order.attributes?.length) {
    const match = order.attributes.find((attr) =>
      attr.id === attrId || (attr.meta?.href || "").includes(attrId)
    );
    const value = match ? formatAttributeValue(match.value) : "";
    if (value) return value;
  }
  return "";
}

function extractDeliveryMethod(order: {
  description?: string;
  attributes?: Array<{ id?: string; name: string; value: any; meta?: { href?: string } }>;
}) {
  const attrId = process.env.MOSKLAD_DELIVERY_METHOD_ATTR;
  if (order.attributes?.length) {
    const match =
      order.attributes.find((attr) =>
        attrId ? attr.id === attrId || (attr.meta?.href || "").includes(attrId) : false
      ) || null;
    const fallback = match || null;
    const candidate = fallback || order.attributes.find((attr) => {
      if (!attr.value || typeof attr.value !== "object") return false;
      const value = attr.value as { name?: string };
      return typeof value.name === "string";
    });
    if (candidate && candidate.value && typeof candidate.value === "object") {
      const name = (candidate.value as { name?: string }).name?.toLowerCase() || "";
      if (name.includes("delivery") || name.includes("доставка") || name.includes("етказ")) {
        return "delivery";
      }
      if (name.includes("pickup") || name.includes("самовывоз") || name.includes("олиб")) {
        return "pickup";
      }
    }
  }

  return null;
}

function formatDeliveryLabel(method: "pickup" | "delivery", lang: string) {
  if (method === "pickup") {
    return lang === "ru"
      ? "Самовывоз"
      : lang === "uzc"
        ? "Ўзи олиб кетиш"
        : "Olib ketish";
  }
  return lang === "ru"
    ? "Доставка"
    : lang === "uzc"
      ? "Етказиб бериш"
      : "Yetkazib berish";
}

function extractOrderLocation(order: {
  shipmentAddress?: string;
  attributes?: Array<{ name: string; value: string | number | boolean | null }>;
}) {
  if (order.attributes?.length) {
    for (const attr of order.attributes) {
      if (typeof attr.value !== "string") continue;
      const parsed = parseLatLng(attr.value);
      if (parsed) return parsed;
    }
  }

  if (order.shipmentAddress) {
    const parsed = parseLatLng(order.shipmentAddress);
    if (parsed) return parsed;
  }

  return null;
}

// ── Translations ──────────────────────────────────────────────────────────────

function t(lang: string, key: string, value?: number | string) {
  const uz: Record<string, string> = {
    welcome: "Xush kelibsiz! 👋",
    alreadyRegistered: "✅ Siz allaqachon ro'yxatdan o'tgansiz!",
    help: "Buyruqlar: /start, /help, /balance, /orders",
    registerPrompt: "📱 Telefon raqamingizni yuboring:",
    askName: "✍️ Ismingizni kiriting:",
    registered: "✅ Siz ro'yxatdan o'tdingiz!",
    shareContactHint: "Iltimos, telefon raqamingizni tugma orqali yuboring.",
    menuHint: "Menyudan birini tanlang.",
    languageChanged: "✅ Til muvaffaqiyatli o'zgartirildi.",
    contactSelfOnly: "Faqat o'zingizning raqamingizni yuboring.",
    balance: `💰 Balans: ${value ?? 0}`,
    noOrders: "📭 Buyurtmalar topilmadi.",
    draftReady: "🛒 Savat saqlandi.",
    cartEmpty: "🛒 Savat bo'sh. Avval do'kondan tovar tanlang.",
    chooseDelivery: "Yetkazib berish usulini tanlang:",
    pickup: "🏪 Olib ketish",
    delivery: "🚚 Yetkazib berish",
    sendAddress: "Manzilni yozing yoki lokatsiyani yuboring.",
    sendAddressWithSaved: "Saqlangan manzildan foydalaning yoki yangi manzil/lokatsiya yuboring:",
    askDefaultAddress: "📍 Asosiy yetkazib berish manzilingizni yuboring:\n(GPS lokatsiya yuboring yoki manzil matnini yozing)",
    useSaved: "✓ Saqlangan manzilni ishlatish",
    addressSaved: "✅ Manzil saqlandi!",
    skipAddress: "⏩ O'tkazib yuborish",
    locationSaved: "✅ Lokatsiya saqlandi.",
    orderSummaryTitle: "📋 Buyurtma ma'lumotlari:",
    confirmOrder: "Buyurtmani tasdiqlaysizmi?",
    orderCreated: "✅ Buyurtma qabul qilindi.",
    orderCancelled: "❌ Buyurtma bekor qilindi.",
    counterpartyDeleted: "⚠️ Hisobingiz topilmadi. Iltimos, qayta ro'yxatdan o'ting."
  };

  const uzc: Record<string, string> = {
    welcome: "Хуш келибсиз! 👋",
    alreadyRegistered: "✅ Сиз аллақачон рўйхатдан ўтгансиз!",
    help: "Буйруқлар: /start, /help, /balance, /orders",
    registerPrompt: "📱 Телефон рақамингизни юборинг:",
    askName: "✍️ Исмингизни киритинг:",
    registered: "✅ Сиз рўйхатдан ўтдингиз!",
    shareContactHint: "Илтимос, телефон рақамингизни тугма орқали юборинг.",
    menuHint: "Менюдан бирини танланг.",
    languageChanged: "✅ Тил муваффақиятли ўзгартирилди.",
    contactSelfOnly: "Фақат ўзингизнинг рақамингизни юборинг.",
    balance: `💰 Баланс: ${value ?? 0}`,
    noOrders: "📭 Буюртмалар топилмади.",
    draftReady: "🛒 Сават сақланди.",
    cartEmpty: "🛒 Сават бўш. Аввал дўкондан товар танланг.",
    chooseDelivery: "Йетказиб бериш усулини танланг:",
    pickup: "🏪 Олиб кетиш",
    delivery: "🚚 Йетказиб бериш",
    sendAddress: "Манзилни ёзинг ёки локацияни юборинг.",
    sendAddressWithSaved: "\u0421\u0430\u049b\u043b\u0430\u043d\u0433\u0430\u043d \u043c\u0430\u043d\u0437\u0438\u043b\u0434\u0430\u043d \u0444\u043e\u0439\u0434\u0430\u043b\u0430\u043d\u0438\u043d\u0433 \u0451\u043a\u0438 \u044f\u043d\u0433\u0438 \u043c\u0430\u043d\u0437\u0438\u043b/\u043b\u043e\u043a\u0430\u0446\u0438\u044f \u044e\u0431\u043e\u0440\u0438\u043d\u0433:",
    askDefaultAddress: "📍 Асосий манзилингизни юборинг:\n(GPS локация юборинг ёки манзил матнини ёзинг)",
    useSaved: "\u2713 \u0421\u0430\u049b\u043b\u0430\u043d\u0433\u0430\u043d \u043c\u0430\u043d\u0437\u0438\u043b\u043d\u0438 \u0438\u0448\u043b\u0430\u0442\u0438\u0448",
    addressSaved: "✅ Манзил сақланди!",
    skipAddress: "⏩ Ўтказиб юбориш",
    locationSaved: "✅ Локация сақланди.",
    orderSummaryTitle: "📋 Буюртма маълумотлари:",
    confirmOrder: "Буюртмани тасдиқлайсизми?",
    orderCreated: "✅ Буюртма қабул қилинди.",
    orderCancelled: "❌ Буюртма бекор қилинди.",
    counterpartyDeleted: "⚠️ Ҳисобингиз топилмади. Илтимос, қайта рўйхатдан ўтинг."
  };

  const ru: Record<string, string> = {
    welcome: "Добро пожаловать! 👋",
    alreadyRegistered: "✅ Вы уже зарегистрированы!",
    help: "Команды: /start, /help, /balance, /orders",
    registerPrompt: "📱 Отправьте номер телефона для регистрации:",
    askName: "✍️ Введите ваше имя:",
    registered: "✅ Вы зарегистрированы!",
    shareContactHint: "Пожалуйста, отправьте номер через кнопку.",
    menuHint: "Выберите пункт меню.",
    languageChanged: "✅ Язык успешно изменён.",
    contactSelfOnly: "Отправьте только свой номер.",
    balance: `💰 Баланс: ${value ?? 0}`,
    noOrders: "📭 Заказы не найдены.",
    draftReady: "🛒 Корзина сохранена.",
    cartEmpty: "🛒 Корзина пуста. Сначала выберите товары.",
    chooseDelivery: "Выберите способ доставки:",
    pickup: "🏪 Самовывоз",
    delivery: "🚚 Доставка",
    sendAddress: "Напишите адрес или отправьте локацию.",
    sendAddressWithSaved: "\u0418\u0441\u043f\u043e\u043b\u044c\u0437\u0443\u0439\u0442\u0435 \u0441\u043e\u0445\u0440\u0430\u043d\u0451\u043d\u043d\u044b\u0439 \u0430\u0434\u0440\u0435\u0441 \u0438\u043b\u0438 \u043e\u0442\u043f\u0440\u0430\u0432\u044c\u0442\u0435 \u043d\u043e\u0432\u044b\u0439 \u0430\u0434\u0440\u0435\u0441/\u043b\u043e\u043a\u0430\u0446\u0438\u044e:",
    askDefaultAddress: "📍 Укажите ваш адрес доставки по умолчанию:\n(Отправьте GPS-локацию или напишите адрес)",
    useSaved: "\u2713 \u0418\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u044c \u0441\u043e\u0445\u0440\u0430\u043d\u0451\u043d\u043d\u044b\u0439 \u0430\u0434\u0440\u0435\u0441",
    addressSaved: "✅ Адрес сохранён!",
    skipAddress: "⏩ Пропустить",
    locationSaved: "✅ Локация сохранена.",
    orderSummaryTitle: "📋 Детали заказа:",
    confirmOrder: "Подтвердить заказ?",
    orderCreated: "✅ Заказ оформлен.",
    orderCancelled: "❌ Заказ отменен.",
    counterpartyDeleted: "⚠️ Ваш аккаунт не найден. Пожалуйста, зарегистрируйтесь заново."
  };

  if (lang === "ru") return ru[key] || key;
  if (lang === "uzc") return uzc[key] || key;
  return uz[key] || key;
}
