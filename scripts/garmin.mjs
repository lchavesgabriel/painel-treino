// Cliente minimo da API pessoal do Garmin Connect.
// Regras: chave e token nunca sao impressos nem gravados; so GET nos endpoints
// da lista abaixo (a unica excecao e o POST que gera o token).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BASE_URL = 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
const ALLOWED_GET_PREFIXES = [
  '/userprofile-service/userprofile/settings',
  '/activitylist-service/activities/search/activities',
  '/sleep-service/sleep/dailySleepSummariesByDate',
  '/hrv-service/hrv/daily/',
  '/usersummary-service/stats/stress/daily/',
  '/usersummary-service/stats/steps/daily/',
  '/wellness-service/wellness/bodyBattery/reports/daily',
  '/usersummary-service/v2/dailysummaries',
  '/usersummary-service/stats/hydration/daily/',
  '/sleep-service/sleep/dailySleep',
  '/wellness-service/wellness/dailyHeartRate',
];
const ALLOWED_GET_PATTERNS = [/^\/activity-service\/activity\/\d+$/];
const isAllowed = (path) =>
  ALLOWED_GET_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
  ALLOWED_GET_PATTERNS.some((pattern) => pattern.test(path));

const PAUSE_MS = 1500;
const MAX_429_RETRIES = 5;
const DEFAULT_429_WAIT_S = 60;
const TIMEOUT_MS = 30000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ApiError extends Error {
  constructor(status, label) {
    // So status e rota: o corpo da resposta pode conter dados pessoais.
    super(`HTTP ${status} em ${label}`);
    this.status = status;
  }
}

const secrets = new Set();

// Texto de erro seguro para imprimir: mascara chave/token e inclui a causa.
export function describeError(error) {
  const cause = error.cause ? ` (causa: ${error.cause.code ?? '?'}: ${error.cause.message})` : '';
  let text = `${error.message}${cause}`;
  for (const secret of secrets) text = text.split(secret).join('***');
  return text;
}

// Valida e registra a chave para ser mascarada em qualquer texto de erro.
function acceptKey(key) {
  secrets.add(key);
  if (/[^\x21-\x7e]/.test(key)) {
    throw new Error('GARMIN_API_KEY tem caractere invalido (espaco, controle ou fora do ASCII)');
  }
  return key;
}

function loadApiKey() {
  // Na nuvem (GitHub Actions) a chave vem de um segredo, na variavel de ambiente; no computador, de .env.local.
  const fromEnv = (process.env.GARMIN_API_KEY ?? '').trim();
  if (fromEnv) return acceptKey(fromEnv);
  let bytes;
  try {
    bytes = readFileSync(join(ROOT, '.env.local'));
  } catch {
    throw new Error('Nao consegui abrir .env.local');
  }
  const isUtf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  const text = bytes.toString(isUtf16 ? 'utf16le' : 'utf8').replace(/^﻿/, '');
  const match = text.match(/^\s*(?:export\s+)?GARMIN_API_KEY\s*=\s*(.*)$/m);
  const key = match ? match[1].trim().replace(/^(['"])(.*)\1$/, '$2') : '';
  if (!key) throw new Error('GARMIN_API_KEY ausente ou vazia em .env.local');
  return acceptKey(key);
}

// Faz a requisicao, esperando e repetindo em caso de 429.
async function request(url, options, label) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status !== 429) return response;
    if (attempt >= MAX_429_RETRIES) throw new ApiError(429, label);
    const retryAfter = Number(response.headers.get('retry-after'));
    const base = retryAfter > 0 ? retryAfter : DEFAULT_429_WAIT_S * 2 ** attempt;
    console.log(`  429 em ${label}: aguardando ${base}s`);
    await sleep(base * 1000);
  }
}

export async function createClient() {
  const response = await request(
    BASE_URL + TOKEN_PATH,
    { method: 'POST', headers: { Authorization: `ApiKey ${loadApiKey()}`, Accept: '*/*' } },
    'geracao do token',
  );
  if (!response.ok) throw new ApiError(response.status, 'geracao do token');
  const token = (await response.text()).trim();
  if (!token) throw new Error('Resposta do token veio vazia');
  secrets.add(token);

  return {
    async get(path, query = {}) {
      if (!isAllowed(path)) throw new Error(`Endpoint fora da lista permitida: ${path}`);
      const url = new URL(BASE_URL + path);
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
      await sleep(PAUSE_MS);
      const res = await request(
        url,
        { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
        path,
      );
      if (!res.ok) throw new ApiError(res.status, path);
      const body = await res.text();
      return body ? JSON.parse(body) : null;
    },
  };
}
