# FinScale Consulting Console

Private, self-hosted LibreChat deployment that lets consulting-firm staff query
the firm's fine-tuned FinScale model(s) to classify SEC-filing risk
disclosures. Full requirements: [REQUIREMENTS.md](REQUIREMENTS.md). Guidance
for Claude Code / contributors: [CLAUDE.md](CLAUDE.md).

This repo does **not** contain model training/serving code — that lives in
the sibling [`FinscaleNvidiaPlatform`](../FinscaleNvidiaPlatform) repo. This
app only talks to its `scripts/serve_vllm.py` endpoint over the network.

## Architecture

```
┌─────────────────────┐   HTTPS   ┌──────────────────────────────────────┐
│ Consultant's browser │ ────────▶ │ FinScale Consulting Console           │
└─────────────────────┘           │  - LibreChat (frontend + API)         │
                                   │  - MongoDB (conversation history)     │
                                   │  - shim (adapter-name translation)    │
                                   └───────────────┬────────────────────────┘
                                                    │ OpenAI-compatible
                                                    │ /v1/chat/completions
                                                    │ (private network only)
                                                    ▼
                                   ┌──────────────────────────────────────┐
                                   │ FinscaleNvidiaPlatform GPU host       │
                                   │ scripts/serve_vllm.py                 │
                                   │ base model + N LoRA adapters          │
                                   └──────────────────────────────────────┘
```

**Why the shim exists:** `serve_vllm.py` selects an adapter by its raw
`--lora NAME=PATH` name (e.g. `customer_a`), but FR-5 requires the LibreChat
model picker to show human-readable client names (e.g. "Acme Capital"). The
shim (`shim/`) is a small reverse proxy that LibreChat talks to instead of
vLLM directly: it serves `/v1/models` from [`config/clients.json`](config/clients.example.json)
(so the dropdown shows display names) and rewrites `model` back to the real
adapter name before forwarding each `/v1/chat/completions` call to
`FINSCALE_VLLM_BASE_URL`. See `shim/server.js`.

## Setup

Two deployment paths, depending on the host:

- **Docker host** (steps below): needs Docker + Docker Compose.
- **RunPod Pod alongside FinscaleNvidiaPlatform** (no Docker daemon available
  inside the Pod): see [DEPLOY_RUNPOD.md](DEPLOY_RUNPOD.md) instead — same
  app, installed as native processes (Node/MongoDB/pm2) and talking to
  `serve_vllm.py` over loopback on the same Pod.

Prerequisites for the Docker path: Docker + Docker Compose, and a running
`serve_vllm.py` endpoint somewhere this host can reach privately (NFR-1).

1. `cp .env.example .env` and fill in:
   - `CREDS_KEY` / `CREDS_IV` / `JWT_SECRET` / `JWT_REFRESH_SECRET` (generate with `openssl rand -hex 32`, `CREDS_IV` with `-hex 16`)
   - `FINSCALE_VLLM_BASE_URL` — the real `serve_vllm.py` host (e.g. `http://gpu-host:8000/v1`)
2. `cp config/clients.example.json config/clients.json` and edit it to match
   the `--lora NAME=PATH` adapters actually registered on that host.
3. `docker compose up -d --build`
4. Open `http://localhost:3080`, register the first consultant account (then
   set `ALLOW_REGISTRATION=false` and restart, per FR-2), select "FinScale"
   as the endpoint, pick a client, and paste a filing excerpt.

## Onboarding a new client (§11 runbook)

1. On the GPU host: add `--lora <name>=<path>` to the `serve_vllm.py` launch
   command and restart the serving process (adapters are fixed at launch —
   R-2).
2. In this repo: add `{ "displayName": "...", "adapter": "<name>" }` to
   `config/clients.json`.
3. `docker compose restart shim` — no LibreChat or Mongo restart needed; the
   model list is fetched live from the shim on each page load.

## Known limitations / open items (carried from REQUIREMENTS.md §12)

- **No structured risk-card UI yet.** Responses currently render as LibreChat's
  normal assistant message (raw JSON text), not the category/severity/evidence
  card described in FR-10, and the NFR-8 compliance disclaimer is not yet
  rendered anywhere. Building that requires customizing LibreChat's message
  component (a frontend fork or plugin) — out of scope for this
  infrastructure pass. Defensive parsing (FR-9) is also not yet implemented
  anywhere in the UI; today a malformed JSON response just shows as plain text,
  which happens to satisfy "never silently drop" but doesn't yet add the
  "could not parse" indicator FR-9 asks for.
- **Per-consultant adapter access control (R-1)** is not enforced — any
  logged-in consultant can select any client in `clients.json`. Per FR-3's
  documented fallback, this currently relies on policy + the shim's request
  logs (`forward_request` events), not a technical restriction.
- **SYSTEM_PROMPT sync (INT-2)** is manual: copy it from
  `../FinscaleNvidiaPlatform/train.py`'s `SYSTEM_PROMPT` constant into
  LibreChat's preset/prompt config for the FinScale endpoint. No automated
  sync script exists yet — if `train.py` changes, this must be updated by
  hand until INT-2 is automated.
- **No auth in front of vLLM (R-4)** — relies entirely on network isolation
  (NFR-1). The shim does not add its own authentication layer.
- **Audit logging (FR-11)** is partial: the shim logs timestamp, selected
  client, and adapter for every request, but has no visibility into which
  consultant made the request (that identity lives in LibreChat/Mongo, not
  in requests reaching the shim). Joining the two is not yet implemented.
