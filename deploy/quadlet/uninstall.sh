#!/usr/bin/env bash
set -euo pipefail

REMOVE_VOLUMES=false

for arg in "$@"; do
  case "$arg" in
    --purge-data)
      REMOVE_VOLUMES=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--purge-data]"
      echo "  --purge-data  Remove all persistent Podman named volumes and database storage"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 1
      ;;
  esac
done

if [[ $EUID -eq 0 ]]; then
  QUADLET_DIR="/etc/containers/systemd"
  SYSTEMCTL="systemctl"
else
  QUADLET_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
  SYSTEMCTL="systemctl --user"
fi

echo "==> 1. Stopping Drop Quadlet services..."
${SYSTEMCTL} stop drop.service drop-postgres.service drop-network-network.service 2>/dev/null || true
${SYSTEMCTL} reset-failed drop*.service 2>/dev/null || true

echo "==> 2. Removing Quadlet unit files from ${QUADLET_DIR}..."
rm -f "${QUADLET_DIR}/drop-network.network" \
      "${QUADLET_DIR}/drop-postgres.container" \
      "${QUADLET_DIR}/drop.container" \
      "${QUADLET_DIR}/drop-*.volume"

echo "==> 3. Reloading systemd daemon..."
${SYSTEMCTL} daemon-reload

if [[ "$REMOVE_VOLUMES" = true ]]; then
  echo "==> 4. Purging Podman named volumes..."
  podman volume rm -f systemd-drop-db systemd-drop-data systemd-drop-cache 2>/dev/null || true
  podman volume rm -f drop-db drop-data drop-cache 2>/dev/null || true
  rm -f "${QUADLET_DIR}/drop.env"
fi

echo ""
echo "==============================================================="
echo " Drop Quadlet deployment uninstalled."
if [[ "$REMOVE_VOLUMES" = false ]]; then
  echo " Persistent volumes and configuration files were preserved in ${QUADLET_DIR}."
  echo " To delete all data volumes, re-run with: $0 --purge-data"
else
  echo " All persistent volumes and configuration files have been purged."
fi
echo "==============================================================="
