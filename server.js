const express = require('express');
const k8s = require('@kubernetes/client-node');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Kubernetes-Client
//
// In-Cluster: liest Token + CA aus dem gemounteten ServiceAccount.
// Lokal (Entwicklung): fällt auf die Default-Kubeconfig zurück (KUBECONFIG /
// ~/.kube/config).
// ---------------------------------------------------------------------------
const kc = new k8s.KubeConfig();
try {
  kc.loadFromCluster();
} catch (err) {
  kc.loadFromDefault();
}
const coreApi = kc.makeApiClient(k8s.CoreV1Api);
const netApi = kc.makeApiClient(k8s.NetworkingV1Api);
const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

const app = express();
const PORT = process.env.PORT || 3000;

// Optionaler Namespace-Filter: nur Hosts/Services aus diesem Namespace.
const NAMESPACE = process.env.NAMESPACE || null;

const HOST_REGEX = /Host\(`([^`]+)`\)/g;

// Kompatibel zu Client-Versionen, die { body } zurückgeben, und solchen, die
// das Objekt direkt liefern.
const unwrap = (res) => (res && res.body !== undefined ? res.body : res);

// ---------------------------------------------------------------------------
// Konfiguration
//
// Drei Quellen, in dieser Reihenfolge:
//   1. SERVICES_CONFIG  – JSON direkt als Env-Variable
//   2. CONFIG_PATH / ./config.json  – JSON-Datei (z. B. per ConfigMap gemountet)
//   3. keine Config     – Auto-Modus: alle Ingress-Hosts werden angezeigt
//
// Config-Schema:
//   {
//     "title": "My Status",
//     "services": [
//       { "name": "Nextcloud", "host": "cloud.example.com" },
//       { "name": "Mail", "k8sServices": ["mail/front", "mail/imap"] }
//     ]
//   }
//
// Ein Service-Eintrag matcht entweder über "host" (Ingress-/IngressRoute-Host)
// oder über "k8sServices" (Liste von "namespace/service", die aggregiert werden).
// Die Reihenfolge im Array bestimmt die Reihenfolge im Dashboard.
// ---------------------------------------------------------------------------
function loadConfig() {
  const inline = process.env.SERVICES_CONFIG;
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch (err) {
      console.error('SERVICES_CONFIG ist kein gültiges JSON:', err.message);
    }
  }

  const configPath = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      console.error(`Config ${configPath} konnte nicht gelesen werden:`, err.message);
    }
  }

  return {};
}

const config = loadConfig();
const TITLE = process.env.DASHBOARD_TITLE || config.title || 'k3s Status';
const SERVICE_CONFIG = Array.isArray(config.services) ? config.services : null;

function serviceStatus(running, desired) {
  if (desired === 0) return 'unbekannt';
  if (running >= desired) return 'ok';
  if (running > 0) return 'eingeschränkt';
  return 'down';
}

function nodeStatus(conditions) {
  const ready = (conditions || []).find((c) => c.type === 'Ready');
  return ready && ready.status === 'True' ? 'ready' : 'down';
}

// ---------------------------------------------------------------------------
// Host-Erkennung
//
// Zwei Quellen, zusammengeführt:
//   * Standard-Ingress (networking.k8s.io/v1): spec.rules[].host
//   * Traefik IngressRoute (CRD): spec.routes[].match -> Host(`...`)
//
// Jeder Host wird auf seinen Backend-Service (namespace/name) gemappt, dessen
// Endpoints dann ready/total liefern.
// ---------------------------------------------------------------------------
function matchHosts(rule) {
  const hosts = [];
  let m;
  HOST_REGEX.lastIndex = 0;
  while ((m = HOST_REGEX.exec(rule)) !== null) hosts.push(m[1]);
  return hosts;
}

async function discoverHosts() {
  const hosts = new Map(); // host -> { namespace, service }

  // 1. Standard-Ingress
  try {
    const res = NAMESPACE
      ? await netApi.listNamespacedIngress(NAMESPACE)
      : await netApi.listIngressForAllNamespaces();
    for (const ing of unwrap(res).items || []) {
      const ns = ing.metadata.namespace;
      for (const rule of (ing.spec && ing.spec.rules) || []) {
        if (!rule.host) continue;
        let service = null;
        for (const p of (rule.http && rule.http.paths) || []) {
          if (p.backend && p.backend.service && p.backend.service.name) {
            service = p.backend.service.name;
            break;
          }
        }
        if (!hosts.has(rule.host)) hosts.set(rule.host, { namespace: ns, service });
      }
    }
  } catch (err) {
    console.error('Ingress-Discovery fehlgeschlagen:', err.message);
  }

  // 2. Traefik IngressRoute (CRD, optional – Gruppe je nach Traefik-Version)
  const traefikGroups = ['traefik.io', 'traefik.containo.us'];
  for (const group of traefikGroups) {
    try {
      const res = NAMESPACE
        ? await customApi.listNamespacedCustomObject(group, 'v1alpha1', NAMESPACE, 'ingressroutes')
        : await customApi.listCustomObjectForAllNamespaces(group, 'v1alpha1', 'ingressroutes');
      const items = unwrap(res).items || [];
      for (const ir of items) {
        const ns = ir.metadata.namespace;
        for (const route of (ir.spec && ir.spec.routes) || []) {
          const service =
            (route.services && route.services[0] && route.services[0].name) || null;
          for (const host of matchHosts(route.match || '')) {
            if (!hosts.has(host)) hosts.set(host, { namespace: ns, service });
          }
        }
      }
      if (items.length) break; // passende Gruppe gefunden
    } catch (err) {
      // CRD-Gruppe existiert nicht -> nächste probieren / still ignorieren
    }
  }

  return hosts;
}

// Ready-/Gesamt-Backends eines Service aus seinen Endpoints.
async function endpointsCount(namespace, service) {
  if (!service) return { running: 0, desired: 0 };
  try {
    const res = await coreApi.readNamespacedEndpoints(service, namespace);
    const ep = unwrap(res);
    let ready = 0;
    let notReady = 0;
    for (const s of ep.subsets || []) {
      ready += (s.addresses || []).length;
      notReady += (s.notReadyAddresses || []).length;
    }
    return { running: ready, desired: ready + notReady };
  } catch (err) {
    return { running: 0, desired: 0 };
  }
}

// "namespace/service" oder nur "service" (dann Default-Namespace / NAMESPACE).
function splitRef(ref) {
  const idx = ref.indexOf('/');
  if (idx === -1) return { namespace: NAMESPACE || 'default', service: ref };
  return { namespace: ref.slice(0, idx), service: ref.slice(idx + 1) };
}

async function getServices() {
  const hosts = await discoverHosts();

  // Auto-Modus: keine Config -> alle Ingress-Hosts anzeigen.
  if (!SERVICE_CONFIG) {
    const out = [];
    for (const [host, ref] of hosts) {
      const { running, desired } = await endpointsCount(ref.namespace, ref.service);
      out.push({ name: host, running, desired, status: serviceStatus(running, desired) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Kuratierter Modus: Namen und Reihenfolge kommen aus der Config.
  const out = [];
  for (const entry of SERVICE_CONFIG) {
    // Aggregation mehrerer Services (z. B. Mail = front + imap + smtp).
    if (Array.isArray(entry.k8sServices)) {
      let running = 0;
      let desired = 0;
      for (const ref of entry.k8sServices) {
        const { namespace, service } = splitRef(ref);
        const c = await endpointsCount(namespace, service);
        running += c.running;
        desired += c.desired;
      }
      out.push({ name: entry.name, running, desired, status: serviceStatus(running, desired) });
      continue;
    }

    // Einzelner Service über seinen Host.
    const ref = hosts.get(entry.host);
    if (!ref) {
      out.push({ name: entry.name || entry.host, running: 0, desired: 0, status: 'unbekannt' });
      continue;
    }
    const { running, desired } = await endpointsCount(ref.namespace, ref.service);
    out.push({
      name: entry.name || entry.host,
      running,
      desired,
      status: serviceStatus(running, desired),
    });
  }
  return out;
}

async function getNodes() {
  const res = await coreApi.listNode();
  return (unwrap(res).items || [])
    .map((node) => {
      const labels = (node.metadata && node.metadata.labels) || {};
      const roles = Object.keys(labels)
        .filter((k) => k.startsWith('node-role.kubernetes.io/'))
        .map((k) => k.slice('node-role.kubernetes.io/'.length))
        .filter(Boolean);
      const role = roles.length ? roles.join(',') : 'worker';
      return {
        name: node.metadata.name,
        role,
        // Anzeige-Label: eigenes "type"-Label bevorzugt, sonst die Rolle.
        type: labels.type || role,
        status: nodeStatus(node.status && node.status.conditions),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

app.get('/api/status', async (req, res) => {
  try {
    const [services, nodes] = await Promise.all([getServices(), getNodes()]);
    res.json({ title: TITLE, services, nodes, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Fehler beim Abfragen der Kubernetes-API:', err.message);
    res.status(500).json({ error: 'Kubernetes-API nicht erreichbar' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`${TITLE} läuft auf Port ${PORT}`);
});
