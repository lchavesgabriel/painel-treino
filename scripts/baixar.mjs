// Baixa os dados da Garmin para data/ de forma incremental.
// Uso: node scripts/baixar.mjs [--tudo] [--fc-desde=AAAA-MM-DD]
//   normal: em cada conjunto, rebaixa desde 7 dias antes da ultima data com dado ate hoje;
//           atividades e detalhes de natacao so das novas.
//   --tudo: refaz o historico completo de todos os conjuntos.
//   --fc-desde: dia mais antigo da frequencia cardiaca; se informado, preenche os dias que faltam desde ele.
// Tudo e gravado em data/.staging e so substitui data/ se a execucao terminar sem nenhum erro.
// Imprime so progresso, datas e contagens, nunca valores de saude.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { ApiError, createClient, describeError, ROOT, sleep } from './garmin.mjs';

const DATA = join(ROOT, 'data');
const STAGE = join(DATA, '.staging');
const OLD = join(DATA, '.antigo');
const WINDOW_DAYS = 28;
const LOOKBACK_DAYS = 7;
const EMPTY_WINDOWS_TO_STOP = 3;
const MAX_CONSECUTIVE_FAILURES = 5;
const RETRY_WAIT_MS = 5000;
const GRID_EPOCH = '2000-01-03'; // blocos fixos de 28 dias: o mesmo arquivo vale entre execucoes
const DEFAULT_HEART_RATE_FROM = '2026-07-01';
const TZ = 'America/Sao_Paulo';

const args = process.argv.slice(2);
const FULL = args.includes('--tudo');
const fcArg = args.find((a) => a.startsWith('--fc-desde='));
const heartRateFrom = fcArg ? fcArg.slice('--fc-desde='.length) : DEFAULT_HEART_RATE_FROM;
const unknown = args.filter((a) => a !== '--tudo' && !a.startsWith('--fc-desde='));
if (unknown.length || !/^\d{4}-\d{2}-\d{2}$/.test(heartRateFrom) || Number.isNaN(Date.parse(`${heartRateFrom}T00:00:00Z`))) {
  console.error('Uso: node scripts/baixar.mjs [--tudo] [--fc-desde=AAAA-MM-DD]');
  process.exit(1);
}

const DAY_MS = 86400000;
const toMs = (day) => Date.parse(`${day}T00:00:00Z`);
const addDays = (day, n) => new Date(toMs(day) + n * DAY_MS).toISOString().slice(0, 10);
const span = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY_MS) + 1;
const short = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const gridStart = (date) => addDays(GRID_EPOCH, Math.floor((toMs(date) - toMs(GRID_EPOCH)) / DAY_MS / WINDOW_DAYS) * WINDOW_DAYS);
const rowDate = (row) => row?.calendarDate ?? row?.date ?? null;

const asArray = (value) => (Array.isArray(value) ? value : []);
const RANGE_DATASETS = [
  { name: 'stress', label: 'estresse', build: (a, b) => [`/usersummary-service/stats/stress/daily/${a}/${b}`], rows: asArray,
    hasData: (r) => r.values?.overallStressLevel > 0 },
  { name: 'steps', label: 'passos', build: (a, b) => [`/usersummary-service/stats/steps/daily/${a}/${b}`], rows: asArray,
    hasData: (r) => r.totalSteps > 0 },
  { name: 'hydration', label: 'hidratacao', build: (a, b) => [`/usersummary-service/stats/hydration/daily/${a}/${b}`], rows: asArray,
    hasData: (r) => r.valueInML > 0 },
  { name: 'hrv', label: 'hrv', build: (a, b) => [`/hrv-service/hrv/daily/${a}/${b}`], rows: (json) => asArray(json?.hrvSummaries),
    hasData: (r) => r.lastNightAvg != null },
  { name: 'sleep', label: 'sono', build: (a, b) => ['/sleep-service/sleep/dailySleepSummariesByDate', { startDate: a, endDate: b }], rows: asArray,
    hasData: (r) => r.calendarDate != null && r.sleepTimeSeconds > 0 },
  { name: 'body-battery', label: 'body battery', build: (a, b) => ['/wellness-service/wellness/bodyBattery/reports/daily', { startDate: a, endDate: b }], rows: asArray,
    hasData: (r) => r.charged > 0 || r.drained > 0 },
  { name: 'daily-summaries', label: 'resumo diario', build: (a, b) => ['/usersummary-service/v2/dailysummaries', { startDate: a, endDate: b }], rows: (json) => asArray(json?.data),
    hasData: (r) => r.includesWellnessData === true },
];

const problems = [];
const report = [];
const lastRun = { modo: FULL ? 'tudo' : 'incremental', hoje: today, conjuntos: {} };

// ---------- arquivos: leitura de data/ (ou do staging, se ja escrito nesta execucao) ----------
const readJsonFile = (path) => JSON.parse(readFileSync(path, 'utf8'));
function readCurrent(rel) {
  const staged = join(STAGE, rel);
  if (existsSync(staged)) return readJsonFile(staged);
  const live = join(DATA, rel);
  return !FULL && existsSync(live) ? readJsonFile(live) : null;
}
function writeStage(rel, value) {
  const path = join(STAGE, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
const jsonNames = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []);
function currentNames(name) {
  const names = new Set(jsonNames(join(STAGE, name)));
  if (!FULL) for (const f of jsonNames(join(DATA, name))) names.add(f);
  return [...names].sort();
}

// ---------- requisicoes: "sem dado" nao e erro; erro real tenta de novo 1 vez ----------
class Abort extends Error {}
async function request(label, call, { splittable = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call(); // corpo vazio ou 204 ja voltam como null
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      if (splittable && error instanceof ApiError && error.status === 400) throw error;
      if (error instanceof ApiError && error.status === 429) throw new Abort(`${label}: ${describeError(error)} (limite persistente)`);
      if (attempt >= 2) {
        if (error instanceof ApiError && [401, 403].includes(error.status)) throw new Abort(`${label}: ${describeError(error)}`);
        throw Object.assign(error, { label });
      }
      console.log(`  ${label}: ${describeError(error)}; tentando de novo em ${RETRY_WAIT_MS / 1000} s`);
      await sleep(RETRY_WAIT_MS);
    }
  }
}
function problem(dataset, target, error) {
  if (error instanceof Abort) throw error;
  problems.push({ conjunto: dataset, alvo: target, erro: describeError(error) });
  console.log(`  PROBLEMA em ${dataset} ${target}: ${describeError(error)}`);
}

async function fetchRows(client, ds, start, end) {
  try {
    const json = await request(`${ds.label} ${start}..${end}`, () => client.get(...ds.build(start, end)), { splittable: start < end });
    return json == null ? [] : ds.rows(json);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 400 || start >= end) throw error;
    const left = Math.floor((toMs(end) - toMs(start)) / DAY_MS / 2);
    const first = await fetchRows(client, ds, start, addDays(start, left));
    return first.concat(await fetchRows(client, ds, addDays(start, left + 1), end));
  }
}

// ---------- atividades e natacao ----------
async function downloadActivities(client) {
  const live = FULL ? [] : (readCurrent('activities.json') ?? []);
  const known = new Set(live.map((a) => a.activityId));
  const incremental = live.length > 0;
  const pageSize = incremental ? 20 : 100;
  const fresh = [];
  for (let start = 0; ; start += pageSize) {
    const page = (await request(`atividades pagina ${start}`, () => client.get('/activitylist-service/activities/search/activities', { start, limit: pageSize }))) ?? [];
    const firstKnown = page.findIndex((a) => known.has(a.activityId));
    fresh.push(...(firstKnown < 0 ? page : page.slice(0, firstKnown)));
    if (firstKnown >= 0 || page.length < pageSize) break;
  }
  const all = [...fresh, ...live];
  if (fresh.length || FULL) writeStage('activities.json', all);
  const days = fresh.map((a) => a.startTimeLocal?.slice(0, 10)).filter(Boolean).sort();
  report.push({ conjunto: 'atividades', intervalo: days.length ? `${short(days[0])} a ${short(days.at(-1))}` : '-', pedidos: '-', baixados: fresh.length, 'sem dado': '-' });
  lastRun.conjuntos.activities = { novas: fresh.length, desde: days[0] ?? null };
  console.log(`atividades: ${fresh.length} ${incremental ? 'novas' : 'baixadas'}, ${all.length} no total`);
  return { all, fresh };
}

async function downloadSwims(client, all, fresh) {
  const isSwim = (a) => a.activityType?.typeKey?.includes('swim');
  const freshIds = new Set(fresh.map((a) => a.activityId));
  const targets = all.filter((a) => isSwim(a) && (FULL || freshIds.has(a.activityId) || !existsSync(join(DATA, 'swim-details', `${a.activityId}.json`))));
  let saved = 0;
  let empty = 0;
  for (const swim of targets) {
    try {
      const json = await request(`natacao ${swim.activityId}`, () => client.get(`/activity-service/activity/${swim.activityId}`));
      if (json == null) empty++;
      else {
        writeStage(`swim-details/${swim.activityId}.json`, json);
        saved++;
      }
    } catch (error) {
      problem('detalhes de natacao', `atividade de ${swim.startTimeLocal?.slice(0, 10) ?? '?'}`, error);
    }
  }
  const days = targets.map((a) => a.startTimeLocal?.slice(0, 10)).filter(Boolean).sort();
  report.push({ conjunto: 'natacao (detalhe)', intervalo: days.length ? `${short(days[0])} a ${short(days.at(-1))}` : '-', pedidos: targets.length, baixados: saved, 'sem dado': empty });
  console.log(`natacao: ${saved} detalhes baixados de ${targets.length} pedidos`);
}

// ---------- conjuntos por intervalo ----------
function lastDateWithData(ds) {
  let last = null;
  for (const file of jsonNames(join(DATA, ds.name))) {
    for (const row of readJsonFile(join(DATA, ds.name, file)).rows ?? []) {
      const date = rowDate(row);
      if (date && ds.hasData(row) && (!last || date > last)) last = date;
    }
  }
  return last;
}
function mergeRows(ds, rows) {
  const byWindow = new Map();
  for (const row of rows) {
    const date = rowDate(row);
    if (!date) continue;
    const start = gridStart(date);
    if (!byWindow.has(start)) byWindow.set(start, new Map());
    byWindow.get(start).set(date, row);
  }
  for (const [start, fresh] of byWindow) {
    const rel = `${ds.name}/${start}.json`;
    const current = readCurrent(rel) ?? { start, end: start, rows: [] };
    const merged = new Map(current.rows.filter((r) => rowDate(r)).map((r) => [rowDate(r), r]));
    for (const [date, row] of fresh) merged.set(date, row); // substitui por data, sem duplicar
    const dates = [...merged.keys()].sort();
    const end = [current.end, dates.at(-1)].sort().at(-1);
    writeStage(rel, { start, end, rows: dates.map((d) => merged.get(d)) });
  }
}
async function refreshRange(client, ds, from) {
  const rows = [];
  for (let start = from; start <= today; start = addDays(start, WINDOW_DAYS)) {
    const end = addDays(start, WINDOW_DAYS - 1) > today ? today : addDays(start, WINDOW_DAYS - 1);
    try {
      rows.push(...(await fetchRows(client, ds, start, end)));
    } catch (error) {
      problem(ds.label, `${start} a ${end}`, error);
    }
  }
  mergeRows(ds, rows);
  const withData = new Set(rows.filter(ds.hasData).map(rowDate));
  report.push({ conjunto: ds.label, intervalo: `${short(from)} a ${short(today)}`, pedidos: span(from, today), baixados: withData.size, 'sem dado': span(from, today) - withData.size });
  lastRun.conjuntos[ds.name] = { desde: from, ate: today };
}
async function walkRange(client, ds, floor) {
  let failures = 0;
  let emptyStreak = 0;
  let requested = 0;
  let withData = 0;
  let oldest = today;
  for (let start = gridStart(today); ; start = addDays(start, -WINDOW_DAYS)) {
    const end = addDays(start, WINDOW_DAYS - 1) > today ? today : addDays(start, WINDOW_DAYS - 1);
    try {
      const rows = await fetchRows(client, ds, start, end);
      writeStage(`${ds.name}/${start}.json`, { start, end, rows });
      failures = 0;
      requested += span(start, end);
      oldest = start;
      const found = rows.filter(ds.hasData).length;
      withData += found;
      emptyStreak = found ? 0 : emptyStreak + 1;
    } catch (error) {
      problem(ds.label, `${start} a ${end}`, error);
      if (++failures >= MAX_CONSECUTIVE_FAILURES) break;
      continue;
    }
    if (start <= floor && emptyStreak >= EMPTY_WINDOWS_TO_STOP) break;
  }
  report.push({ conjunto: ds.label, intervalo: `${short(oldest)} a ${short(today)}`, pedidos: requested, baixados: withData, 'sem dado': requested - withData });
  lastRun.conjuntos[ds.name] = { desde: oldest, ate: today, completo: true };
}
function currentDatesWithData(ds) {
  const dates = new Set();
  for (const file of currentNames(ds.name)) {
    for (const row of readCurrent(`${ds.name}/${file}`)?.rows ?? []) if (rowDate(row) && ds.hasData(row)) dates.add(rowDate(row));
  }
  return [...dates].sort();
}

// ---------- conjuntos por dia ----------
async function downloadDaily(client, name, label, dependencyDates, apiPath, { backfillFrom = null } = {}) {
  const liveFiles = FULL ? [] : jsonNames(join(DATA, name)).map((f) => f.replace('.json', ''));
  const last = liveFiles.sort().at(-1);
  let targets;
  if (FULL || !last) {
    targets = dependencyDates;
  } else {
    const from = addDays(last, -LOOKBACK_DAYS);
    const have = new Set(liveFiles);
    targets = dependencyDates.filter((d) => (d >= from && d <= today) || (backfillFrom && d >= backfillFrom && !have.has(d)));
  }
  let saved = 0;
  let empty = 0;
  for (const date of targets) {
    try {
      const json = await request(`${label} ${date}`, () => client.get(apiPath, { date }));
      if (json == null) empty++;
      else {
        writeStage(`${name}/${date}.json`, json);
        saved++;
      }
    } catch (error) {
      problem(label, date, error);
    }
    if (targets.length > 50 && (saved + empty) % 50 === 0) console.log(`${label}: ${saved + empty}/${targets.length}`);
  }
  const range = targets.length ? `${short(targets[0])} a ${short(targets.at(-1))}` : '-';
  report.push({ conjunto: label, intervalo: range, pedidos: targets.length, baixados: saved, 'sem dado': empty });
  lastRun.conjuntos[name] = { desde: targets[0] ?? null, ate: targets.at(-1) ?? null };
}

// ---------- troca: so depois de terminar sem erro ----------
function stagedFiles(dir = STAGE) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? stagedFiles(path) : [path];
  });
}
// No --tudo, as pastas de cada conjunto sao trocadas inteiras; o resto, arquivo a arquivo.
const SWAPPED_DIRS = new Set([...RANGE_DATASETS.map((d) => d.name), 'sleep-detail', 'heart-rate', 'swim-details']);
function commit() {
  rmSync(OLD, { recursive: true, force: true });
  if (FULL) {
    for (const entry of readdirSync(STAGE).filter((e) => SWAPPED_DIRS.has(e))) {
      const dst = join(DATA, entry);
      if (existsSync(dst)) {
        mkdirSync(OLD, { recursive: true });
        renameSync(dst, join(OLD, entry));
      }
      renameSync(join(STAGE, entry), dst);
    }
  }
  for (const src of stagedFiles()) {
    const dst = join(DATA, relative(STAGE, src));
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(src, dst);
  }
  rmSync(OLD, { recursive: true, force: true });
  rmSync(STAGE, { recursive: true, force: true });
}

// ---------- execucao ----------
rmSync(STAGE, { recursive: true, force: true }); // sobra de execucao anterior que nao terminou
mkdirSync(STAGE, { recursive: true });
let aborted = null;
try {
  const client = await createClient();
  console.log(`Token: gerado com sucesso. Modo: ${FULL ? 'historico completo (--tudo)' : 'incremental'}`);

  const { all, fresh } = await downloadActivities(client);
  const floor = all.map((a) => a.startTimeLocal?.slice(0, 10)).filter(Boolean).sort()[0] ?? today;

  for (const ds of RANGE_DATASETS) {
    const last = FULL ? null : lastDateWithData(ds);
    if (last) await refreshRange(client, ds, addDays(last, -LOOKBACK_DAYS));
    else await walkRange(client, ds, floor);
    console.log(`${ds.label}: ok`);
  }

  await downloadSwims(client, all, fresh);
  await downloadDaily(client, 'sleep-detail', 'sono detalhado', currentDatesWithData(RANGE_DATASETS.find((d) => d.name === 'sleep')), '/sleep-service/sleep/dailySleep');
  console.log(`Frequencia cardiaca diaria a partir de ${heartRateFrom}`);
  await downloadDaily(client, 'heart-rate', 'frequencia cardiaca',
    currentDatesWithData(RANGE_DATASETS.find((d) => d.name === 'daily-summaries')).filter((d) => d >= heartRateFrom),
    '/wellness-service/wellness/dailyHeartRate', { backfillFrom: fcArg ? heartRateFrom : null });
} catch (error) {
  aborted = error instanceof Abort ? error.message : `${error.label ? `${error.label}: ` : ''}${describeError(error)}`;
}

console.log('\n=== RESUMO ===');
console.table(report);
const daily = report.filter((r) => r.conjunto !== 'atividades' && r.conjunto !== 'natacao (detalhe)');
const totalDays = daily.reduce((s, r) => s + (Number(r.baixados) || 0), 0);
const starts = daily.map((r) => r.intervalo).filter((i) => i !== '-').map((i) => i.split(' a '));
if (starts.length) {
  const toIso = (d) => d.split('/').reverse().join('-');
  const first = starts.map(([a]) => toIso(a)).sort()[0];
  const lastDay = starts.map(([, b]) => toIso(b)).sort().at(-1);
  console.log(`Total: ${totalDays} dias com dado baixados (somando os conjuntos), entre ${short(first)} e ${short(lastDay)}.`);
}

if (aborted || problems.length) {
  rmSync(STAGE, { recursive: true, force: true });
  if (aborted) console.log(`EXECUCAO INTERROMPIDA: ${aborted}`);
  console.log(`Problemas: ${problems.length}`);
  for (const p of problems) console.log(`  ${p.conjunto} | ${p.alvo} | ${p.erro}`);
  console.log('data/ NAO foi alterado. Rode de novo para tentar outra vez.');
  process.exitCode = 1;
} else {
  writeStage('errors.json', []);
  writeStage('summary.json', { atualizadoEm: new Date().toISOString(), ...lastRun });
  writeStage('.verificacao/ultima-execucao.json', lastRun);
  commit();
  console.log('Problemas: 0. data/ atualizado.');
}
