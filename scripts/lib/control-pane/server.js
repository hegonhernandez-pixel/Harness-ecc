'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const { buildControlPaneAction } = require('./actions');
const { buildControlPaneSnapshot, resolveControlPaneConfig } = require('./state');
const { renderControlPaneHtml } = require('./ui');
const { renderProximityVizHtml } = require('./proximity-viz');
const { renderControlPlaneViewHtml } = require('./control-plane-view-ui');
const { createControlPlaneViewSource } = require('./control-plane-view');
const { claimWorkItem, moveWorkItem } = require('./work-item-mutations');

// Run a single write against the local work-item store, then close it. Kept
// thin so the loopback-only server can mutate the JIT board without holding a
// long-lived handle.
async function withStateStore(stateDbPath, fn) {
  const { createStateStore } = require('../state-store');
  const store = await createStateStore({ dbPath: stateDbPath });
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

// Host/Origin gating lives in scripts/lib/loopback-guard.js so every ECC
// loopback server shares one hardened implementation; re-exported below to
// keep this module's public API stable.
const {
  LOOPBACK_HOSTNAMES,
  buildAllowedHostnames,
  isAllowedHostHeader,
  isAllowedOrigin
} = require('../loopback-guard');

function usage() {
  return [
    'Usage:',
    '  node scripts/control-pane.js [--host 127.0.0.1] [--port 8765] [--db <ecc2.db>] [--state-db <state.db>] [--config <ecc2.toml>] [--query <text>]',
    '',
    'Options:',
    '  --state-db <path>  Read agent work items from an ECC state-store database',
    '  --read-only        Disable action execution endpoints',
    '  --no-open          Do not open a browser after the server starts',
    '  --help             Show this help'
  ].join('\n');
}

function valueAfter(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function pathValueAfter(args, name) {
  const value = valueAfter(args, name);
  if (value === null) return null;
  if (!value || value.startsWith('-')) {
    throw new Error(`Invalid ${name} value: expected a path`);
  }
  return value;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const help = args.includes('--help') || args.includes('-h');
  const host = valueAfter(args, '--host') || '127.0.0.1';
  assertLoopbackHost(host);
  const portValue = valueAfter(args, '--port') || '8765';
  const port = Number.parseInt(portValue, 10);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port value: ${portValue}`);
  }

  return {
    help,
    host,
    port,
    dbPath: valueAfter(args, '--db'),
    stateDbPath: pathValueAfter(args, '--state-db'),
    configPath: valueAfter(args, '--config'),
    query: valueAfter(args, '--query') || '',
    openBrowser: !args.includes('--no-open'),
    allowActions: !args.includes('--read-only')
  };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(`${body}\n`);
}

function sendText(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-store'
  });
  res.end(body);
}

function assertLoopbackHost(host) {
  if (!LOOPBACK_HOSTNAMES.has(String(host).toLowerCase())) {
    throw new Error('Control pane requires a loopback host (127.0.0.1, localhost, or ::1)');
  }
}

function readRequestJson(req) {
  const maxBytes = 64 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const onError = error => { cleanup(); reject(error); };
    const onAborted = () => onError(new Error('Request aborted'));
    const onData = chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        cleanup();
        req.resume(); // Discard subsequent bytes without retaining them.
        const error = new Error('Request body exceeds 65536 bytes');
        error.statusCode = 413;
        reject(error);
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) { reject(error); }
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function outputCollector(limit = 20000) {
  let text = '';
  let discarded = 0;
  return {
    append(chunk) {
      const value = chunk.toString('utf8');
      const remaining = limit - text.length;
      text += value.slice(0, remaining);
      discarded += Math.max(0, value.length - remaining);
    },
    value() { return discarded ? `${text}\n[truncated ${discarded} chars]` : text; }
  };
}

function runAction(action, options = {}) {
  const timeoutMs = options.timeoutMs || 120000;
  const killGraceMs = options.killGraceMs || 1000;
  return new Promise(resolve => {
    const startedAt = new Date().toISOString();
    const processGroup = process.platform !== 'win32';
    const child = spawn(action.command, action.args, {
      cwd: action.cwd, env: process.env,
      detached: processGroup,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = outputCollector();
    const stderr = outputCollector();
    let settled = false;
    let timedOut = false;
    let escalation;
    let finalDeadline;
    let escalated = false;
    let pendingFinish;
    const terminate = signal => {
      try {
        if (processGroup && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error.code !== 'ESRCH') stderr.append(Buffer.from(error.message));
      }
    };
    const finish = (code, signal, error) => {
      if (settled) return;
      // The leader may exit while descendants with closed pipes ignore TERM.
      // Keep the group escalation alive before reporting timed-out completion.
      if (timedOut && processGroup && !escalated) {
        pendingFinish = [code, signal, error];
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(escalation);
      clearTimeout(finalDeadline);
      resolve({
        ok: !timedOut && !error && code === 0,
        action: action.id, startedAt, finishedAt: new Date().toISOString(),
        code, signal, timedOut,
        ...(error ? { error: error.message } : {}),
        stdout: stdout.value(), stderr: stderr.value()
      });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      escalation = setTimeout(() => {
        terminate('SIGKILL');
        escalated = true;
        if (pendingFinish) { finish(...pendingFinish); return; }
        finalDeadline = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish(null, 'SIGKILL', new Error('Action termination deadline exceeded'));
        }, killGraceMs);
      }, killGraceMs);
    }, timeoutMs);
    child.stdout.on('data', chunk => stdout.append(chunk));
    child.stderr.on('data', chunk => stderr.append(chunk));
    child.on('error', error => finish(null, null, error));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

function createControlPaneServer(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..', '..', '..'));
  const host = options.host || '127.0.0.1';
  assertLoopbackHost(host);
  const port = options.port === null || options.port === undefined ? 8765 : options.port;
  const allowActions = options.allowActions !== false;
  const resolvedConfig = resolveControlPaneConfig({
    cwd: options.cwd || repoRoot,
    configPath: options.configPath,
    dbPath: options.dbPath,
    stateDbPath: options.stateDbPath,
    env: options.env || process.env
  });
  const baseQuery = options.query || '';
  const allowedHostnames = buildAllowedHostnames(host);

  // Live control-plane view: sessions + proximity scan + coordination
  // inventory, joined as tasks/lanes/events with a 2D projection. The view
  // source owns the rolling projection window so z-scores span ticks.
  const viewSource = createControlPlaneViewSource({
    projection: options.projection || {},
    viewOptions: options.viewOptions || {},
    buildSnapshot: () =>
      buildControlPaneSnapshot({
        repoRoot,
        dbPath: resolvedConfig.dbPath,
        stateDbPath: resolvedConfig.stateDbPath,
        config: resolvedConfig,
        allowActions,
        includeProximity: true,
        proximityOptions: options.proximityOptions
      })
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (!isAllowedHostHeader(req.headers.host, allowedHostnames)) {
        sendJson(res, 421, { ok: false, error: 'Misdirected request' });
        return;
      }
      if (!isAllowedOrigin(req.headers.origin, allowedHostnames, `http://${req.headers.host}`)) {
        sendJson(res, 403, { ok: false, error: 'Forbidden origin' });
        return;
      }

      const requestUrl = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === 'GET' && requestUrl.pathname === '/') {
        sendText(res, 200, renderControlPaneHtml(), 'text/html; charset=utf-8');
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === '/assets/ecc-icon.svg') {
        const iconPath = path.join(repoRoot, 'assets', 'ecc-icon.svg');
        if (!fs.existsSync(iconPath)) {
          sendText(res, 404, 'not found');
          return;
        }
        sendText(res, 200, fs.readFileSync(iconPath, 'utf8'), 'image/svg+xml; charset=utf-8');
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          repoRoot,
          dbPath: resolvedConfig.dbPath,
          stateDbPath: resolvedConfig.stateDbPath,
          allowActions
        });
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === '/api/snapshot') {
        const snapshot = await buildControlPaneSnapshot({
          repoRoot,
          dbPath: resolvedConfig.dbPath,
          stateDbPath: resolvedConfig.stateDbPath,
          config: resolvedConfig,
          query: requestUrl.searchParams.get('query') || baseQuery,
          limit: requestUrl.searchParams.get('limit') || 12,
          allowActions
        });
        sendJson(res, 200, snapshot);
        return;
      }

      // 3D agent-airspace visualization (Layer 4 observability).
      if (req.method === 'GET' && requestUrl.pathname === '/proximity') {
        sendText(res, 200, renderProximityVizHtml(), 'text/html; charset=utf-8');
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === '/api/proximity') {
        const snapshot = await buildControlPaneSnapshot({
          repoRoot,
          dbPath: resolvedConfig.dbPath,
          stateDbPath: resolvedConfig.stateDbPath,
          config: resolvedConfig,
          allowActions,
          includeProximity: true
        });
        sendJson(res, 200, snapshot.proximity || { enabled: true, advisories: [], positions: [], links: [], counts: {} });
        return;
      }

      // Control-plane live view: 2D projection + advisory events + inventory.
      if (req.method === 'GET' && requestUrl.pathname === '/control-plane') {
        sendText(res, 200, renderControlPlaneViewHtml(), 'text/html; charset=utf-8');
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === '/api/control-plane') {
        sendJson(res, 200, await viewSource.build());
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === '/api/control-plane/events') {
        const view = await viewSource.build();
        sendJson(res, 200, {
          schemaVersion: view.schemaVersion,
          generatedAt: view.generatedAt,
          thresholds: view.thresholds,
          events: view.events,
          counts: { events: view.counts.events, advisories: view.counts.advisories, resolutions: view.counts.resolutions }
        });
        return;
      }

      const actionMatch = requestUrl.pathname.match(/^\/api\/actions\/([^/]+)$/);
      if (req.method === 'POST' && actionMatch) {
        if (!allowActions) {
          sendJson(res, 403, {
            ok: false,
            error: 'Control-pane action execution is disabled by --read-only.'
          });
          return;
        }

        const body = await readRequestJson(req);
        const action = buildControlPaneAction(decodeURIComponent(actionMatch[1]), {
          repoRoot,
          query: body.query || baseQuery,
          limit: body.limit || 25
        });

        if (!action.executable) {
          sendJson(res, 400, {
            ok: false,
            action: action.id,
            error: 'This action is copy-only and cannot be executed from the browser.',
            commandLine: action.commandLine
          });
          return;
        }

        const result = await runAction(action);
        sendJson(res, result.ok ? 200 : 500, {
          ...result,
          commandLine: action.commandLine
        });
        return;
      }

      // Interactive JIT board: claim / move a work item from the browser.
      const claimMatch = requestUrl.pathname.match(/^\/api\/work-items\/([^/]+)\/claim$/);
      const moveMatch = requestUrl.pathname.match(/^\/api\/work-items\/([^/]+)\/move$/);
      if (req.method === 'POST' && (claimMatch || moveMatch)) {
        if (!allowActions) {
          sendJson(res, 403, {
            ok: false,
            error: 'Board edits are disabled by --read-only.'
          });
          return;
        }
        const id = decodeURIComponent((claimMatch || moveMatch)[1]);
        const body = await readRequestJson(req);
        try {
          const result = await withStateStore(resolvedConfig.stateDbPath, store =>
            claimMatch
              ? claimWorkItem(store, {
                  id,
                  owner: body.owner,
                  assigneeKind: body.as || body.assigneeKind,
                  sessionId: body.sessionId
                })
              : moveWorkItem(store, { id, lane: body.lane })
          );
          sendJson(res, 200, { ok: true, ...result });
        } catch (mutationError) {
          sendJson(res, 400, { ok: false, error: mutationError.message });
        }
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      if (error.statusCode === 413) res.setHeader('connection', 'close');
      sendJson(res, error.statusCode || 500, {
        ok: false,
        error: error.message
      });
    }
  });

  return {
    get url() {
      const address = server.address();
      const actualPort = address && typeof address === 'object' ? address.port : port;
      const urlHost = host === '::1' ? '[::1]' : host;
      return `http://${urlHost}:${actualPort}`;
    },
    server,
    config: resolvedConfig,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host === '[::1]' ? '::1' : host, () => {
          server.off('error', reject);
          resolve(this);
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close(error => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  };
}

module.exports = {
  createControlPaneServer,
  parseArgs,
  runAction,
  isAllowedHostHeader,
  isAllowedOrigin,
  buildAllowedHostnames,
  usage
};
