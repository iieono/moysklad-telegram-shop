import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import rateLimit from "@fastify/rate-limit";
import { registerHealthRoute } from "./routes/health.js";
import { registerApiRoutes } from "./routes/api.js";
import { createBot } from "./bot.js";
import { startReminderWorker, stopReminderWorker } from "./reminders.js";
import { startReportScheduler, stopReportScheduler } from "./reports.js";
import { prisma } from "./db.js";

const port = Number(process.env.PORT || 4000);
const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
  },
  requestTimeout: 30000,
  connectionTimeout: 30000,
});

let bot: any = null;
let isShuttingDown = false;

// Graceful shutdown handler
async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  server.log.info(`${signal} received, starting graceful shutdown...`);

  try {
    // Stop accepting new connections
    await server.close();
    server.log.info("HTTP server closed");

    // Stop reminder worker
    stopReminderWorker();
    server.log.info("Reminder worker stopped");

    // Stop report scheduler
    stopReportScheduler();
    server.log.info("Report scheduler stopped");

    // Stop Telegram bot
    if (bot) {
      await bot.stop(signal);
      server.log.info("Telegram bot stopped");
    }

    // Close database connections
    await prisma.$disconnect();
    server.log.info("Database connections closed");

    server.log.info("Graceful shutdown completed");
    process.exit(0);
  } catch (err) {
    server.log.error({ err }, "Error during shutdown:");
    process.exit(1);
  }
}

// Handle uncaught errors
process.on("uncaughtException", (err) => {
  server.log.error({ err }, "Uncaught Exception:");
  gracefulShutdown("UNCAUGHT_EXCEPTION");
});

process.on("unhandledRejection", (reason, promise) => {
  server.log.error({ promise, reason }, "Unhandled Rejection:");
  gracefulShutdown("UNHANDLED_REJECTION");
});

// Graceful shutdown signals
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// PM2 graceful shutdown
process.on("message", (msg) => {
  if (msg === "shutdown") {
    gracefulShutdown("PM2_SHUTDOWN");
  }
});

// Register plugins
await server.register(cors, {
  origin: [
    process.env.WEBAPP_URL || "https://tx-electronics-webapp.pixelcat.app",
    "https://api.moysklad.ru",
  ],
  credentials: true,
});
await server.register(compress, { global: true, threshold: 1024 });
await server.register(rateLimit, {
  max: 100,
  timeWindow: "1 minute",
  cache: 10000,
});

// Register routes
registerHealthRoute(server);
registerApiRoutes(server);

// Start HTTP server
try {
  await server.listen({ port, host: "0.0.0.0" });
  server.log.info(`Server listening on http://0.0.0.0:${port}`);

  // Signal PM2 that app is ready
  if (process.send) {
    process.send("ready");
  }
} catch (err) {
  server.log.error({ err }, "Failed to start server:");
  process.exit(1);
}

// Start Telegram bot after HTTP server is up to avoid blocking health checks
const botToken = process.env.BOT_TOKEN;
if (botToken) {
  (async () => {
    try {
      bot = createBot(botToken);
      bot.launch().catch((err: unknown) => {
        server.log.error({ err }, "Telegram bot crashed:");
      });
      server.log.info("Telegram bot started");
      startReminderWorker(bot);
      startReportScheduler(bot);

      // Set native menu button to open the webapp
      const webappUrl = process.env.WEBAPP_URL || "http://localhost:5173";
      await bot.telegram
        .setChatMenuButton({
          menuButton: {
            type: "web_app",
            text: "Shop",
            web_app: { url: webappUrl },
          },
        })
        .catch(() => {});
    } catch (err) {
      server.log.error({ err }, "Failed to start Telegram bot:");
    }
  })();
} else {
  server.log.warn("BOT_TOKEN is not set; bot will not start");
}
