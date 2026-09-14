# Drop — Podman Quadlet Deployment Template

Production-grade, `systemd`-native deployment template for [Drop](https://github.com/Heretek-Games/drop) using **Podman Quadlet**.

Supports both **system-wide** (`/etc/containers/systemd/`) and **rootless user** (`~/.config/containers/systemd/`) environments on Fedora, RHEL, CentOS Stream, Rocky Linux, AlmaLinux, openSUSE, and Debian/Ubuntu systems.

---

## 1. Stack Architecture

```
                    ┌────────────────────────┐
                    │      Host Ingress      │
                    │        3000 (Drop)     │
                    └───────────┬────────────┘
                                │
  ┌─────────────────────────────┼─────────────────────────────┐
  │ drop-network (172.20.0.0/16 Bridge)                       │
  │                             ▼                             │
  │                       ┌───────────┐   ┌───────────┐       │
  │                       │   drop    │──▶│drop-      │       │
  │                       │(172.20.20)│   │postgres   │       │
  │                       └───────────┘   │(172.20.21)│       │
  │                                       └───────────┘       │
  └───────────────────────────────────────────────────────────┘
```

### Components

| Unit                      | Container Name  | Internal IP     | Host Port   | Purpose                                          |
| :------------------------ | :-------------- | :-------------- | :---------- | :----------------------------------------------- |
| `drop-network.network`    | —               | `172.20.0.0/16` | —           | User-defined bridge network with DNS resolution  |
| `drop-postgres.container` | `drop-postgres` | `172.20.0.21`   | _None_      | PostgreSQL 15 for Drop                           |
| `drop.container`          | `drop`          | `172.20.0.20`   | `3000:3000` | Web UI, REST API, WebSocket pub/sub, chunk depot |

The multiplayer mesh is **not** bundled. Install the `drop-zerotier` plugin and
point it at a ZTNET controller you operate (see the plugin README).

---

## 2. Quickstart

```bash
# For system-wide deployment (root):
sudo ./install.sh

# Or for rootless deployment (current user):
./install.sh
```

---

## 3. Storage & Volume Configuration

By default, the template defines Podman named volumes (`drop-data.volume`, `drop-db.volume`, `drop-cache.volume`).

### Mounting Host Game Libraries

To mount your existing game storage into Drop:

1. Open the installed `drop.container` file (`/etc/containers/systemd/drop.container` or `~/.config/containers/systemd/drop.container`).
2. Add your host bind mount(s):
   ```ini
   Volume=/mnt/storage/games:/library:ro
   Volume=/mnt/fast-storage/software:/software:ro
   ```
3. Run `systemctl daemon-reload && systemctl restart drop.service` (or `systemctl --user ...`).

### Depot Chunk Cache (Fast NVMe Tier)

Drop features an opt-in read-through chunk cache keyed by plaintext SHA-256. The template provisions `drop-cache.volume` and sets `CHUNK_CACHE_DIR=/cache` in `drop.env`. If you want to point the chunk cache directly to a fast NVMe partition, adjust `drop.container`:

```ini
Volume=/mnt/fast-nvme/drop-cache:/cache
```

---

## 4. Uninstallation

```bash
# Keep data volumes:
./uninstall.sh

# Or purge all data volumes and databases:
./uninstall.sh --purge-data
```
