#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      echo "Usage: $0"
      echo "  Installs the base Drop Quadlet stack (server + PostgreSQL)."
      echo "  The multiplayer mesh is provided by the drop-zerotier plugin,"
      echo "  which points at a controller you supply (BYO ZTNET)."
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

echo "==> 2. Initializing environment configuration files..."
if [[ ! -f "${QUADLET_DIR}/drop.env" ]]; then
  echo "    Creating ${QUADLET_DIR}/drop.env from example template..."
  cp "${SCRIPT_DIR}/env/drop.env.example" "${QUADLET_DIR}/drop.env"
fi

echo "==> 3. Reloading systemd daemon to generate service units..."
${SYSTEMCTL} daemon-reload

echo "==> 4. Starting services..."
${SYSTEMCTL} restart drop-network-network.service
${SYSTEMCTL} restart drop-postgres.service
${SYSTEMCTL} restart drop.service

echo ""
echo "==============================================================="
echo " Drop Quadlet deployment completed successfully!"
echo " Drop Web App: http://localhost:3000"
echo ""
echo " To enable multiplayer mesh networking, install the drop-zerotier"
echo " plugin and point it at your ZTNET controller (see the plugin README)."
echo "==============================================================="
