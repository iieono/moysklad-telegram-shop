import type { Telegraf } from "telegraf";
import { prisma } from "./db.js";
import { getBaseCurrencyCode, getCustomerBalance, getOrCreateCounterparty } from "./mosklad.js";

const pollIntervalMs = 60_000;
const targetWeekday = 1;
const targetHour = 10;
const targetMinute = 0;

const TEST_MODE = process.env.TEST_MODE === "true";
const TEST_TELEGRAM_ID = (process.env.TEST_TELEGRAM_ID || "").trim();
const TEST_POLL_MS = 2 * 60_000; // 2 minutes

let reminderInterval: NodeJS.Timeout | null = null;
let isProcessing = false;

function formatCurrencyLabel(code: string | null | undefined, lang: string) {
  const normalized = (code || "UZS").trim().toUpperCase();
  const map: Record<string, { uz: string; uzc: string; ru: string }> = {
    UZS: { uz: "So'm", uzc: "Сўм", ru: "сум" },
    USD: { uz: "USD", uzc: "USD", ru: "долл." },
    RUB: { uz: "RUB", uzc: "RUB", ru: "руб." },
    EUR: { uz: "EUR", uzc: "EUR", ru: "евро" }
  };
  const label = map[normalized] || { uz: normalized, uzc: normalized, ru: normalized };
  return lang === "ru" ? label.ru : lang === "uzc" ? label.uzc : label.uz;
}

function formatAmount(value: number) {
  return Math.round(value).toLocaleString("ru-RU");
}

export function startReminderWorker(bot: Telegraf) {
  // Clear any existing interval
  if (reminderInterval) {
    clearInterval(reminderInterval);
  }

  if (TEST_MODE) {
    console.log(`[reminders] TEST MODE enabled — sending debt reminder to ${TEST_TELEGRAM_ID} every 2 minutes`);
    let lastTestSentAt = 0;

    reminderInterval = setInterval(async () => {
      if (isProcessing) return;
      const now = Date.now();
      if (now - lastTestSentAt < TEST_POLL_MS) return;

      isProcessing = true;
      lastTestSentAt = now;
      try {
        const testUser = await prisma.user.findUnique({ where: { telegramId: TEST_TELEGRAM_ID } }).catch(() => null);
        const lang = testUser?.language || "uz";

        let msg: string;
        if (testUser?.phoneNumber) {
          const baseCurrency = await getBaseCurrencyCode();
          const counterpartyId = await getOrCreateCounterparty(testUser.telegramId, testUser.phoneNumber);
          const balance = await getCustomerBalance(counterpartyId);
          const amount = formatAmount(Math.abs(balance));
          const currencyLabel = formatCurrencyLabel(baseCurrency, lang);
          if (balance < 0) {
            msg = lang === "ru"
              ? `[TEST] Напоминание: у вас есть задолженность ${amount} ${currencyLabel}.`
              : lang === "uzc"
                ? `[TEST] Эслатма: сизда қарз бор ${amount} ${currencyLabel}.`
                : `[TEST] Eslatma: sizda qarz bor ${amount} ${currencyLabel}.`;
          } else {
            msg = lang === "ru"
              ? `[TEST] Напоминание: задолженности нет (баланс: ${amount} ${currencyLabel}).`
              : lang === "uzc"
                ? `[TEST] Эслатма: қарзингиз йўқ (баланс: ${amount} ${currencyLabel}).`
                : `[TEST] Eslatma: qarzingiz yo'q (balans: ${amount} ${currencyLabel}).`;
          }
        } else {
          msg = lang === "ru"
            ? `[TEST] Напоминание о долге: пользователь не найден или нет номера телефона.`
            : `[TEST] Eslatma: foydalanuvchi topilmadi yoki telefon raqami yo'q.`;
        }

        await bot.telegram.sendMessage(TEST_TELEGRAM_ID, msg);
        console.log(`[reminders] Test debt reminder sent to ${TEST_TELEGRAM_ID}`);

        // Order reminder
        const orderMsg = lang === "ru"
          ? `[TEST] Довольны заказом? Готовы заказать ещё? 🛒`
          : lang === "uzc"
            ? `[TEST] Буюртмангиздан мамнунмисиз? Яна буюртма беришга тайёрмисиз? 🛒`
            : `[TEST] Buyurtmangizdan mamnunmisiz? Yana buyurtma berishga tayyormisiz? 🛒`;
        await bot.telegram.sendMessage(TEST_TELEGRAM_ID, orderMsg);
        console.log(`[reminders] Test order reminder sent to ${TEST_TELEGRAM_ID}`);
      } catch (err) {
        console.error('[reminders] Test mode error:', err);
      } finally {
        isProcessing = false;
      }
    }, TEST_POLL_MS);
    return;
  }

  reminderInterval = setInterval(async () => {
    // Skip if already processing to prevent overlapping runs
    if (isProcessing) {
      return;
    }

    const now = new Date();
    if (
      now.getDay() !== targetWeekday ||
      now.getHours() !== targetHour ||
      now.getMinutes() !== targetMinute
    ) {
      return;
    }

    isProcessing = true;

    try {
      await processDebtReminders(bot, now);
      await processOrderReminders(bot, now);
    } catch (err) {
      console.error('Error in reminder worker:', err);
    } finally {
      isProcessing = false;
    }
  }, pollIntervalMs);
}

export function stopReminderWorker() {
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
  }
  isProcessing = false;
}

async function processDebtReminders(bot: Telegraf, now: Date) {
  const baseCurrency = await getBaseCurrencyCode();
  const BATCH_SIZE = 50;
  let cursor: string | undefined;

  while (true) {
    const users = await prisma.user.findMany({
      where: { phoneNumber: { not: null } },
      take: BATCH_SIZE,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { id: "asc" }
    });

    if (!users.length) break;
    cursor = users[users.length - 1].id;

    for (const user of users) {
      // Skip if already sent this week
      if (user.lastDebtReminderAt && isSameWeek(user.lastDebtReminderAt, now)) {
        continue;
      }

      try {
        const counterpartyId = await getOrCreateCounterparty(user.telegramId, user.phoneNumber || "");
        const balance = await getCustomerBalance(counterpartyId);

        if (balance < 0) {
          const amount = formatAmount(Math.abs(balance));
          const currencyLabel = formatCurrencyLabel(baseCurrency, user.language || "uz");
          const message =
            user.language === "ru"
              ? `Напоминание: у вас есть задолженность ${amount} ${currencyLabel}.`
              : user.language === "uzc"
                ? `Эслатма: сизда қарз бор ${amount} ${currencyLabel}.`
                : `Eslatma: sizda qarz bor ${amount} ${currencyLabel}.`;

          await bot.telegram.sendMessage(user.telegramId, message);
        }
      } catch (err) {
        console.error(`Error processing debt reminder for user ${user.id}:`, err);
      } finally {
        await prisma.user.update({
          where: { id: user.id },
          data: { lastDebtReminderAt: now }
        }).catch((err: unknown) => console.error('Error updating lastDebtReminderAt:', err));
      }
    }

    if (users.length < BATCH_SIZE) break;
  }
}

async function processOrderReminders(bot: Telegraf, now: Date) {
  try {
    // Get all due reminders
    const dueReminders = await prisma.reminder.findMany({
      where: {
        dueAt: { lte: now },
        sentAt: null
      },
      include: {
        user: true
      },
      take: 100 // Process max 100 at a time to prevent memory issues
    });

    for (const reminder of dueReminders) {
      try {
        const message =
          reminder.user.language === "ru"
            ? `Довольны заказом? Готовы заказать ещё? 🛒`
            : reminder.user.language === "uzc"
              ? `Буюртмангиздан мамнунмисиз? Яна буюртма беришга тайёрмисиз? 🛒`
              : `Buyurtmangizdan mamnunmisiz? Yana buyurtma berishga tayyormisiz? 🛒`;

        await bot.telegram.sendMessage(reminder.user.telegramId, message);

        // Mark as sent
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { sentAt: now }
        });
      } catch (err) {
        console.error(`Error sending reminder ${reminder.id}:`, err);
      }
    }

    // Clean up old sent reminders (older than 30 days)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    await prisma.reminder.deleteMany({
      where: {
        sentAt: { not: null, lt: thirtyDaysAgo }
      }
    });
  } catch (err) {
    console.error('Error processing order reminders:', err);
  }
}

export async function createOrderReminders(userId: string) {
  try {
    // Delete all existing reminders for this user
    await prisma.reminder.deleteMany({
      where: { userId }
    });

    // Get reminder days from env (e.g., "1,2,3,6")
    const reminderDaysStr = process.env.REMINDER_DAYS_AFTER_ORDER || "1,2,3,6";
    const reminderDays = reminderDaysStr.split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d));

    // Create new reminders
    const now = new Date();
    const reminders = reminderDays.map(days => ({
      userId,
      dueAt: new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
    }));

    await prisma.reminder.createMany({
      data: reminders
    });
  } catch (err) {
    console.error('Error creating order reminders:', err);
  }
}

function isSameWeek(date: Date, compareTo: Date) {
  const startOfWeek = new Date(compareTo);
  const day = startOfWeek.getDay();
  startOfWeek.setDate(compareTo.getDate() - day);
  startOfWeek.setHours(0, 0, 0, 0);
  return date >= startOfWeek;
}
