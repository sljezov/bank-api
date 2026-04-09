#!/bin/bash
set -e

echo "=== Bank API Setup Script ==="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo ./setup.sh"
  exit 1
fi

echo "[1/6] Updating system..."
apt update && apt upgrade -y

echo "[2/6] Installing Docker..."
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
else
  echo "Docker already installed"
fi

echo "[3/6] Installing dependencies..."
apt install -y curl git nginx certbot python3-certbot-nginx

echo "[4/6] Setting up bank directory..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check if services/api-gateway exists
if [ ! -d "services/api-gateway" ]; then
  echo "Error: services/api-gateway not found. Please run from the bank project directory."
  exit 1
fi

# Check if docker-compose.yml exists
if [ ! -f "docker-compose.yml" ]; then
  echo "Error: docker-compose.yml not found. Please run from the bank project directory."
  exit 1
fi

echo "[5/6] Building services..."
docker compose build

echo "[6/6] Starting services..."
docker compose up -d

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Services running:"
docker compose ps
echo ""
echo "To view logs: docker compose logs -f"
echo "To stop: docker compose down"
echo ""
