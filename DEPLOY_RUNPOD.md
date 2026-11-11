# Deploying on the same RunPod Pod as FinscaleNvidiaPlatform

Runs this app (LibreChat + shim) and the FinScale serving process
(`serve_vllm.py`) side by side on **one** RunPod Pod, talking over loopback —
no Docker, since RunPod's GPU/ML pod templates don't run a Docker daemon
inside the container (same assumption `FinscaleNvidiaPlatform`'s own
`runpod-start.sh`/`RunPod_14B_Training.md` make: everything there is a plain
process in a venv, never a container). If your Pod image genuinely does have
a working `docker compose`, use the root [docker-compose.yml](docker-compose.yml)
instead and skip this doc.

```
/workspace/                        <- RunPod persistent network volume
  FinscaleNvidiaPlatform/           <- already there; serve_vllm.py, out/adapters_*
  FinScaleChat-data/mongo/          <- created below; LibreChat's Mongo data
  FinScaleChat-config/              <- created below; .env + clients.json (secrets)
/FinScaleChat/                      <- NEW, sibling to /workspace, THIS repo cloned here
  librechat/                        <- LibreChat's own source, cloned at deploy time
  shim/, config/, deploy/runpod/, ...
```

## ⚠️ Read this before you start

`/FinScaleChat` sits on the Pod's **container disk**, not the `/workspace`
network volume — it does **not** survive the Pod being stopped/terminated and
recreated (only `/workspace` does). That's fine for the app code itself (a
`git clone` away), but conversation history and secrets would be lost if they
lived there too. So this guide deliberately keeps two things under
`/workspace` instead, and symlinks them into `/FinScaleChat`:
- `/workspace/FinScaleChat-data/mongo` — LibreChat's MongoDB data (conversation
  history; NFR-4 treats this as confidential).
- `/workspace/FinScaleChat-config/{.env,clients.json}` — secrets and the
  client→adapter mapping (§11).

If the Pod's disk does get wiped, redeploying is: re-clone the repo, re-run
`bootstrap.sh` (it re-links the two files above automatically), done — you do
not lose conversation history or have to redo config.

## 1. Clone this repo onto the Pod

In the Pod's terminal (via RunPod's web terminal or SSH):

```bash
git clone https://github.com/saikiranaravala/FinScaleConsultingApp.git /FinScaleChat
cd /FinScaleChat
```

## 2. Confirm FinScale adapters already exist

```bash
ls -lh /workspace/FinscaleNvidiaPlatform/out/adapters* 2>/dev/null
```

If nothing's there, train first — that's `FinscaleNvidiaPlatform`'s own
`RunPod_14B_Training.md`, not this repo's job (architectural boundary in
[CLAUDE.md](CLAUDE.md)).

## 3. Start (or confirm) `serve_vllm.py`

This repo doesn't manage this step — it's entirely on the FinScale side. Use a
`tmux`/`screen` session so it survives your terminal disconnecting:

```bash
tmux new -s finscale-serve
cd /workspace/FinscaleNvidiaPlatform
source .venv/bin/activate
python scripts/serve_vllm.py --model Qwen/Qwen2.5-14B-Instruct \
  --lora customer_a=out/adapters_customer_a \
  --lora customer_b=out/adapters_customer_b
# Ctrl+B then D to detach, leaving it running.
```

Use the **exact** `--lora NAME=...` names you register here when editing
`clients.json` in step 5 — they must match (INT-3).

## 4. Bootstrap Node/MongoDB/LibreChat

```bash
cd /FinScaleChat
bash deploy/runpod/bootstrap.sh
```

First run installs Node (via nvm) + MongoDB + pm2, then stops itself after
copying two templates it needs you to edit:
- `/workspace/FinScaleChat-config/.env`
- `/workspace/FinScaleChat-config/clients.json`

## 5. Edit the config it just created

```bash
nano /workspace/FinScaleChat-config/.env
#   - generate CREDS_KEY/CREDS_IV/JWT_SECRET/JWT_REFRESH_SECRET (openssl rand -hex 32/16/32/32)
#   - FINSCALE_VLLM_BASE_URL is already http://127.0.0.1:8000/v1 (same Pod) — leave as is
#     unless you started serve_vllm.py on a different port

nano /workspace/FinScaleChat-config/clients.json
#   - replace the example entries with real { "displayName": ..., "adapter": ... }
#     pairs matching the --lora names from step 3
```

## 6. Re-run bootstrap to actually start everything

```bash
bash deploy/runpod/bootstrap.sh
pm2 status
pm2 logs --lines 50
```

You should see `finscale-mongo`, `finscale-shim`, and `finscale-librechat` all
`online`. If `finscale-librechat` is crash-looping, check `pm2 logs
finscale-librechat` — most often a missing/short `CREDS_KEY`/`CREDS_IV` (must
be exactly 64/32 hex chars).

## 7. Expose port 3080 to your browser

RunPod Pods aren't reachable on arbitrary ports by default. In the RunPod
console: **your Pod → Edit Pod → expose HTTP Port → 3080**, then use the
"Connect" button's generated `https://<pod-id>-3080.proxy.runpod.net` URL.
Don't expose 8000 (vLLM), 4000 (shim), or 27017 (Mongo) — those should only be
reachable from inside the Pod (NFR-1).

## 8. First login, then lock the door

Open the proxy URL, register the first consultant account, then:

```bash
sed -i 's/ALLOW_REGISTRATION=true/ALLOW_REGISTRATION=false/' /workspace/FinScaleChat-config/.env
pm2 restart finscale-librechat
```

(FR-2 — no open registration after the first account exists.)

## 9. Verify end-to-end

In the UI: select the "FinScale" endpoint, pick a client from the dropdown
(these come live from the shim's `/v1/models`, not a static list — see
README's "Why the shim exists"), paste a filing excerpt, send. A reply means
the full chain (browser → LibreChat → shim → serve_vllm.py → LoRA adapter)
is connected.

## After a Pod restart

`/FinScaleChat`'s installed Node/Mongo/pm2 state lives on the ephemeral disk
and will be gone. Re-run:

```bash
git clone https://github.com/saikiranaravala/FinScaleConsultingApp.git /FinScaleChat
cd /FinScaleChat && bash deploy/runpod/bootstrap.sh
```

It relinks your existing `/workspace/FinScaleChat-config/*` files
automatically, so no re-editing needed, and Mongo's data directory
(`/workspace/FinScaleChat-data/mongo`) still has your conversation history.
You'll still need to restart `serve_vllm.py` yourself (step 3) — that process
isn't persisted either.

See README.md's "Known limitations" for what this deployment still doesn't
do (structured risk-card UI, per-consultant access control, etc.) — unrelated
to RunPod specifically, same gaps on any host.
