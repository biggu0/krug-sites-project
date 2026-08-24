import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const sourceConfigPath = resolve('dist/server/wrangler.json');
const runtimeConfigPath = resolve('dist/server/wrangler.local.json');
const envPath = resolve('.env');

const workerEnvKeys = [
  'AUTH_COOKIE_SECURE',
  'TEMPLATE_STORAGE_PROVIDER',
  'TEMPLATE_STORAGE_DIR',
  'TENCENT_COS_SECRET_ID',
  'TENCENT_COS_SECRET_KEY',
  'TENCENT_COS_REGION',
  'TENCENT_COS_BUCKET',
  'TENCENT_COS_BASE_PATH',
  'TENCENT_COS_ENV_PREFIX',
  'TENCENT_COS_PROJECT_PREFIX',
  'TENCENT_COS_CDN_DOMAIN',
  'COS_SECRET_ID',
  'COS_SECRET_KEY',
  'COS_REGION',
  'COS_BUCKET',
  'COS_PREFIX',
  'COS_ENV_PREFIX',
  'COS_PROJECT_PREFIX',
  'COS_CDN_DOMAIN'
];

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const equalsAt = trimmed.indexOf('=');
  if (equalsAt === -1) return null;

  const key = trimmed.slice(0, equalsAt).trim();
  let value = trimmed.slice(equalsAt + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function loadDotEnv() {
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const entry = parseEnvLine(line);
    if (entry && process.env[entry.key] === undefined) process.env[entry.key] = entry.value;
  }
}

function buildWorkerVars(existingVars = {}) {
  const vars = { ...existingVars };
  for (const key of workerEnvKeys) {
    if (process.env[key] !== undefined) vars[key] = process.env[key];
  }

  vars.AUTH_COOKIE_SECURE = process.env.AUTH_COOKIE_SECURE ?? 'false';
  vars.TEMPLATE_STORAGE_PROVIDER = process.env.TEMPLATE_STORAGE_PROVIDER ?? 'cos';
  vars.TENCENT_COS_BASE_PATH = process.env.TENCENT_COS_BASE_PATH ?? process.env.COS_PREFIX ?? 'uploads/';
  vars.TENCENT_COS_ENV_PREFIX = process.env.TENCENT_COS_ENV_PREFIX ?? process.env.COS_ENV_PREFIX ?? 'test';
  vars.TENCENT_COS_PROJECT_PREFIX = process.env.TENCENT_COS_PROJECT_PREFIX ?? process.env.COS_PROJECT_PREFIX ?? 'calendar';
  return vars;
}

function assertCosVars(vars) {
  if ((vars.TEMPLATE_STORAGE_PROVIDER ?? 'cos').toLowerCase() !== 'cos') return;
  const required = [
    'TENCENT_COS_SECRET_ID',
    'TENCENT_COS_SECRET_KEY',
    'TENCENT_COS_REGION',
    'TENCENT_COS_BUCKET'
  ];
  const missing = required.filter((key) => !vars[key]);
  if (missing.length) {
    console.error(`COS 配置不完整，缺少：${missing.join(', ')}`);
    console.error('请确认本地 .env 已配置后再运行 npm run start:worker。');
    process.exit(1);
  }
}

function writeRuntimeConfig() {
  if (!existsSync(sourceConfigPath)) {
    console.error('找不到 dist/server/wrangler.json，请先运行 npm run build。');
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(sourceConfigPath, 'utf8'));
  config.vars = buildWorkerVars(config.vars);
  assertCosVars(config.vars);

  mkdirSync(dirname(runtimeConfigPath), { recursive: true });
  writeFileSync(runtimeConfigPath, JSON.stringify(config, null, 2));

  const prefix = [
    config.vars.TENCENT_COS_PROJECT_PREFIX,
    config.vars.TENCENT_COS_ENV_PREFIX,
    config.vars.TENCENT_COS_BASE_PATH
  ].filter(Boolean).join('/').replace(/\/+/g, '/');
  console.log(`Worker 本地配置已生成：${runtimeConfigPath}`);
  console.log(`模板存储：${config.vars.TEMPLATE_STORAGE_PROVIDER}，COS 路径：${prefix}`);
}

function secretValues() {
  return [
    process.env.TENCENT_COS_SECRET_ID,
    process.env.TENCENT_COS_SECRET_KEY,
    process.env.COS_SECRET_ID,
    process.env.COS_SECRET_KEY
  ].filter((value) => value && value.length >= 8);
}

function redactOutput(chunk) {
  let text = chunk.toString();
  for (const value of secretValues()) text = text.split(value).join('***');
  return text;
}

loadDotEnv();
writeRuntimeConfig();

const port = process.env.PORT || '3000';
const args = [
  'dev',
  '--config',
  runtimeConfigPath,
  '--ip',
  '0.0.0.0',
  '--port',
  port,
  '--show-interactive-dev-session',
  'false'
];
if (process.env.WRANGLER_PERSIST_TO) args.push('--persist-to', process.env.WRANGLER_PERSIST_TO);

const wrangler = spawn(
  'wrangler',
  args,
  { stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, AUTH_COOKIE_SECURE: 'false' } }
);

wrangler.stdout.on('data', (chunk) => process.stdout.write(redactOutput(chunk)));
wrangler.stderr.on('data', (chunk) => process.stderr.write(redactOutput(chunk)));

process.on('SIGINT', () => wrangler.kill('SIGINT'));
process.on('SIGTERM', () => wrangler.kill('SIGTERM'));

wrangler.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
