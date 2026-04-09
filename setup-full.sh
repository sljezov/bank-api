#!/bin/bash
set -e

echo "=== Complete Bank API Server Setup ==="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo ./setup-full.sh"
  exit 1
fi

# Get server IP
SERVER_IP=$(curl -s ifconfig.me || hostname -I | awk '{print $1}')
echo "Detected server IP: $SERVER_IP"

# Prompt for domain (optional)
read -p "Enter your domain name (or press Enter to skip): " DOMAIN

# Prompt for email for SSL
read -p "Enter your email for SSL certificate: " EMAIL

echo ""
echo "=== [1/8] Updating system ==="
apt update && apt upgrade -y

echo ""
echo "=== [2/8] Installing Docker ==="
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
else
  echo "Docker already installed"
fi

echo ""
echo "=== [3/8] Installing dependencies ==="
apt install -y curl git nginx certbot python3-certbot-nginx software-properties-common

echo ""
echo "=== [4/8] Creating deploy user ==="
if ! id -u deploy &> /dev/null; then
  useradd -m -s /bin/bash deploy
  echo "Created user: deploy"
fi
usermod -aG docker deploy

echo ""
echo "=== [5/8] Setting up project ==="
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="/home/deploy/bank"

# Check if project exists
if [ -d "$PROJECT_DIR" ]; then
  read -p "Project already exists. Pull latest? (y/n): " PULL
  if [ "$PULL" = "y" ]; then
    cd "$PROJECT_DIR"
    git pull
  fi
else
  echo "Please clone your repo to $PROJECT_DIR"
  echo "Then run: sudo ./setup-full.sh"
  exit 1
fi

cd "$PROJECT_DIR"

echo ""
echo "=== [6/8] Configuring environment ==="
# Set BANK_PUBLIC_URL based on domain or IP
if [ -n "$DOMAIN" ]; then
  export BANK_PUBLIC_URL="https://$DOMAIN/api/v1"
else
  export BANK_PUBLIC_URL="http://$SERVER_IP:3000/api/v1"
fi

# Update docker-compose.yml with correct BANK_PUBLIC_URL
sed -i "s|BANK_PUBLIC_URL: \"http://localhost:3000/api/v1\"|BANK_PUBLIC_URL: \"$BANK_PUBLIC_URL\"|" docker-compose.yml

echo "BANK_PUBLIC_URL set to: $BANK_PUBLIC_URL"

echo ""
echo "=== [7/8] Building and starting services ==="
docker compose build
docker compose up -d

# Wait for services to be healthy
echo "Waiting for services to start..."
sleep 10

# Check status
echo ""
echo "=== Services Status ==="
docker compose ps

echo ""
echo "=== [8/8] Setting up Nginx reverse proxy ==="
if [ -n "$DOMAIN" ]; then
  cat > /etc/nginx/sites-available/bank-api << EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

  ln -sf /etc/nginx/sites-available/bank-api /etc/nginx/sites-enabled/
  nginx -t
  
  # Get SSL certificate
  echo "Getting SSL certificate..."
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
  
  echo "HTTPS enabled at https://$DOMAIN"
else
  # Just set up basic nginx without SSL
  cat > /etc/nginx/sites-available/bank-api << EOF
server {
    listen 80;
    server_name $SERVER_IP;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}
EOF

  ln -sf /etc/nginx/sites-available/bank-api /etc/nginx/sites-enabled/
  nginx -t
fi

# Reload nginx
systemctl reload nginx

# Ensure services restart on reboot
cd "$PROJECT_DIR"
docker compose restart bank-sync-service

echo ""
echo "=============================================="
echo "=== SETUP COMPLETE ==="
echo "=============================================="
echo ""
echo "Bank API: http://$SERVER_IP:3000"
if [ -n "$DOMAIN" ]; then
  echo "Bank API (HTTPS): https://$DOMAIN"
  echo "Swagger UI: https://$DOMAIN/api-docs"
else
  echo "Swagger UI: http://$SERVER_IP:3000/api-docs"
fi
echo ""
echo "Bank ID: HTT005"
echo ""
echo "=== Useful Commands ==="
echo "View logs:     cd $PROJECT_DIR && docker compose logs -f"
echo "Stop services: cd $PROJECT_DIR && docker compose down"
echo "Restart:       cd $PROJECT_DIR && docker compose restart"
echo "Check status:  docker compose ps"
echo ""
echo "Heartbeat is preserved via 'restart: unless-stopped' in docker-compose"
echo ""
