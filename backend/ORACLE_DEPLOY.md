# Oracle Cloud Deployment Guide (Free Forever, 24GB RAM)

Oracle Cloud gives you a **free forever** ARM VM with up to **24GB RAM** — perfect for running puppeteer-based scraping 24/7.

## Why Oracle Cloud?

| Feature | Oracle Free | Render Free | Supabase |
|---------|------------|-------------|----------|
| RAM | **24GB** | 512MB | N/A |
| Always free | ✅ | ✅ (spins down) | ✅ |
| No sleep | ✅ 24/7 | ❌ 15min idle | N/A |
| Puppeteer | ✅ Perfect | ⚠️ Tight | N/A |
| Cost | $0 forever | $0 forever | $0 forever |

## Step 1: Create Oracle Cloud Account

1. Go to https://www.oracle.com/cloud/free/
2. Click "Start for free"
3. Sign up (need credit card for verification — **never charged**)
4. Choose region closest to you

## Step 2: Create ARM VM (Always Free)

1. Oracle Dashboard → **Compute** → **Instances** → **Create Instance**
2. Settings:
   - **Name**: `herumhai-backend`
   - **Image**: Canonical Ubuntu 22.04 (click "Change image" → Ubuntu)
   - **Shape**: Click "Change shape" → **Ampere** (ARM) → **VM.Standard.A1.Flex**
     - Set OCPUs: **4** (free tier allows up to 4)
     - Set Memory: **24 GB** (free tier allows up to 24GB)
   - **Add SSH keys**: Save the private key (you'll need it to connect)
3. Click **Create**

Wait ~2 minutes for the VM to provision.

## Step 3: Open Port 8080

1. Click on your new instance → **Subnet** link
2. Click **Security Lists** → **Default Security List**
3. **Add Ingress Rule**:
   - Source CIDR: `0.0.0.0/0`
   - IP Protocol: TCP
   - Destination Port Range: `8080`
4. Save

## Step 4: Connect & Install

SSH into your VM:
```bash
ssh -i <your-private-key> ubuntu@<your-vm-public-ip>
```

Run these commands:

```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Chromium dependencies (for puppeteer)
sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2

# Clone your repo
git clone https://github.com/YOUR_USERNAME/herumhai.git
cd herumhai/backend

# Install dependencies (puppeteer downloads Chromium)
npm install

# Set up environment
export DATABASE_URL="postgresql://neondb_owner:npg_v9WOKkMjB8mq@ep-snowy-darkness-azratfrv-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require"
export TMDB_API_KEY="your_tmdb_key"
export PORT=8080

# Run database schema
node -e "import('pg').then(async pg => { const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }); const fs = await import('fs'); await pool.query(fs.readFileSync('schema.sql', 'utf-8')); console.log('Schema created'); await pool.end(); })"

# Test the scraper
node scraper.js --test "Inception" "tt1375666"

# Start the server
npm start
```

## Step 5: Keep It Running 24/7

Use PM2 (process manager):

```bash
sudo npm install -g pm2
cd ~/herumhai/backend
pm2 start server.js --name herumhai-backend
pm2 save
pm2 startup  # follow the instructions to auto-start on boot
```

## Step 6: Update Vercel

In your Vercel project settings → Environment Variables:
```
BACKEND_URL = http://<your-vm-public-ip>:8080
```

## Step 7: Verify

```bash
# Test health
curl http://<your-vm-public-ip>:8080/health

# Test stream
curl http://<your-vm-public-ip>:8080/stream/movie/tt1375666.json
```

## What This Gives You

- ✅ **24GB RAM** — runs puppeteer perfectly, no crashes
- ✅ **24/7 uptime** — never sleeps, no cron-job.org needed
- ✅ **Free forever** — Oracle's Always Free tier never expires
- ✅ **Full independence** — browser scraping works without PenguPlay/HdHub
- ✅ **Background scraping** — cron runs every 6 hours, pre-populates cache
- ✅ **Instant streams** — cached in Neon PostgreSQL, served in <100ms
