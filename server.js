const express = require('express');
const net = require('net');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Timeout pro Probe (ms).
const PROBE_TIMEOUT = parseInt(process.env.PROBE_TIMEOUT || '3000', 10);

// HTTP-Statuscodes, die als "erreichbar" gelten (Redirects/Auth-Gates zählen als
// "Dienst antwortet"). Pro Service über "okStatus" überschreibbar.
const OK_HTTP = new Set([200, 301, 302, 307, 308, 401, 403]);

// ---------------------------------------------------------------------------
// Konfiguration
//
// Drei Quellen, in dieser Reihenfolge:
//   1. SERVICES_CONFIG  – JSON direkt als Env-Variable
//   2. CONFIG_PATH / ./config.json  – JSON-Datei (z. B. per ConfigMap gemountet)
//   3. keine Config     – leere Liste (nichts zu prüfen)
//
// Config-Schema:
//   {
//     "title": "My Status",
//     "prometheusUrl": "http://prometheus.monitoring.svc.cluster.local:9090",
//     "services": [
//       { "name": "Nextcloud", "http": "http://nextcloud.nextcloud.svc.cluster.local/status.php" },
//       { "name": "Mail (SMTP)", "tcp": "smtp.mail.svc.cluster.local:25" }
//     ]
//   }
//
// Dienste werden AKTIV geprüft: "http" per GET (ohne Redirects zu folgen),
// "tcp" per Connect. Nodes kommen – falls prometheusUrl gesetzt ist – aus
// Prometheus (kube_node_status_condition), sonst bleibt die Node-Liste leer.
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
const PROMETHEUS_URL = (process.env.PROMETHEUS_URL || config.prometheusUrl || '').replace(/\/+$/, '');
const SERVICES = Array.isArray(config.services) ? config.services : [];

// ---------------------------------------------------------------------------
// Aktive Dienst-Prüfungen
// ---------------------------------------------------------------------------
async function probeHttp(url, okSet) {
  try {
    // redirect:'manual' -> 3xx bleibt 3xx (wir folgen nicht, werten aber als "ok").
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
    });
    const code = res.status;
    return { status: okSet.has(code) ? 'ok' : 'down', detail: 'HTTP ' + code };
  } catch (err) {
    if (err.name === 'TimeoutError') return { status: 'down', detail: 'timeout' };
    const code = (err.cause && err.cause.code) || err.code || err.name || 'error';
    return { status: 'down', detail: String(code).toLowerCase() };
  }
}

function probeTcp(hostport) {
  return new Promise((resolve) => {
    const idx = hostport.lastIndexOf(':');
    const host = hostport.slice(0, idx);
    const port = parseInt(hostport.slice(idx + 1), 10);
    if (!host || !port) {
      resolve({ status: 'unbekannt', detail: 'ungültig' });
      return;
    }
    const sock = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(PROBE_TIMEOUT);
    sock.once('connect', () => finish({ status: 'ok', detail: 'tcp ' + port }));
    sock.once('timeout', () => finish({ status: 'down', detail: 'timeout' }));
    sock.once('error', (err) => finish({ status: 'down', detail: (err.code || 'error').toLowerCase() }));
    sock.connect(port, host);
  });
}

async function getServices() {
  return Promise.all(
    SERVICES.map(async (s) => {
      const okSet = Array.isArray(s.okStatus) ? new Set(s.okStatus) : OK_HTTP;
      let result;
      if (s.http) result = await probeHttp(s.http, okSet);
      else if (s.tcp) result = await probeTcp(s.tcp);
      else result = { status: 'unbekannt', detail: 'keine Prüfung' };
      return { name: s.name, status: result.status, detail: result.detail };
    })
  );
}

// ---------------------------------------------------------------------------
// Nodes über Prometheus (kube-state-metrics). Optional: ohne PROMETHEUS_URL
// bleibt die Node-Liste leer.
// ---------------------------------------------------------------------------
async function getNodes() {
  if (!PROMETHEUS_URL) return [];
  try {
    const url =
      PROMETHEUS_URL +
      '/api/v1/query?query=' +
      encodeURIComponent('kube_node_status_condition{condition="Ready"}');
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT) });
    const json = await res.json();
    const out = {};
    for (const series of (json.data && json.data.result) || []) {
      const node = (series.metric && series.metric.node) || '?';
      const cond = (series.metric && series.metric.status) || '';
      const value = series.value && series.value[1];
      if (!(node in out)) out[node] = 'unbekannt';
      if (cond === 'true' && value === '1') out[node] = 'ready';
      else if (cond === 'false' && value === '1' && out[node] !== 'ready') out[node] = 'down';
    }
    return Object.keys(out)
      .sort()
      .map((name) => ({ name, status: out[name] }));
  } catch (err) {
    console.error('Prometheus-Abfrage fehlgeschlagen:', err.message);
    return [];
  }
}

app.get('/api/status', async (req, res) => {
  try {
    const [services, nodes] = await Promise.all([getServices(), getNodes()]);
    res.json({ title: TITLE, services, nodes, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Fehler beim Erzeugen des Status:', err.message);
    res.status(500).json({ error: 'Status konnte nicht ermittelt werden' });
  }
});

app.get('/health', (req, res) => res.type('text').send('ok\n'));

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`${TITLE} läuft auf Port ${PORT}`);
});
