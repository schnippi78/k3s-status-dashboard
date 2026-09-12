# k3s-status-dashboard

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Docker Image](https://img.shields.io/badge/Docker%20Hub-schnippi78%2Fk3s--status--dashboard-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/r/schnippi78/k3s-status-dashboard)
![Node](https://img.shields.io/badge/node-20-339933?logo=node.js&logoColor=white)

A tiny status dashboard for **Kubernetes / k3s**. It **actively probes** your
services (HTTP/TCP via their in-cluster Service DNS) and reads node health from
**Prometheus**, then renders everything on a single clean, dark page —
auto-refreshing every 30 seconds. No database, no agents.

- **Services** are checked by actually talking to them: an HTTP `GET` (redirects
  and auth gates count as "up") or a raw TCP connect. What answers is green.
- **Nodes** come from Prometheus (`kube_node_status_condition`) — optional; leave
  it out and the dashboard just shows services.
- **No cluster API access**: it does not read the Kubernetes API, so it needs
  **no ServiceAccount and no RBAC**. Just point it at the services you care about.

> This is the Kubernetes/k3s sibling of
> [swarm-status-dashboard](https://github.com/schnippi78/swarm-status-dashboard)
> — same look, Docker Swarm edition (which reads the Docker API instead).

## Quick start

```bash
kubectl apply -f deploy.example.yaml   # edit the ConfigMap first
kubectl -n status port-forward deploy/status-dashboard 8080:3000
```

Open <http://localhost:8080>. Edit the `services` list in the ConfigMap to match
your cluster (see below).

## Configuration

Because it probes actively, the dashboard needs to be told **what** to watch.
Configuration is resolved in this order:

1. `SERVICES_CONFIG` – JSON passed directly as an environment variable
2. `CONFIG_PATH` / `./config.json` – a JSON file (e.g. mounted from a ConfigMap)
3. no config – empty list (nothing to check)

### Environment variables

| Variable          | Default        | Description                                              |
| ----------------- | -------------- | -------------------------------------------------------- |
| `DASHBOARD_TITLE` | `k3s Status`   | Title shown in the header and browser tab                |
| `CONFIG_PATH`     | `./config.json`| Path to a JSON config file                               |
| `SERVICES_CONFIG` | –              | Inline JSON config (overrides the file)                  |
| `PROMETHEUS_URL`  | – (no nodes)   | Prometheus base URL for the node section                 |
| `PROBE_TIMEOUT`   | `3000`         | Per-probe timeout in milliseconds                        |
| `PORT`            | `3000`         | Port the server listens on inside the container          |

### Config file schema

```json
{
  "title": "My Homelab Status",
  "prometheusUrl": "http://prometheus.monitoring.svc.cluster.local:9090",
  "services": [
    { "name": "Nextcloud", "http": "http://nextcloud.nextcloud.svc.cluster.local/status.php" },
    { "name": "Mail (SMTP)", "tcp": "smtp.mail.svc.cluster.local:25" }
  ]
}
```

Each service entry is probed one of two ways:

- **`http`** – an HTTP `GET`. `200/301/302/307/308/401/403` count as **up**
  (redirects and auth challenges mean the service is answering). Override the
  accepted codes per entry with `"okStatus": [200, 204]`.
- **`tcp`** – a `host:port` TCP connect. A successful connection is **up**.

The array order is the display order. `prometheusUrl` (or the `PROMETHEUS_URL`
env var) enables the Nodes section; without it, only services are shown.

See [`config.example.json`](config.example.json) and
[`deploy.example.yaml`](deploy.example.yaml) for full examples.

## Status colours

- **green** – `ok` (HTTP code accepted, or TCP connected)
- **red** – `down` (bad HTTP code, timeout, connection refused, DNS failure)
- **grey** – `unknown` (nothing to probe / node condition unknown)

Nodes: **green** ready, **red** not-ready.

## Deploying

`kubectl apply -f deploy.example.yaml` creates a `status` namespace, a ConfigMap
with your service list, the Deployment and a Service. Expose it via
`port-forward`, a `LoadBalancer` Service, or your own Ingress / Traefik
IngressRoute (examples are included, commented out, at the bottom of the
manifest).

## Security note

The dashboard only makes outbound probes to the hosts you list and (optionally)
queries Prometheus. It never reads or writes the cluster API. Still, don't expose
it to the public internet without authentication — put it behind your reverse
proxy / an auth middleware.

## Development

```bash
npm install
CONFIG_PATH=./config.example.json npm start   # http://localhost:3000
```

Probes run from wherever the process runs, so for real in-cluster DNS names
(`*.svc.cluster.local`) run it inside the cluster; locally, point the config at
reachable URLs/hosts.

## License

MIT
