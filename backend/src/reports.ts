import type { Telegraf } from "telegraf";
import { prisma } from "./db.js";
import { fetchOrdersInRange, fetchTopProductsInRange, getBaseCurrencyCode } from "./mosklad.js";

// UTC offset for local time (Uzbekistan = UTC+5)
const TZ_OFFSET = parseInt(process.env.REPORT_TIMEZONE_OFFSET || "5", 10);
// Hour in local time when reports are sent (default 20 = 20:00)
const REPORT_HOUR_LOCAL = parseInt(process.env.REPORT_HOUR || "20", 10);
const POLL_MS = 60_000;

const TEST_MODE = process.env.TEST_MODE === "true";
const TEST_TELEGRAM_ID = (process.env.TEST_TELEGRAM_ID || "").trim();
const TEST_POLL_MS = 2 * 60_000; // 2 minutes

let reportInterval: NodeJS.Timeout | null = null;
let isProcessing = false;
let lastDailyDate = "";
let lastWeeklyDate = "";

function pad(n: number) {
  return String(n).padStart(2, "0");
}

// Get the current local hour (UTC + offset)
function getLocalHour(utcDate: Date) {
  return new Date(utcDate.getTime() + TZ_OFFSET * 3_600_000).getUTCHours();
}

// Get the local date string "YYYY-MM-DD"
function getLocalDateStr(utcDate: Date) {
  const d = new Date(utcDate.getTime() + TZ_OFFSET * 3_600_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// 0=Sunday, 1=Monday, ..., 6=Saturday (in local time)
function getLocalDayOfWeek(utcDate: Date) {
  return new Date(utcDate.getTime() + TZ_OFFSET * 3_600_000).getUTCDay();
}

// Convert local date string to UTC Date range for Prisma queries
function getDayRangeUtc(localDateStr: string): { start: Date; end: Date } {
  const start = new Date(new Date(`${localDateStr}T00:00:00Z`).getTime() - TZ_OFFSET * 3_600_000);
  const end = new Date(new Date(`${localDateStr}T23:59:59.999Z`).getTime() - TZ_OFFSET * 3_600_000);
  return { start, end };
}

// Monday of the week containing the given local date string
function getWeekStartStr(localDateStr: string): string {
  const d = new Date(`${localDateStr}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun
  const daysBack = dow === 0 ? 6 : dow - 1;
  const start = new Date(d.getTime() - daysBack * 86_400_000);
  return `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}`;
}

function localToDisplay(localDateStr: string) {
  const [y, m, d] = localDateStr.split("-");
  return `${d}.${m}.${y}`;
}

function formatMoney(amount: number, currency: string | null, lang: string) {
  const code = (currency || "").toUpperCase();
  let label: string;
  if (code === "UZS") label = lang === "ru" ? "сум" : lang === "uzc" ? "Сўм" : "So'm";
  else if (code === "USD") label = "USD";
  else if (code === "RUB") label = lang === "ru" ? "руб." : "rubl";
  else label = code || "UZS";
  return `${amount.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${label}`;
}

async function fetchReportData(startLocalStr: string, endLocalStr: string) {
  const { start: startUtc } = getDayRangeUtc(startLocalStr);
  const { end: endUtc } = getDayRangeUtc(endLocalStr);

  const [rows, topProducts, newUsers, currency] = await Promise.all([
    fetchOrdersInRange(`${startLocalStr} 00:00:00`, `${endLocalStr} 23:59:59`).catch(() => []),
    fetchTopProductsInRange(`${startLocalStr} 00:00:00`, `${endLocalStr} 23:59:59`, 5).catch(() => []),
    prisma.user.count({
      where: { moskladCounterpartyId: { not: null }, createdAt: { gte: startUtc, lte: endUtc } }
    }).catch(() => 0),
    getBaseCurrencyCode().catch(() => null)
  ]);

  const totalOrders = rows.length;
  const totalRevenue = rows.reduce((sum, r) => sum + (r.sum ?? 0), 0) / 100;

  return { totalOrders, totalRevenue, currency, topProducts, newUsers };
}

function buildReportMessage(
  lang: string,
  periodLabel: string,
  data: Awaited<ReturnType<typeof fetchReportData>>
) {
  const { totalOrders, totalRevenue, currency, topProducts, newUsers } = data;
  const lines: string[] = [];

  if (lang === "ru") {
    lines.push(`📊 Отчёт: ${periodLabel}`);
    lines.push(`\n🛒 Заказы: ${totalOrders} шт.`);
    lines.push(`💰 Выручка: ${formatMoney(totalRevenue, currency, lang)}`);
    lines.push(`👤 Новых клиентов: ${newUsers}`);
    if (topProducts.length) {
      lines.push("\n🏆 Топ товаров:");
      for (const p of topProducts) {
        lines.push(`  • ${p.assortment?.name || "—"}: ${p.sellQuantity ?? 0} шт.`);
      }
    }
  } else if (lang === "uzc") {
    lines.push(`📊 Ҳисобот: ${periodLabel}`);
    lines.push(`\n🛒 Буюртмалар: ${totalOrders} та`);
    lines.push(`💰 Тушум: ${formatMoney(totalRevenue, currency, lang)}`);
    lines.push(`👤 Янги мижозлар: ${newUsers}`);
    if (topProducts.length) {
      lines.push("\n🏆 Энг кўп сотилганлар:");
      for (const p of topProducts) {
        lines.push(`  • ${p.assortment?.name || "—"}: ${p.sellQuantity ?? 0} та`);
      }
    }
  } else {
    lines.push(`📊 Hisobot: ${periodLabel}`);
    lines.push(`\n🛒 Buyurtmalar: ${totalOrders} ta`);
    lines.push(`💰 Tushum: ${formatMoney(totalRevenue, currency, lang)}`);
    lines.push(`👤 Yangi mijozlar: ${newUsers}`);
    if (topProducts.length) {
      lines.push("\n🏆 Ko'p sotilganlar:");
      for (const p of topProducts) {
        lines.push(`  • ${p.assortment?.name || "—"}: ${p.sellQuantity ?? 0} ta`);
      }
    }
  }

  return lines.join("\n");
}

async function sendReportToAdmins(bot: Telegraf, periodLabel: (lang: string) => string, data: Awaited<ReturnType<typeof fetchReportData>>) {
  const adminIds = (process.env.ADMIN_TELEGRAM_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const adminId of adminIds) {
    try {
      const user = await prisma.user.findUnique({ where: { telegramId: adminId } });
      const lang = user?.language || "uz";
      const msg = buildReportMessage(lang, periodLabel(lang), data);
      await bot.telegram.sendMessage(adminId, msg);
    } catch (err) {
      console.error(`Error sending report to admin ${adminId}:`, err);
    }
  }
}

async function sendDailyReport(bot: Telegraf, todayStr: string) {
  const data = await fetchReportData(todayStr, todayStr);
  const display = localToDisplay(todayStr);
  await sendReportToAdmins(bot, (lang) =>
    lang === "ru" ? `Сегодня, ${display}` : lang === "uzc" ? `Бугун, ${display}` : `Bugun, ${display}`
  , data);
}

async function sendWeeklyReport(bot: Telegraf, sundayStr: string) {
  const weekStartStr = getWeekStartStr(sundayStr);
  const data = await fetchReportData(weekStartStr, sundayStr);
  const startDisplay = localToDisplay(weekStartStr);
  const endDisplay = localToDisplay(sundayStr);
  await sendReportToAdmins(bot, (lang) =>
    lang === "ru"
      ? `Неделя: ${startDisplay} — ${endDisplay}`
      : lang === "uzc"
        ? `Ҳафта: ${startDisplay} — ${endDisplay}`
        : `Hafta: ${startDisplay} — ${endDisplay}`
  , data);
}

export function startReportScheduler(bot: Telegraf) {
  if (reportInterval) clearInterval(reportInterval);

  if (TEST_MODE) {
    console.log(`[reports] TEST MODE enabled — sending reports to ${TEST_TELEGRAM_ID} every 2 minutes`);
    let lastTestSentAt = 0;

    reportInterval = setInterval(async () => {
      if (isProcessing) return;
      const now = Date.now();
      if (now - lastTestSentAt < TEST_POLL_MS) return;

      isProcessing = true;
      lastTestSentAt = now;
      try {
        const nowDate = new Date();
        const todayStr = getLocalDateStr(nowDate);
        const weekStartStr = getWeekStartStr(todayStr);

        const user = await prisma.user.findUnique({ where: { telegramId: TEST_TELEGRAM_ID } }).catch(() => null);
        const lang = user?.language || "uz";

        const dailyData = await fetchReportData(todayStr, todayStr);
        const dailyDisplay = localToDisplay(todayStr);
        const dailyLabel =
          lang === "ru" ? `[TEST] Сегодня, ${dailyDisplay}` :
          lang === "uzc" ? `[TEST] Бугун, ${dailyDisplay}` :
          `[TEST] Bugun, ${dailyDisplay}`;
        await bot.telegram.sendMessage(TEST_TELEGRAM_ID, buildReportMessage(lang, dailyLabel, dailyData));

        const weeklyData = await fetchReportData(weekStartStr, todayStr);
        const weeklyLabel =
          lang === "ru" ? `[TEST] Неделя: ${localToDisplay(weekStartStr)} — ${dailyDisplay}` :
          lang === "uzc" ? `[TEST] Ҳафта: ${localToDisplay(weekStartStr)} — ${dailyDisplay}` :
          `[TEST] Hafta: ${localToDisplay(weekStartStr)} — ${dailyDisplay}`;
        await bot.telegram.sendMessage(TEST_TELEGRAM_ID, buildReportMessage(lang, weeklyLabel, weeklyData));

        console.log(`[reports] Test reports sent to ${TEST_TELEGRAM_ID}`);
      } catch (err) {
        console.error("[reports] Test mode error:", err);
      } finally {
        isProcessing = false;
      }
    }, TEST_POLL_MS);
    return;
  }

  reportInterval = setInterval(async () => {
    if (isProcessing) return;

    const now = new Date();
    if (getLocalHour(now) !== REPORT_HOUR_LOCAL) return;

    const todayStr = getLocalDateStr(now);
    const isSunday = getLocalDayOfWeek(now) === 0;

    if (lastDailyDate === todayStr && (!isSunday || lastWeeklyDate === todayStr)) return;

    isProcessing = true;
    try {
      if (lastDailyDate !== todayStr) {
        console.log(`[reports] Sending daily report for ${todayStr}`);
        await sendDailyReport(bot, todayStr);
        lastDailyDate = todayStr;
        console.log(`[reports] Daily report sent for ${todayStr}`);
      }
      if (isSunday && lastWeeklyDate !== todayStr) {
        console.log(`[reports] Sending weekly report for ${todayStr}`);
        await sendWeeklyReport(bot, todayStr);
        lastWeeklyDate = todayStr;
        console.log(`[reports] Weekly report sent for ${todayStr}`);
      }
    } catch (err) {
      console.error("[reports] Error in report scheduler:", err);
    } finally {
      isProcessing = false;
    }
  }, POLL_MS);
}

export function stopReportScheduler() {
  if (reportInterval) {
    clearInterval(reportInterval);
    reportInterval = null;
  }
  isProcessing = false;
}
