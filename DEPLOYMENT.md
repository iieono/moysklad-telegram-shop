# Deployment Guide

## Prerequisites
- Ubuntu/Debian VPS with root access
- Domain name (optional, for HTTPS)
- Minimum 2GB RAM, 2 vCPU

## 1. Initial VPS Setup

```bash
# Update system
apt update && apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

# Install Docker Compose
apt install docker-compose -y

# Create app directory
mkdir -p /opt/app
cd /opt/app
```

## 2. Upload Project Files

```bash
# Option A: Upload via Git
git clone https://github.com/iieono/moysklad-telegram-shop.git .

# Option B: Upload via SCP (from your local machine)
scp -r ./* root@your-vps-ip:/opt/app/
```

## 3. Configure Environment

```bash
# Create .env file
nano .env
```

Add this configuration:

```env
# Database
DB_PASSWORD=your_secure_password_here

# Telegram Bot
BOT_TOKEN=your_telegram_bot_token
WEBAPP_URL=https://your-domain.com

# MoySklad
MOSKLAD_TOKEN=your_moysklad_token
MOSKLAD_BASE_URL=https://api.moysklad.ru/api/remap/1.2

# Reminders (days after order: 1,2,3,6 etc)
REMINDER_DAYS_AFTER_ORDER=1,2,3,6

# Admin IDs (comma-separated)
ADMIN_TELEGRAM_IDS=123456789,987654321

# MoySklad Driver Attributes (use UUIDs from MoySklad)
MOSKLAD_DRIVER_MODEL_ATTRS=uuid-1,uuid-2
MOSKLAD_DRIVER_NUMBER_ATTRS=uuid-3,uuid-4

# API URL for webapp
VITE_API_URL=http://your-vps-ip:4000

# Production mode
DEV_MODE=false
NODE_ENV=production
```

## 4. Database URL Explanation

When docker-compose creates the database, use this format:

```
DATABASE_URL=postgresql://tx:${DB_PASSWORD}@postgres:5432/tx_electronics?schema=public
```

- `tx` = username (from docker-compose.yml)
- `${DB_PASSWORD}` = your password from .env
- `postgres` = service name in docker-compose (Docker internal DNS)
- `5432` = PostgreSQL port
- `tx_electronics` = database name

**Note:** Use `postgres` as hostname (not `localhost` or IP) when running inside Docker!

## 5. Build and Start

```bash
# Build images
docker-compose build

# Run database migrations
docker-compose run --rm backend npm run migrate

# Start all services
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f
```

## 6. Verify Deployment

```bash
# Check backend health
curl http://localhost:4000/health

# Check database
docker-compose exec postgres psql -U tx -d tx_electronics -c "SELECT count(*) FROM \"User\";"

# Check logs for errors
docker-compose logs backend --tail=50
```

## 7. Setup Nginx (Optional - for HTTPS)

```bash
# Install Nginx
apt install nginx certbot python3-certbot-nginx -y

# Create Nginx config
nano /etc/nginx/sites-available/app
```

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Backend API
    location /api {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # Webapp
    location / {
        proxy_pass http://localhost:80;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# Enable site
ln -s /etc/nginx/sites-available/app /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx

# Get SSL certificate
certbot --nginx -d your-domain.com
```

## 8. Automatic Restarts

Docker will auto-restart containers on crash or reboot (configured with `restart: unless-stopped`).

To manually restart:

```bash
# Restart all services
docker-compose restart

# Restart specific service
docker-compose restart backend

# Stop all
docker-compose down

# Start all
docker-compose up -d
```

## 9. Monitoring

```bash
# View logs
docker-compose logs -f backend
docker-compose logs -f postgres

# Check resource usage
docker stats

# Check container health
docker ps
```

## 10. Backup Database

```bash
# Create backup
docker-compose exec postgres pg_dump -U tx tx_electronics > backup-$(date +%Y%m%d).sql

# Restore backup
docker-compose exec -T postgres psql -U tx tx_electronics < backup-20240101.sql
```

## 11. Update Application

```bash
cd /opt/app

# Pull latest changes
git pull

# Rebuild and restart
docker-compose down
docker-compose build
docker-compose run --rm backend npm run migrate
docker-compose up -d
```

## Troubleshooting

### Container keeps restarting
```bash
docker-compose logs backend --tail=100
```

### Database connection errors
- Check DATABASE_URL format
- Verify postgres container is running: `docker ps`
- Check postgres logs: `docker-compose logs postgres`

### Out of memory
```bash
# Check memory usage
free -h
docker stats

# Increase swap if needed
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
```

### Clear all data and restart fresh
```bash
docker-compose down -v
docker-compose up -d
docker-compose run --rm backend npm run migrate
```

## Security Checklist

- [ ] Change DB_PASSWORD to a strong password
- [ ] Set DEV_MODE=false in production
- [ ] Enable firewall: `ufw allow 22,80,443/tcp && ufw enable`
- [ ] Keep BOT_TOKEN and MOSKLAD_TOKEN secure
- [ ] Setup SSL with certbot
- [ ] Regular backups
- [ ] Monitor logs for errors

## Resource Management

The app is configured to:
- Auto-restart on crash
- Limit database connections (10 max)
- Clean old reminders (>30 days)
- Use connection pooling
- Run as non-root user
- Include health checks

No manual intervention needed after deployment!
