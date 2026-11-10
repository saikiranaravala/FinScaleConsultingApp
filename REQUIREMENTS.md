# FinScale Consulting Console — Requirements

**Status:** Draft v0.1
**Owner:** saikiran.aravala@gmail.com
**Depends on:** [FinscaleNvidiaPlatform](../FinscaleNvidiaPlatform) (the model/training/serving repo — not forked into this project, called over the network)

---

## 1. Overview

A private, self-hosted chat application — built on **LibreChat** — that lets a financial
consulting firm's consultants interact with the firm's own fine-tuned FinScale model(s) to
analyze SEC-filing risk disclosures for their clients. This is a **separate application/repo**
from `FinscaleNvidiaPlatform`: that repo trains, evaluates, and serves the model; this project
is purely a consumer of the model's OpenAI-compatible API. No training, data-pipeline, or model
code lives here.

### 1.1 Why LibreChat

LibreChat is a mature, self-hostable, open-source ChatGPT-style application (Node.js/React,
MongoDB, Docker Compose) with native support for pointing at a custom OpenAI-compatible
endpoint instead of OpenAI's own API — which is exactly the shape of
`scripts/serve_vllm.py` in the platform repo. It was chosen over the alternatives considered
(Open WebUI, AnythingLLM, Dify) specifically for this project; re-litigating that choice is out
of scope here.

### 1.2 What it's replacing

Today, querying the fine-tuned model means running `scripts/query_vllm_client.py` from a
terminal — a one-shot CLI script with no history, no multi-user support, and no concept of
"which client's adapter am I talking to." This app is the production-usable replacement for
that script.

---

## 2. Background: what this app talks to

`FinscaleNvidiaPlatform` already provides everything this app needs on the backend side; this
project must not duplicate it.

- **Serving layer:** `scripts/serve_vllm.py` launches a vLLM OpenAI-compatible server
  (`vllm.entrypoints.openai.api_server`) with `--enable-lora`, hosting one base model (e.g.
  `Qwen/Qwen2.5-14B-Instruct`) plus N hot-swappable per-customer LoRA adapters registered via
  repeated `--lora NAME=PATH` flags. A request selects which adapter answers it purely by
  setting `"model": "<NAME>"` in the chat completion request — there is no separate endpoint
  per customer. Default port `8000`, API surface at `/v1/chat/completions` (and vLLM's standard
  `/v1/models` listing).
- **Request/response contract** (see `scripts/query_vllm_client.py` for the reference
  implementation): a two-message chat request —
  ```json
  {
    "model": "<customer-adapter-name-or-base-model-id>",
    "messages": [
      {"role": "system", "content": "<SYSTEM_PROMPT, verbatim from train.py>"},
      {"role": "user", "content": "Ticker: <TICKER>\nFiling excerpt:\n<excerpt text>"}
    ],
    "max_tokens": 384,
    "temperature": 0
  }
  ```
- **Output contract:** the assistant message content is (ideally) a single JSON object, no
  markdown fencing, with exactly these keys:
  ```json
  {"category": "market|credit|liquidity|operational|regulatory_legal|cybersecurity|supply_chain|other",
   "severity": "low|medium|high",
   "evidence": "<verbatim substring of the input excerpt>",
   "explanation": "<brief justification>"}
  ```
  **This is not guaranteed to be valid JSON** unless the serving layer is also running with
  guided/constrained decoding — base-model and even fine-tuned generations can emit malformed
  JSON, markdown fences, or extra prose. This app must treat the response as untrusted text to
  parse defensively, not a guaranteed structured payload.
- **System prompt source of truth:** `train.py`'s `SYSTEM_PROMPT` constant. This app must not
  hardcode its own copy that can drift from it — see §9 (Integration Requirements).

---

## 3. Goals

1. Give consulting-firm staff a persistent, multi-turn chat interface against the firm's own
   fine-tuned model(s), running entirely on infrastructure the firm controls.
2. Support **one adapter per client engagement**, selectable per conversation, matching
   `serve_vllm.py`'s existing per-customer LoRA design — no backend changes required to add a
   new client, only a new `--lora NAME=PATH` entry and (see §11) a config update here.
3. Render the model's JSON output as a readable risk-assessment card (category / severity /
   evidence / explanation), not a raw JSON blob, while still surfacing the raw text for
   consultants who want to verify it.
4. Keep all filing excerpts, client identities, and conversation history inside firm-controlled
   infrastructure — nothing routed through a third-party LLM API.

## 4. Non-Goals (for this version)

- Training, fine-tuning, or evaluating models — that stays in `FinscaleNvidiaPlatform`.
- A client-facing (external, non-employee) portal. This version is for internal consultant use
  only; an external client portal is a possible future phase (§14) with materially different
  auth/liability requirements and is explicitly deferred.
- Automated SEC filing ingestion inside this app — consultants paste/upload excerpts; bulk
  ingestion is the training repo's `download_edgar.py` pipeline, not this app's concern.
- Guaranteeing valid JSON from the model. If guided decoding isn't running on the serving side,
  this app degrades gracefully (§8.3) rather than pretending it can fix the model's output.

---

## 5. Users & Personas

| Persona | Description | Primary needs |
|---|---|---|
| **Consultant** | Firm employee analyzing a client's filings | Fast chat access to the correct client's model, readable risk output, conversation history per client |
| **Firm Admin** | IT/ops person managing the deployment | Add/remove client adapters, manage consultant accounts, monitor backend health |

A **Client** (the consulting firm's own customer) persona is explicitly out of scope for this
version — see §4 and §14.

---

## 6. Functional Requirements

### 6.1 Authentication & Access
- FR-1: Consultants authenticate with firm-managed accounts (LibreChat's built-in local auth at
  minimum; SSO/LDAP if the firm already has an identity provider — **to be confirmed with the
  firm's IT, not assumed**).
- FR-2: No anonymous/guest access. LibreChat's registration must be disabled or invite-only.
- FR-3: (Needs validation against the deployed LibreChat version — see Risk R-1) Ideally, a
  given consultant can be restricted to only the client adapters they're engaged on, not every
  registered adapter. If LibreChat's access-control feature set can't enforce this at the time
  of implementation, the fallback is a documented policy (consultants only select clients
  they're authorized for) plus audit logging (FR-10) — not a hard technical block.

### 6.2 Client/Model Selection
- FR-4: Each conversation is associated with exactly one "model" (= one client's LoRA adapter,
  or the base model for general/non-client-specific queries).
- FR-5: The model picker's labels must be human-readable client names, not raw adapter
  directory paths — requires a name-mapping layer between `serve_vllm.py`'s `--lora NAME=...`
  registration and what's shown in the UI (see §11).
- FR-6: Switching the selected model mid-conversation should start a new conversation, not
  silently mix adapters within one thread — avoids a consultant unknowingly getting client B's
  adapter's answer inside a client A conversation.

### 6.3 Chat & Analysis
- FR-7: A consultant can paste a filing excerpt (and optionally a ticker) and receive a
  classification response, following the request shape in §2.
- FR-8: The app must build the request using `train.py`'s `SYSTEM_PROMPT` verbatim (via the
  sync process in §9), not a hand-maintained copy.
- FR-9: The raw model response is parsed defensively (attempt JSON parse; on failure, display
  the raw text with a visible "could not parse structured output" indicator — never silently
  drop or fabricate fields).
- FR-10: Successfully parsed responses render as a structured card: category, severity (with a
  visual severity indicator — e.g. color-coded low/medium/high), the evidence excerpt
  (ideally highlighted against the original pasted text), and the explanation.
- FR-11: Every request/response pair is logged with timestamp, consultant identity, and
  selected client/model — this is the audit trail backing the access-control fallback in FR-3.

### 6.4 Conversation History
- FR-12: Standard LibreChat conversation persistence (per-user conversation list, search,
  rename, delete) — no custom requirement beyond what LibreChat already provides.
- FR-13: Conversations are tagged/filterable by the client/model they were run against (depends
  on whether LibreChat's existing conversation metadata supports this natively or needs light
  customization — flag during implementation, don't assume).

### 6.5 Admin / Operations
- FR-14: Firm Admin can see which client adapters are currently registered on the serving
  backend (reflecting `serve_vllm.py`'s `--lora` flags) without SSHing into the GPU host —
  minimum viable version: a documented manual process (admin updates a config file here when a
  new adapter is deployed); a live `/v1/models` status page is a nice-to-have, not a hard
  requirement for v1.
- FR-15: Basic health check: the app should surface (not silently swallow) a clear error state
  when the backend vLLM endpoint is unreachable or returns an error, rather than an unexplained
  blank response.

---

## 7. Non-Functional Requirements

### 7.1 Security & Privacy
- NFR-1: All traffic between this app and the vLLM serving endpoint stays on firm-controlled
  network (VPN/private network/firewall rules) — the serving endpoint must never be exposed on
  the open internet without authentication in front of it.
- NFR-2: All traffic between consultants' browsers and this app's frontend is TLS-encrypted.
- NFR-3: No filing excerpt, client name, or conversation content is ever sent to a third-party
  LLM API. (This should be true by construction — LibreChat is configured with only the custom
  FinScale endpoint, no OpenAI/Anthropic/etc. keys — but must be explicitly verified in
  deployment config, not just assumed from "we didn't configure one.")
- NFR-4: Conversation history (MongoDB) is only as sensitive as the filing excerpts and client
  names it contains — SEC 10-K filings are public documents, but *which client the firm is
  analyzing which risk for* is itself confidential business information. Treat the database
  backup/access policy accordingly.

### 7.2 Performance
- NFR-5: No hard latency SLA is set in this version — response time is bounded by the
  underlying GPU's generation speed (see `FinscaleNvidiaPlatform`'s own `gpu_monitor.py` data
  for realistic per-request timing at a given model size). This app should show a visible
  "generating" state rather than appearing frozen during what may be a multi-second wait.
- NFR-6: Switching between client adapters on the same base model should not require reloading
  the full base model (this is vLLM's `--enable-lora` hot-swap behavior already — this app just
  must not do anything that defeats it, e.g. don't spin up a separate server per client).

### 7.3 Availability
- NFR-7: This app has a hard dependency on the GPU serving host being up. There is currently no
  redundancy/failover story for that host (RunPod/AWS pods are single instances per
  `FinscaleNvidiaPlatform`'s own docs) — document this as a known limitation, not something this
  app's architecture needs to solve.

### 7.4 Compliance & Liability
- NFR-8: Every risk-assessment card rendered by this app must carry a visible disclaimer that
  outputs are a **preliminary, AI-generated classification aid**, not certified financial or
  legal advice, and not a substitute for consultant judgment — consistent with
  `FinscaleNvidiaPlatform`'s own documented status ("results so far are small-sample/
  preliminary, not production benchmarks"). This is a hard requirement, not a nice-to-have,
  given the consulting-firm context.
- NFR-9: (Open item, not yet answered) Whether any additional regulatory requirements apply
  (e.g., recordkeeping obligations typical of registered investment advisers) needs input from
  the firm's compliance function — this document does not assume an answer.

---

## 8. System Architecture

```
┌─────────────────────────┐      HTTPS       ┌──────────────────────────┐
│  Consultant's browser    │ ───────────────▶ │  FinScale Consulting     │
│                           │                   │  Console (this project)  │
└─────────────────────────┘                   │  - LibreChat frontend    │
                                                │  - LibreChat API/backend │
                                                │  - MongoDB (history)     │
                                                └────────────┬─────────────┘
                                                              │ OpenAI-compatible
                                                              │ /v1/chat/completions
                                                              │ (private network only)
                                                              ▼
                                                ┌──────────────────────────┐
                                                │  FinscaleNvidiaPlatform   │
                                                │  GPU host (RunPod/AWS)    │
                                                │  scripts/serve_vllm.py    │
                                                │  base model + N LoRA      │
                                                │  adapters (per client)    │
                                                └──────────────────────────┘
```

This app is deployed and versioned independently of `FinscaleNvidiaPlatform`. The only coupling
is the network call to the serving endpoint's URL (configurable, see §11) and the system-prompt
sync process (§9).

---

## 9. Integration Requirements with FinScale Platform

- INT-1: The serving endpoint's base URL and API key (if any auth is added in front of it) are
  environment-configured in this app, never hardcoded — different values for local dev,
  staging, and whatever production GPU host is active at a given time (RunPod today, possibly
  AWS later per the platform repo's own multi-environment story).
- INT-2: `SYSTEM_PROMPT` must be kept in sync with `train.py`'s definition. Two acceptable
  approaches, to be decided at implementation time:
  (a) a small sync script that copies the constant from the platform repo into this app's
  config at build/deploy time, or
  (b) this app fetches it from a tiny read-only endpoint the platform repo exposes. Whichever
  is chosen, **hand-copying it once and letting it drift is not acceptable** — a prompt change
  on the training side must not silently desync from what this app sends.
- INT-3: The client-name-to-adapter-name mapping (FR-5) must be kept in sync with whatever
  `--lora NAME=PATH` registrations are actually live on `serve_vllm.py` — document the process
  for updating both sides when a new client adapter ships (see FR-14).
- INT-4: This app must not assume guided/constrained JSON decoding is active on the serving
  side (it's optional per the platform's `evaluate.py --guided-json` equivalent story for
  vLLM) — defensive parsing (FR-9) is mandatory regardless.

---

## 10. Deployment

- DEP-1: Standard LibreChat Docker Compose deployment (frontend, API, MongoDB, and LibreChat's
  usual supporting services), configured via LibreChat's custom-endpoint mechanism
  (`librechat.yaml`) to point at the FinScale serving URL instead of/alongside any default
  OpenAI config.
- DEP-2: This project lives in its own repository, separate from `FinscaleNvidiaPlatform`. It
  may reference the platform repo (e.g. as documentation, or via the sync process in INT-2) but
  does not vendor or fork its code.
- DEP-3: Deployment target (same GPU host as the serving process, a separate small VM, etc.) is
  an open decision — not fixed by this document. The only hard constraint is NFR-1 (private
  network path to the serving endpoint).

---

## 11. Data/Config: Client → Adapter Mapping

A small config artifact (format TBD — likely a JSON/YAML file consumed by this app's LibreChat
config generation) mapping:

```
display name ("Acme Capital")  →  adapter name ("customer_a", matching --lora customer_a=...)
```

This is the single source of truth for FR-5/INT-3. Updating it is part of the "onboard a new
client" runbook, alongside training and deploying their adapter on the platform side.

---

## 12. Risks & Open Questions

| ID | Risk/Question | Impact | Notes |
|---|---|---|---|
| R-1 | Does LibreChat's access-control model actually support restricting specific users to specific custom-endpoint models? | Affects FR-3 | Must be validated against the LibreChat version chosen at implementation time, not assumed from this document |
| R-2 | What happens in the UI when a consultant selects a client whose adapter isn't currently loaded on the serving host? | UX/error handling | `serve_vllm.py` adapters are fixed at server launch (`--lora` flags) — adding a client requires a serving-side restart; this app should surface a clear error, not a silent failure |
| R-3 | Conversation-history retention policy | Compliance (NFR-9) | No answer yet from firm compliance |
| R-4 | Is any authentication/API-key layer needed in front of the vLLM endpoint itself, or is network isolation (NFR-1) sufficient? | Security | vLLM's OpenAI server has no built-in auth by default |
| R-5 | Multi-GPU / concurrent-request behavior of `serve_vllm.py` under multiple consultants querying simultaneously | Performance | Not yet load-tested on the platform side |

---

## 13. Phased Rollout

- **Phase 1 (MVP):** Single client adapter, internal pilot with a handful of consultants, no
  access-control enforcement beyond policy (R-1 resolved to "fallback" for now), manual
  client-adapter onboarding (§11 config updated by hand).
- **Phase 2:** Multiple client adapters live simultaneously, structured risk-card rendering
  (FR-10) polished, audit logging (FR-11) in place.
- **Phase 3:** Resolve R-1 properly (enforced per-consultant client access) and R-3 (retention
  policy) with firm compliance sign-off.
- **Phase 4 (not committed):** Client-facing external portal — requires a separate requirements
  pass given the different auth/liability profile (see §4).

---

## 14. Success Criteria (v1 / MVP)

- A consultant can log in, select a client, paste a filing excerpt, and receive a rendered
  risk-assessment card within one GPU-generation cycle, with no excerpt or client name ever
  leaving firm-controlled infrastructure.
- Switching clients produces a new conversation against the correct adapter, verified by
  spot-checking `serve_vllm.py`'s request logs against what the UI shows.
- Every response — well-formed JSON or not — is handled without the UI breaking or silently
  showing nothing.
