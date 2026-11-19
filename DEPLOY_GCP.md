# FlatForge — GCP VM Deployment Guide (No Docker)

**VM:** `34.9.137.235` · `us-central1-c`  
**Branch:** `experiment/no-tolerance-gates`

---

## 1. Open the Firewall on GCP

In GCP Console → **VPC Network → Firewall → Create Firewall Rule**:

| Field | Value |
|---|---|
| Name | `allow-http` |
| Direction | Ingress |
| Targets | All instances in network |
| Source IP ranges | `0.0.0.0/0` |
| Protocols / ports | TCP `80` |

Click **Create**. Optionally add port `443` for HTTPS later.

---

## 2. SSH into the VM

```bash
gcloud compute ssh flatforge --zone us-central1-c
```

or use the SSH button in GCP Console.

---

## 3. Install System Dependencies

```bash
sudo apt-get update && sudo apt-get upgrade -y

# Python 3.12
sudo apt-get install -y software-properties-common
sudo add-apt-repository -y ppa:deadsnakes/ppa
sudo apt-get update
sudo apt-get install -y python3.12 python3.12-venv python3.12-dev build-essential

# PostgreSQL
sudo apt-get install -y postgresql postgresql-contrib

# Nginx
sudo apt-get install -y nginx

# Git, curl
sudo apt-get install -y git curl

# OpenCASCADE / cadquery system libs
sudo apt-get install -y libgl1 libglu1-mesa libxrender1 libxext6 libsm6
```

### Install Node.js 22 + pnpm

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# pnpm
sudo npm install -g pnpm@11.25.0
```

Verify:

```bash
python3.12 --version   # Python 3.12.x
node --version         # v22.x.x
pnpm --version         # 11.25.0
```

---

## 4. Clone the Repository

```bash
cd /opt
sudo mkdir flatforge && sudo chown $USER:$USER flatforge
cd flatforge

git clone -b experiment/no-tolerance-gates --single-branch \
  https://github.com/Impacting-AI/FlatForgeAI_Latest.git .
```

---

## 5. Set Up PostgreSQL

```bash
sudo -u postgres psql <<'SQL'
CREATE USER flatforge WITH PASSWORD 'replace-with-strong-password';
CREATE DATABASE flatforge OWNER flatforge;
SQL
```

---

## 6. Configure the Backend

### Create `.env`

```bash
cd /opt/flatforge
cp .env .env.bak   # keep the sample as backup
```

Edit `/opt/flatforge/.env` and set these values:

```env
FLATFORGE_API_URL=http://127.0.0.1:8000
FLATFORGE_API_KEY=<run: python3.12 -c "import secrets; print(secrets.token_hex(32))">
POSTGRES_PASSWORD=replace-with-strong-password
FLATFORGE_DATA=/opt/flatforge/data

# CADSoftTools libcad.so (Linux library)
CADSOFT_LIB_PATH=/opt/flatforge/lib/libcad.so
CADSOFT_LICENSE_USER=umar
CADSOFT_LICENSE_EMAIL=backend.elevensteeds@gmail.com
CADSOFT_LICENSE_KEY=1AT11G-I5XF6X-K6QF2L-X5I2X6-NB9862-YGTXYH
```

> Generate `FLATFORGE_API_KEY`:
> ```bash
> python3.12 -c "import secrets; print(secrets.token_hex(32))"
> ```

### Copy `libcad.so` to the VM

On **your Windows machine**, copy the Linux library to the VM:

```powershell
# From your Windows machine (PowerShell)
gcloud compute scp "C:\Users\Super\Downloads\libcad (1)\libcad\Bin\linux\x86_64\libcad.so" `
  flatforge:/opt/flatforge/lib/libcad.so --zone us-central1-c
```

Or via SCP:

```powershell
scp "C:\Users\Super\Downloads\libcad (1)\libcad\Bin\linux\x86_64\libcad.so" \
  <your-user>@34.9.137.235:/opt/flatforge/lib/libcad.so
```

Create the target directory on the VM first:

```bash
mkdir -p /opt/flatforge/lib
```

### Install Python Dependencies

```bash
cd /opt/flatforge/backend
python3.12 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

> **Note:** `cadquery` and `cadquery-ocp` are large (~800 MB). This step takes 5–15 minutes.

### Create Data Directory

```bash
mkdir -p /opt/flatforge/data
```

---

## 7. Build the Frontend

```bash
cd /opt/flatforge
pnpm install --frozen-lockfile
pnpm exec vite build --config vite.spa.config.ts
```

The compiled SPA is written to `/opt/flatforge/dist-spa/`.

---

## 8. Configure Nginx

Create `/etc/nginx/sites-available/flatforge`:

```bash
sudo tee /etc/nginx/sites-available/flatforge > /dev/null <<'NGINX'
server {
    listen 80;
    server_name _;
    root /opt/flatforge/dist-spa;
    client_max_body_size 1050m;

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy same-origin always;

    # Auth endpoints — no API key injected; frontend talks to these directly
    location /api/engine/auth/ {
        proxy_pass http://127.0.0.1:8000/auth/;
        proxy_set_header Host $host;
        proxy_read_timeout 30s;
    }

    location = /api/bootstrap {
        proxy_pass http://127.0.0.1:8000/bootstrap;
        proxy_set_header X-Flatforge-Key "REPLACE_WITH_YOUR_API_KEY";
        proxy_set_header Host $host;
        proxy_read_timeout 120s;
    }

    location /api/engine/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_set_header X-Flatforge-Key "REPLACE_WITH_YOUR_API_KEY";
        proxy_set_header Host $host;
        proxy_read_timeout 120s;
        proxy_request_buffering off;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
NGINX
```

> Replace `REPLACE_WITH_YOUR_API_KEY` with the same `FLATFORGE_API_KEY` value from `.env`.

Enable the site and restart nginx:

```bash
sudo ln -sf /etc/nginx/sites-available/flatforge /etc/nginx/sites-enabled/flatforge
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx
```

---

## 9. Create systemd Services

### Backend API service

```bash
sudo tee /etc/systemd/system/flatforge-api.service > /dev/null <<SERVICE
[Unit]
Description=FlatForge FastAPI backend
After=network.target postgresql.service

[Service]
User=$USER
WorkingDirectory=/opt/flatforge/backend
EnvironmentFile=/opt/flatforge/.env
Environment=DATABASE_URL=postgresql+psycopg://flatforge:REPLACE_DB_PASS@localhost/flatforge
Environment=ADMIN_USERNAME=admin
Environment=ADMIN_PASSWORD=Admin1234@
ExecStart=/opt/flatforge/backend/.venv/bin/uvicorn flatforge.api:app --host 127.0.0.1 --port 8000 --workers 2
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE
```

> Replace `REPLACE_DB_PASS` with your actual PostgreSQL password.

### Worker service

```bash
sudo tee /etc/systemd/system/flatforge-worker.service > /dev/null <<SERVICE
[Unit]
Description=FlatForge CAD worker
After=network.target flatforge-api.service

[Service]
User=$USER
WorkingDirectory=/opt/flatforge/backend
EnvironmentFile=/opt/flatforge/.env
Environment=DATABASE_URL=postgresql+psycopg://flatforge:REPLACE_DB_PASS@localhost/flatforge
ExecStart=/opt/flatforge/backend/.venv/bin/python -m flatforge.worker
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
SERVICE
```

### Enable and start both services

```bash
sudo systemctl daemon-reload
sudo systemctl enable flatforge-api flatforge-worker
sudo systemctl start flatforge-api flatforge-worker
```

---

## 10. Verify Everything Is Running

```bash
# Check services
sudo systemctl status flatforge-api
sudo systemctl status flatforge-worker
sudo systemctl status nginx

# Check API responds
curl http://127.0.0.1:8000/bootstrap \
  -H "X-Flatforge-Key: YOUR_API_KEY"

# Check logs
sudo journalctl -u flatforge-api -f
sudo journalctl -u flatforge-worker -f
```

Open **http://34.9.137.235** in your browser.

---

## 11. File Structure on the VM

```
/opt/flatforge/
├── backend/
│   ├── .venv/           ← Python virtual environment
│   └── flatforge/       ← Python source
├── dist-spa/            ← Built frontend (served by nginx)
├── lib/
│   └── libcad.so        ← CADSoftTools Linux library
├── data/                ← Job artifacts and uploads
└── .env                 ← Secrets and config
```

---

## 12. Updating the App

```bash
cd /opt/flatforge
git pull

# Rebuild frontend
pnpm install --frozen-lockfile
pnpm exec vite build --config vite.spa.config.ts

# Restart backend
sudo systemctl restart flatforge-api flatforge-worker
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `502 Bad Gateway` | API not running: `sudo systemctl restart flatforge-api` |
| `500 on /bootstrap` | Check `FLATFORGE_API_KEY` length (≥ 24 chars) and `DATABASE_URL` |
| DWG upload fails | Verify `libcad.so` exists at `CADSOFT_LIB_PATH` and is executable |
| `cadquery` install fails | Ensure 8 GB+ free disk space and `libgl1` is installed |
| Frontend shows blank page | Check nginx root points to `/opt/flatforge/dist-spa` |
