# Telegram Shop — MoySklad Integration

A Telegram Mini App + bot for product browsing and order management, backed by MoySklad ERP for real-time inventory, pricing, and order sync. Three-language support (Uzbek Latin, Uzbek Cyrillic, Russian), PDF invoice generation, GPS-based delivery, and per-admin configurable notifications.


## Features

**Mini App**
- Product catalog with categories, search, and images
- Shopping cart with persistent draft orders
- Delivery or pickup — with GPS / Yandex Maps address picker
- Order history and payment status
- Saved/favorite products
- Customer balance pulled live from MoySklad

**Telegram Bot**
- Phone-based registration → auto-creates a MoySklad counterparty
- Order placement and tracking via bot commands
- PDF invoice generation for any order
- Automated reminders (configurable: 1, 2, 3, 6 days after order)
- Per-admin notification toggles (new users, orders, payments, status updates)

---

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 18 + TypeScript + Vite |
| Backend | Node.js + Fastify + Telegraf |
| Database | PostgreSQL + Prisma ORM |
| ERP | MoySklad API |
| PDF | pdfmake (server-side) |
| Maps | Yandex Maps API |
| Deployment | Docker Compose |

---

## Structure

```
├── backend/          Node.js API + Telegram bot
├── webapp/           Telegram Mini App (React/Vite)
└── docker-compose.yml
```

The backend runs both the REST API and the Telegram bot in the same process. MoySklad is the source of truth for products, pricing, and orders — the local database only stores user state, cart data, and reminder schedules.

---

## Running locally

**Backend**
```bash
cd backend
npm install
cp .env.example .env   # fill in values
npm run dev
```

**Webapp**
```bash
cd webapp
npm install
cp .env.example .env
npm run dev
```

Backend: `http://localhost:4000` | Webapp: `http://localhost:5173`

---

## Deployment

Full VPS setup with Docker Compose, Nginx, SSL, and backup instructions: [DEPLOYMENT.md](DEPLOYMENT.md)

---

## Environment

Copy `.env.example` to `.env`. Notable variables:

| Variable | What it is |
|----------|-----------|
| `BOT_TOKEN` | Telegram bot token from @BotFather |
| `WEBAPP_URL` | Public URL of the Mini App |
| `MOSKLAD_TOKEN` | MoySklad API token — base64 of `login:password` |
| `ADMIN_TELEGRAM_IDS` | Comma-separated admin Telegram IDs |
| `VITE_YANDEX_MAPS_API_KEY` | Yandex Maps key for address picker |
| `MOSKLAD_*_ATTR` | UUIDs of custom MoySklad attributes (see `.env.example`) |

MoySklad custom attribute UUIDs can be found by calling the relevant metadata endpoints — see comments in `.env.example` for the exact paths.
