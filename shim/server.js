#!/usr/bin/env node
/**
 * FinScale adapter-naming shim.
 *
 * LibreChat talks to this server as if it were the OpenAI-compatible vLLM
 * endpoint. It serves two jobs REQUIREMENTS.md assigns to a "name-mapping
 * layer" (FR-5, INT-3) that serve_vllm.py itself has no concept of:
 *
 *   - GET  /v1/models           -> human-readable client display names,
 *                                   read live from clients.json, so the
 *                                   LibreChat model picker never shows raw
 *                                   adapter paths.
 *   - POST /v1/chat/completions -> rewrites `model` from a display name back
 *                                   to the real --lora adapter name (or base
 *                                   model id) before forwarding to the real
 *                                   vLLM server at FINSCALE_VLLM_BASE_URL.
 *
 * It does not add auth, retries, or rate limiting — NFR-1's private-network
 * isolation is assumed, and R-4 (whether an auth layer is needed in front of
 * the serving endpoint) is still an open question per REQUIREMENTS.md §12.
 */
'use strict';

const http = require('http');
const fs = require('fs');

const PORT = Number(process.env.SHIM_PORT || 4000);
const VLLM_BASE_URL = (process.env.FINSCALE_VLLM_BASE_URL || 'http://localhost:8000/v1').replace(/\/+$/, '');
const VLLM_API_KEY = process.env.FINSCALE_VLLM_API_KEY || '';
const CLIENTS_CONFIG_PATH = process.env.FINSCALE_CLIENTS_CONFIG || '/config/clients.json';

function loadClients() {
  const raw = fs.readFileSync(CLIENTS_CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.clients) || parsed.clients.length === 0) {
    throw new Error(`"clients" array is missing or empty in ${CLIENTS_CONFIG_PATH}`);
  }
  for (const c of parsed.clients) {
    if (!c.displayName || !c.adapter) {
      throw new Error(`each entry in ${CLIENTS_CONFIG_PATH} needs "displayName" and "adapter": ${JSON.stringify(c)}`);
    }
  }
  return parsed.clients;
}

// Fail fast and loudly at startup rather than silently serving an empty
// model list (FR-15: surface clear errors, don't swallow them).
try {
  const startupClients = loadClients();
  console.log(`[finscale-shim] loaded ${startupClients.length} client(s) from ${CLIENTS_CONFIG_PATH}`);
} catch (err) {
  console.error(`[finscale-shim] FATAL: could not load ${CLIENTS_CONFIG_PATH}: ${err.message}`);
  console.error('[finscale-shim] copy config/clients.example.json to config/clients.json and edit it.');
  process.exit(1);
}

function log(event, fields) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleModels(req, res) {
  let clients;
  try {
    clients = loadClients();
  } catch (err) {
    log('models_config_error', { error: err.message });
    return sendJson(res, 500, { error: { message: `FinScale shim config error: ${err.message}` } });
  }
  sendJson(res, 200, {
    object: 'list',
    data: clients.map((c) => ({ id: c.displayName, object: 'model', owned_by: 'finscale' })),
  });
}

async function handleChatCompletions(req, res) {
  let bodyBuf;
  try {
    bodyBuf = await readBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: { message: `failed to read request body: ${err.message}` } });
  }

  let payload;
  try {
    payload = JSON.parse(bodyBuf.toString('utf8') || '{}');
  } catch (err) {
    return sendJson(res, 400, { error: { message: 'request body is not valid JSON' } });
  }

  let clients;
  try {
    clients = loadClients();
  } catch (err) {
    log('chat_config_error', { error: err.message });
    return sendJson(res, 500, { error: { message: `FinScale shim config error: ${err.message}` } });
  }

  const requestedModel = payload.model;
  const match = clients.find((c) => c.displayName === requestedModel);
  if (!match) {
    const known = clients.map((c) => c.displayName).join(', ');
    log('unknown_model', { requestedModel });
    return sendJson(res, 400, {
      error: { message: `Unknown FinScale client "${requestedModel}". Known clients: ${known}` },
    });
  }

  const upstreamPayload = { ...payload, model: match.adapter };
  const isStream = Boolean(payload.stream);

  log('forward_request', { displayName: match.displayName, adapter: match.adapter, stream: isStream });

  let upstreamRes;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (VLLM_API_KEY) headers.Authorization = `Bearer ${VLLM_API_KEY}`;
    upstreamRes = await fetch(`${VLLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamPayload),
    });
  } catch (err) {
    // FR-15: surface a clear error when the backend is unreachable, rather
    // than an unexplained blank response.
    log('upstream_unreachable', { error: err.message, baseUrl: VLLM_BASE_URL });
    return sendJson(res, 502, {
      error: { message: `FinScale serving endpoint unreachable at ${VLLM_BASE_URL}: ${err.message}` },
    });
  }

  res.writeHead(upstreamRes.status, {
    'Content-Type': upstreamRes.headers.get('content-type') || 'application/json',
  });

  if (!upstreamRes.body) {
    const text = await upstreamRes.text();
    log('forward_response', { status: upstreamRes.status, stream: false });
    return res.end(text);
  }

  try {
    for await (const chunk of upstreamRes.body) {
      res.write(chunk);
    }
  } finally {
    log('forward_response', { status: upstreamRes.status, stream: isStream });
    res.end();
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return handleModels(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(req, res).catch((err) => {
      log('unhandled_error', { error: err.message });
      sendJson(res, 500, { error: { message: 'internal shim error' } });
    });
  }
  sendJson(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}` } });
});

server.listen(PORT, () => {
  console.log(`[finscale-shim] listening on :${PORT}, forwarding to ${VLLM_BASE_URL}`);
});
