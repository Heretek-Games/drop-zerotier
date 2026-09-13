# Drop — Podman Quadlet Deployment Template

Production-grade, `systemd`-native deployment template for [Drop](https://github.com/Heretek-Games/drop) using **Podman Quadlet**.

Supports both **system-wide** (`/etc/containers/systemd/`) and **rootless user** (`~/.config/containers/systemd/`) environments on Fedora, RHEL, CentOS Stream, Rocky Linux, AlmaLinux, openSUSE, and Debian/Ubuntu systems.

---

## 1. Stack Architecture

```
                    ┌─────────────────────────────────────────┐
                    │               Host Ingress              │
                    │   3000 (Drop)  │  3002 (ZTNET) │ 9994/u │
                    └───────┬───────────────┬────────────┬────┘
                            │               │            │
 ┌──────────────────────────┼───────────────┼────────────┼──────────────────────────┐
 │ drop-network (172.20.0.0/16 Bridge)      │            │                          │
 │                          ▼               ▼            ▼                          │
 │                    ┌───────────┐   ┌───────────┐┌───────────┐                    │
 │                    │   drop    │   │drop-ztnet ││drop-      │                    │
 │                    │(172.20.20)│   │(172.20.32)││zerotier   │                    │
 │                    └─────┬─────┘   └─────┬─────┘│(172.20.30)│                    │
 │                          │               │      └─────▲─────┘                    │
 │                          ▼               ▼            │                          │
 │                    ┌───────────┐   ┌───────────┐      │                          │
 │                    │drop-      │   │drop-ztnet-│      │                          │
 │                    │postgres   │   │postgres   │      │                          │
 │                    │(172.20.21)│   │(172.20.31)│──────┘                          │
 │                    └───────────┘   └───────────┘                                 │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

### Components

| Unit                            | Container Name        | Internal IP     | Host Port       | Purpose                                                                 |
| :------------------------------ | :-------------------- | :-------------- | :-------------- | :---------------------------------------------------------------------- |
| `drop-network.network`          | —                     | `172.20.0.0/16` | —               | User-defined bridge network with DNS resolution & IPv6 ULA              |
| `drop-postgres.container`       | `drop-postgres`       | `172.20.0.21`   | _None_          | PostgreSQL 14 for Drop                                                  |
| `drop.container`                | `drop`                | `172.20.0.20`   | `3000:3000`     | Web UI, REST API, WebSocket pub/sub, chunk depot                        |
| `drop-zerotier.container`       | `drop-zerotier`       | `172.20.0.30`   | `9994:9994/udp` | ZeroTier controller data plane (port 9994 avoids host ZT conflict)      |
| `drop-ztnet-postgres.container` | `drop-ztnet-postgres` | `172.20.0.31`   | _None_          | PostgreSQL 15 for ZTNET                                                 |
| `drop-ztnet.container`          | `drop-ztnet`          | `172.20.0.32`   | `3002:3000`     | ZTNET web management UI & REST API (port 3002 avoids dashboard clashes) |

---

## 2. Quickstart

### Option A: Full Stack with GSE Multiplayer Mesh (Recommended)

```bash
# For system-wide deployment (root):
sudo ./install.sh

# Or for rootless deployment (current user):
./install.sh
```

Once the containers start, bootstrap the ZTNET organization and mint the API token:

```bash
./bootstrap-ztnet.sh
```

### Option B: Base Stack Only (No Multiplayer Mesh)

```bash
sudo ./install.sh --base-only
```

---

## 3. Storage & Volume Configuration

By default, the template defines Podman named volumes (`drop-data.volume`, `drop-db.volume`, `drop-cache.volume`, `drop-zerotier.volume`, `drop-ztnet-db.volume`).

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

## 4. Port Configuration

- **Drop Web UI**: `3000:3000`
- **ZTNET Admin Dashboard**: `3002:3000` (defaults to 3002 to avoid conflicts with other developer tools on 3001)
- **ZeroTier Controller**: `9994:9994/udp` (defaults to 9994 to avoid collisions if the host machine also runs ZeroTier One on port 9993)

To change host ports, edit `PublishPort=` in the respective `.container` unit and reload.

---

## 5. Uninstallation

To cleanly stop and remove the Quadlet units:

```bash
# Keep data volumes:
./uninstall.sh

# Or purge all data volumes and databases:
./uninstall.sh --purge-data
```
