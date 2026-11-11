# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

The LibreChat deployment scaffold exists (Docker Compose, `librechat.yaml`, the adapter-naming shim), plus a second deployment path for a RunPod Pod with no Docker daemon (`deploy/runpod/`, see [DEPLOY_RUNPOD.md](DEPLOY_RUNPOD.md)) that runs the same pieces as native processes under pm2 instead. LibreChat itself is **not vendored** either way — Docker pulls the official `ghcr.io/danny-avila/librechat` image; the RunPod path `git clone`s LibreChat's own repo into `librechat/` at deploy time (gitignored, never committed here). The only first-party code in this repo is `shim/` (plain Node, no dependencies) and the `deploy/runpod/` bootstrap tooling. See [README.md](README.md) for setup/onboarding and its "Known limitations" section for what's not built yet (structured risk-card UI with the NFR-8 disclaimer, FR-9 defensive-parse indicator, per-consultant access control, automated SYSTEM_PROMPT sync).

## Commands

```sh
cp .env.example .env              # then fill in secrets + FINSCALE_VLLM_BASE_URL
cp config/clients.example.json config/clients.json   # then edit client->adapter mappings
docker compose up -d --build      # start mongodb, shim, api (LibreChat on :3080)
docker compose restart shim       # after editing config/clients.json
docker compose logs -f shim       # shim request log (JSON lines: forward_request, forward_response, errors)
node --check shim/server.js       # syntax-check the shim (no test suite exists yet)

# Run the shim directly for fast iteration (no Docker, no LibreChat/Mongo needed):
SHIM_PORT=4000 FINSCALE_VLLM_BASE_URL=http://localhost:8000/v1 \
  FINSCALE_CLIENTS_CONFIG=./config/clients.json node shim/server.js

# RunPod native deployment (no Docker) — see DEPLOY_RUNPOD.md for full context:
bash deploy/runpod/bootstrap.sh    # installs Node/Mongo/pm2, clones+builds LibreChat, starts everything
node --check deploy/runpod/ecosystem.config.js
bash -n deploy/runpod/bootstrap.sh
```

There is no automated test suite yet. When adding one, it should target
`shim/server.js` first (model-name lookup, error responses, upstream
forwarding) since that's the only first-party logic in the repo.

## What this project is

**FinScale Consulting Console** — a private, self-hosted chat application built on **LibreChat** (Node.js/React, MongoDB, Docker Compose) that lets a financial consulting firm's staff interact with the firm's own fine-tuned FinScale model(s) to classify SEC-filing risk disclosures for clients. The intended UI is a structured risk-assessment card (category, severity, evidence, explanation) instead of raw JSON — not yet built, see README's "Known limitations".

## Architectural boundary: this repo is a pure API consumer

This project is **separate from and must never duplicate** `FinscaleNvidiaPlatform` (a sibling repo, referenced as `../FinscaleNvidiaPlatform`, not forked or vendored here). That repo trains, evaluates, and serves the model; this app only talks to it over the network. Concretely:

- The sibling repo's `scripts/serve_vllm.py` runs a vLLM OpenAI-compatible server (`--enable-lora`) hosting one base model plus N per-customer LoRA adapters. There is no per-customer endpoint — the adapter is selected by setting `"model": "<adapter-name>"` in the chat completion request.
- This repo must contain **no training, fine-tuning, data-pipeline, or EDGAR-ingestion code**. If a task seems to require any of that, it belongs in `FinscaleNvidiaPlatform` instead.

`shim/server.js` is intentionally zero-dependency plain Node (`http` + built-in `fetch`, no Express, no `npm install` step). It is stateless: `config/clients.json` is re-read from disk on every `/v1/models` and `/v1/chat/completions` request rather than cached, so edits take effect without restarting the shim — but it fails fast (`process.exit(1)`) at startup if that file is missing or malformed, rather than serving an empty model list.

### Request/response contract (REQUIREMENTS.md §2)

A two-message chat completion request:
- `system`: `train.py`'s `SYSTEM_PROMPT` constant, **verbatim** — must be kept in sync via a sync process (script or fetched endpoint), never hand-copied and left to drift (§9/INT-2).
- `user`: ticker + filing excerpt.

The response is *expected but not guaranteed* to be a single JSON object with `category` (`market|credit|liquidity|operational|regulatory_legal|cybersecurity|supply_chain|other`), `severity` (`low|medium|high`), `evidence`, and `explanation`. Guided/constrained decoding is not assumed to be active on the serving side, so **all parsing of model output must be defensive** (FR-9): attempt JSON parse, and on failure show the raw text with a visible "could not parse" indicator — never silently drop or fabricate fields.

## Non-negotiable constraints

- **No third-party LLM traffic** (NFR-3): filing excerpts, client identities, and conversation content must never leave firm-controlled infrastructure — only the configured FinScale endpoint, no OpenAI/Anthropic/etc. keys in LibreChat config.
- **Env-configured endpoint** (INT-1): the serving endpoint's base URL (and API key, if one is added) must be environment-configured, never hardcoded — values differ across local/staging/production GPU hosts.
- **Mandatory disclaimer** (NFR-8): every rendered risk card must visibly state the output is a preliminary AI-generated aid, not certified financial/legal advice. This is a hard requirement given the consulting-firm/compliance context.
- **No adapter-mixing mid-conversation** (FR-6): switching the selected client/adapter starts a new conversation rather than changing the model within an existing thread.
- **Client↔adapter mapping stays in sync** (§11/INT-3): `config/clients.json` must match the `--lora NAME=PATH` registrations actually live on `serve_vllm.py`. This repo does not control the serving side and must not assume it. The mapping is enforced at runtime by `shim/server.js`, which LibreChat talks to instead of vLLM directly (see README's "Why the shim exists") — do not point `FINSCALE_SHIM_BASE_URL` at vLLM directly, or FR-5's human-readable model picker breaks.

## Non-goals (v1)

- Model training/fine-tuning/evaluation (stays in `FinscaleNvidiaPlatform`).
- Automated SEC/EDGAR filing ingestion — consultants paste/upload excerpts manually.
- A client-facing (external, non-employee) portal — internal consultants only for this version.
- Guaranteeing valid JSON from the model — graceful degradation is the design, not a fix for the model's output.
