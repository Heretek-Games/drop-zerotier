#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WITH_ZTNET=true

for arg in "$@"; do
  case "$arg" in
    --base-only)
      WITH_ZTNET=false
      shift
      ;;
    --with-ztnet)
      WITH_ZTNET=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--with-ztnet | --base-only]"
      echo "  --with-ztnet  Install Drop base stack + ZTNET/ZeroTier multiplayer mesh (default)"
      echo "  --base-only   Install Drop base stack + PostgreSQL database only"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 1
      ;;
  esac
done

# Detect rootful vs rootless execution
if [[ $EUID -eq 0 ]]; then
  QUADLET_DIR="/etc/containers/systemd"
  SYSTEMCTL="systemctl"
  echo "==> Deploying in system-wide mode (${QUADLET_DIR})"
else
  QUADLET_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
  SYSTEMCTL="systemctl --user"
  echo "==> Deploying in rootless mode (${QUADLET_DIR})"
fi

mkdir -p "${QUADLET_DIR}"

echo "==> 1. Copying base Drop Quadlet units..."
cp -v "${SCRIPT_DIR}/base/"*.network "${QUADLET_DIR}/"
cp -v "${SCRIPT_DIR}/base/"*.volume "${QUADLET_DIR}/"
cp -v "${SCRIPT_DIR}/base/"*.container "${QUADLET_DIR}/"

if [[ "$WITH_ZTNET" = true ]]; then
  echo "==> 2. Copying ZTNET & ZeroTier multiplayer Quadlet units..."
  cp -v "${SCRIPT_DIR}/ztnet/"*.volume "${QUADLET_DIR}/"
  cp -v "${SCRIPT_DIR}/ztnet/"*.container "${QUADLET_DIR}/"
fi

echo "==> 3. Initializing environment configuration files..."
if [[ ! -f "${QUADLET_DIR}/drop.env" ]]; then
  echo "    Creating ${QUADLET_DIR}/drop.env from example template..."
  cp "${SCRIPT_DIR}/env/drop.env.example" "${QUADLET_DIR}/drop.env"
fi

if [[ ! -f "${QUADLET_DIR}/ztnet-credentials.env" ]]; then
  echo "    Creating ${QUADLET_DIR}/ztnet-credentials.env template..."
  cp "${SCRIPT_DIR}/env/ztnet-credentials.env.example" "${QUADLET_DIR}/ztnet-credentials.env"
fi

if [[ "$WITH_ZTNET" = true && ! -f "${QUADLET_DIR}/ztnet.env" ]]; then
  echo "    Creating ${QUADLET_DIR}/ztnet.env with auto-generated NEXTAUTH_SECRET..."
  SECRET=$(openssl rand -hex 32 2>/dev/null || tr -dc 'a-f0-9' < /dev/urandom | head -c 64)
  sed "s/NEXTAUTH_SECRET=/NEXTAUTH_SECRET=${SECRET}/" "${SCRIPT_DIR}/env/ztnet.env.example" > "${QUADLET_DIR}/ztnet.env"
fi

echo "==> 4. Reloading systemd daemon to generate service units..."
${SYSTEMCTL} daemon-reload

echo "==> 5. Starting services..."
${SYSTEMCTL} restart drop-network-network.service
${SYSTEMCTL} restart drop-postgres.service

if [[ "$WITH_ZTNET" = true ]]; then
  ${SYSTEMCTL} restart drop-zerotier.service
  ${SYSTEMCTL} restart drop-ztnet-postgres.service
  ${SYSTEMCTL} restart drop-ztnet.service
fi

${SYSTEMCTL} restart drop.service

echo ""
echo "==============================================================="
echo " Drop Quadlet deployment completed successfully!"
echo " Drop Web App:     http://localhost:3000"
if [[ "$WITH_ZTNET" = true ]]; then
  echo " ZTNET Web UI:     http://localhost:3002"
  echo " ZeroTier (host):  Port 9994/udp"
  echo ""
  echo " Next step: Run ./bootstrap-ztnet.sh to link Drop to ZTNET for multiplayer mesh rooms."
fi
echo "==============================================================="
