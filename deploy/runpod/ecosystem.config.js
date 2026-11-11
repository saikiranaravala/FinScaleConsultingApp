#!/usr/bin/env node
/**
 * pm2 process definitions for the RunPod native (no-Docker) deployment.
 * See ../../DEPLOY_RUNPOD.md. Does NOT manage scripts/serve_vllm.py — that
 * belongs to the sibling FinscaleNvidiaPlatform repo and stays out of this
 * repo's control (CLAUDE.md "pure API consumer" boundary).
 *
 * Usage: pm2 start deploy/runpod/ecosystem.config.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ENV_PATH = process.env.FINSCALE_ENV_FILE || path.join(REPO_ROOT, '.env');
const MONGO_DATA_DIR = process.env.FINSCALE_MONGO_DATA_DIR || '/workspace/FinScaleChat-data/mongo';

function loadEnvFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) {
    console.error(`[ecosystem.config.js] WARNING: ${filePath} not found; starting with no FinScale env vars.`);
    return env;
  }
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

const env = loadEnvFile(ENV_PATH);

module.exports = {
  apps: [
    {
      name: 'finscale-mongo',
      script: 'mongod',
      args: `--dbpath ${MONGO_DATA_DIR} --bind_ip 127.0.0.1 --port 27017 --noauth`,
      autorestart: true,
      env,
    },
    {
      name: 'finscale-shim',
      cwd: path.join(REPO_ROOT, 'shim'),
      script: 'server.js',
      interpreter: 'node',
      autorestart: true,
      env,
    },
    {
      name: 'finscale-librechat',
      cwd: path.join(REPO_ROOT, 'librechat'),
      script: 'npm',
      args: 'run backend',
      autorestart: true,
      env,
    },
  ],
};
