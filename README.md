# k3s-status-dashboard

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Docker Image](https://img.shields.io/badge/Docker%20Hub-schnippi78%2Fk3s--status--dashboard-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/r/schnippi78/k3s-status-dashboard)
![Node](https://img.shields.io/badge/node-20-339933?logo=node.js&logoColor=white)

A tiny status dashboard for **Kubernetes / k3s**. It reads your Ingress hosts and
nodes straight from the Kubernetes API and renders them on a single clean, dark
page — auto-refreshing every 30 seconds. No database, no agents, no external
services.

- **Services** are discovered via **Ingress** hosts and Traefik **IngressRoute**
  `Host(...)` rules, then mapped to their backend Service's endpoints
  (ready/total).
- **Nodes** are listed with their role, an optional `type` label, and readiness.
- **Zero-config by default**: without any configuration it simply shows *every*
  Ingress host. Add a config only if you want to curate names, order, or
  aggregate several services into one entry.

> This is the Kubernetes/k3s sibling of
> [swarm-status-dashboard](https://github.com/schnippi78/swarm-status-dashboard)
> — same dashboard, Docker Swarm edition.

## Quick start

```bash
kubectl apply -f deploy.example.yaml
kubectl -n status port-forward deploy/status-dashboard 8080:3000
```

Open <http://localhost:8080>. This immediately lists all your Ingress hosts and
cluster nodes.

The dashboard talks to the cluster API using its ServiceAccount. The included
manifest grants **read-only** access (nodes, ingresses, services, endpoints, and
optionally Traefik IngressRoutes) — nothing else.

## Configuration

Everything is optional. Configuration is resolved in this order:

1. `SERVICES_CONFIG` – JSON passed directly as an environment variable
2. `CONFIG_PATH` / `./config.json` – a JSON file (e.g. mounted from a ConfigMap)
3. no config – auto mode: every Ingress host is shown, sorted alphabetically

### Environment variables

| Variable          | Default        | Description                                              |
| ----------------- | -------------- | -------------------------------------------------------- |
| `DASHBOARD_TITLE` | `k3s Status`   | Title shown in the header and browser tab                |
| `CONFIG_PATH`     | `./config.json`| Path to a JSON config file                               |
| `SERVICES_CONFIG` | –              | Inline JSON config (overrides the file)                  |
| `NAMESPACE`       | – (all)        | Restrict discovery to a single namespace                 |
| `PORT`            | `3000`         | Port the server listens on inside the container          |
| `KUBECONFIG`      | in-cluster     | Only for out-of-cluster/dev: path to a kubeconfig        |

### Config file schema

```json
{
  "title": "My Homelab Status",
  "services": [
    { "name": "Nextcloud", "host": "cloud.example.com" },
    { "name": "PiHole", "host": "pihole.example.com" },
    { "name": "Mail", "k8sServices": ["mail/front", "mail/imap", "mail/smtp"] }
  ]
}
```

Each service entry matches in one of two ways:

- **`host`** – matches a discovered Ingress / IngressRoute `Host(...)`.
- **`k8sServices`** – a list of `namespace/service` names whose endpoints are
  aggregated into a single entry (useful for things like mail, where several
  services form one logical service). A bare `service` uses `NAMESPACE` or
  `default`.

The array order is the display order. `title` sets the header; the
`DASHBOARD_TITLE` env variable takes precedence if both are set.

See [`config.example.json`](config.example.json) and
[`deploy.example.yaml`](deploy.example.yaml) for full examples.

## How status is derived

For each host the dashboard resolves the backend Service and reads its
**Endpoints**: `running` = ready backend addresses, `desired` = ready + not-ready.

- `running >= desired` → **ok** (green)
- `0 < running < desired` → **degraded** (yellow)
- `running == 0`, `desired > 0` → **down** (red)
- `desired == 0` (nothing scheduled / host not matched) → **unknown** (grey)

## Deploying

`kubectl apply -f deploy.example.yaml` creates a `status` namespace, a
read-only ServiceAccount/ClusterRole, the Deployment and a Service. Expose it via
`port-forward`, a `LoadBalancer` Service, or your own Ingress (an example Ingress
is included, commented out, at the bottom of the manifest).

## Security note

This dashboard reads your cluster state through a ServiceAccount. The provided
RBAC is **read-only** (`get`, `list`) and scoped to nodes, ingresses, services
and endpoints — it never creates, updates, or removes anything. Do not expose the
dashboard to the public internet without authentication (put it behind your
reverse proxy / an auth middleware).

## Development

```bash
npm install
npm start   # serves on http://localhost:3000, using your ~/.kube/config
```

Out of cluster it uses your current kubeconfig context, so point `kubectl` at the
cluster you want to see first.

## License

MIT
