// Gera data/painel.html a partir de data/. So le arquivos locais.
// O HTML leva apenas o que o painel mostra: nada de IDs, nomes, coordenadas ou zonas GPS.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './garmin.mjs';

const DATA = join(ROOT, 'data');
const TEMPLATE = join(ROOT, 'scripts', 'painel-template.html');
const TZ = 'America/Sao_Paulo';

const CATEGORIES = {
  lap_swimming: 'natacao',
  open_water_swimming: 'natacao',
  strength_training: 'musculacao',
  soccer: 'futebol',
  indoor_cardio: 'cardio',
  running: 'corrida',
  treadmill_running: 'corrida',
  indoor_running: 'corrida',
  cycling: 'ciclismo',
  indoor_cycling: 'ciclismo',
};

const dateTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
const toLocal = (gmt) => dateTime.format(new Date(`${gmt.replace(' ', 'T')}Z`));

// Minutos desde o meio-dia em Sao Paulo: 23:30 e 00:30 ficam a 60 minutos de distancia.
function bedtimeFromNoon(timestampGmt) {
  if (!Number.isFinite(timestampGmt)) return null;
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(timestampGmt));
  const [hours, minutes] = clock.split(':').map(Number);
  return (hours * 60 + minutes + 720) % 1440;
}

// Metricas de natacao para o treinador: SWOLF, bracadas por piscina, cadencia, FC media e segundos em cada zona (Z1 a Z5).
function swimMetrics(a) {
  const out = {};
  if (a.averageSwolf > 0) out.sw = Math.round(a.averageSwolf);
  if (a.avgStrokes > 0) out.st = Math.round(a.avgStrokes * 10) / 10;
  if (a.averageSwimCadenceInStrokesPerMinute > 0) out.cad = Math.round(a.averageSwimCadenceInStrokesPerMinute);
  if (a.averageHR > 0) out.hr = Math.round(a.averageHR);
  if (a.trainingEffectLabel) out.te = a.trainingEffectLabel; // rotulo de esforco do Garmin (ex.: AEROBIC_BASE, TEMPO)
  const zones = [1, 2, 3, 4, 5].map((n) => Math.round(a[`hrTimeInZone_${n}`] ?? 0));
  if (zones.some((s) => s > 0)) out.z = zones;
  return out;
}

// Metricas dos outros tipos para o indicador de desempenho: FC media; cadencia na corrida;
// series, repeticoes, volume (kg) e carga maxima por exercicio (kg) na musculacao.
function otherMetrics(a, cat) {
  const out = {};
  if (a.averageHR > 0) out.hr = Math.round(a.averageHR);
  if (cat === 'corrida' && a.averageRunningCadenceInStepsPerMinute > 0) out.cad = Math.round(a.averageRunningCadenceInStepsPerMinute);
  if (cat === 'musculacao') {
    if (a.totalSets > 0) out.sets = a.totalSets;
    if (a.totalReps > 0) out.reps = a.totalReps;
    const exercises = Array.isArray(a.summarizedExerciseSets) ? a.summarizedExerciseSets : [];
    const volume = exercises.reduce((sum, e) => sum + (e.volume ?? 0), 0) / 1000; // gramas -> kg
    if (volume > 0) out.vol = Math.round(volume);
    // Por exercicio (categoria do Garmin), somando as entradas repetidas do mesmo treino: [series, repeticoes, carga maxima kg, volume kg].
    const byExercise = {};
    for (const e of exercises) {
      if (!e.category) continue;
      const cur = (byExercise[e.category] ??= [0, 0, 0, 0]);
      cur[0] += e.sets ?? 0;
      cur[1] += e.reps ?? 0;
      cur[2] = Math.max(cur[2], Math.round((e.maxWeight ?? 0) / 100) / 10);
      cur[3] += Math.round((e.volume ?? 0) / 1000);
    }
    if (Object.keys(byExercise).length) out.ex = byExercise;
    if (a.activityName) out.nm = a.activityName; // nome do treino (Treino 1, 2, 3...), so no seu computador
  }
  return out;
}

function readWindows(name) {
  const dir = join(DATA, name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .flatMap((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).rows);
}

export function buildDataset() {
  const days = {};
  const day = (date) => (days[date] ??= {});

  for (const r of readWindows('sleep')) {
    if (!r.calendarDate || !(r.sleepTimeSeconds > 0)) continue;
    day(r.calendarDate).sleep = {
      score: r.sleepScores?.overall?.value ?? null,
      bed: bedtimeFromNoon(r.sleepStartTimestampGMT),
      sec: r.sleepTimeSeconds,
      deep: r.deepSleepSeconds, rem: r.remSleepSeconds, light: r.lightSleepSeconds, awake: r.awakeSleepSeconds,
    };
  }
  for (const r of readWindows('hydration')) {
    if (r.valueInML > 0) day(r.calendarDate).water = { ml: Math.round(r.valueInML), goal: r.goalInML ?? null };
  }
  for (const r of readWindows('hrv')) {
    if (r.lastNightAvg != null) day(r.calendarDate).hrv = r.lastNightAvg;
  }
  for (const r of readWindows('stress')) {
    if (r.values?.overallStressLevel > 0) day(r.calendarDate).stress = r.values.overallStressLevel;
  }
  for (const r of readWindows('daily-summaries')) {
    if (r.bodyBattery?.maxValue > 0) day(r.calendarDate).battery = r.bodyBattery.maxValue;
  }

  let timezoneShifted = 0;
  const raw = JSON.parse(readFileSync(join(DATA, 'activities.json'), 'utf8'));
  const activities = raw.map((a) => {
    const local = toLocal(a.startTimeGMT);
    if (a.startTimeLocal?.slice(0, 10) !== local.slice(0, 10)) timezoneShifted++;
    return {
      d: local.slice(0, 10), t: local.slice(11, 16),
      cat: CATEGORIES[a.activityType?.typeKey] ?? 'outros',
      sec: Math.round(a.duration ?? 0),
      m: a.distance > 0 ? Math.round(a.distance) : 0,
      // Tamanho da piscina em metros (a lista traz em cm); so natacao em piscina tem.
      ...(CATEGORIES[a.activityType?.typeKey] === 'natacao' && a.poolLength > 0 ? { pl: Math.round(a.poolLength / 100) } : {}),
      // Tempo em movimento (sem pausas), usado no ritmo da natacao como o Garmin Connect mostra.
      ...(CATEGORIES[a.activityType?.typeKey] === 'natacao' && a.movingDuration > 0 ? { mv: Math.round(a.movingDuration) } : {}),
      ...(CATEGORIES[a.activityType?.typeKey] === 'natacao' ? swimMetrics(a) : otherMetrics(a, CATEGORIES[a.activityType?.typeKey] ?? 'outros')),
      // Musculacao de pernas: so um marcador (o nome do treino nao vai para o painel).
      ...(CATEGORIES[a.activityType?.typeKey] === 'musculacao' && /inferior|perna|leg|gl[uú]te|quadr|coxa/i.test(a.activityName ?? '') ? { lw: 1 } : {}),
    };
  }).sort((a, b) => `${a.d}${a.t}`.localeCompare(`${b.d}${b.t}`));

  const first = [...Object.keys(days), ...activities.map((a) => a.d)].sort()[0];
  const generatedAt = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }).format(new Date());
  return { dataset: { generatedAt, first, days, activities }, timezoneShifted };
}

export function writeHtml(dataset, outPath) {
  const json = JSON.stringify(dataset).replace(/</g, '\\u003c');
  const template = readFileSync(TEMPLATE, 'utf8');
  if (!template.includes('"__DADOS__"')) throw new Error('Marcador de dados ausente no modelo');
  const tmp = `${outPath}.tmp`;
  writeFileSync(tmp, template.replace('"__DADOS__"', () => json));
  renameSync(tmp, outPath);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { dataset, timezoneShifted } = buildDataset();
  writeHtml(dataset, join(DATA, 'painel.html'));
  const values = Object.values(dataset.days);
  const count = (test) => values.filter(test).length;
  console.log('Painel gerado em data/painel.html');
  console.log(`Inicio dos dados: ${dataset.first}`);
  console.table({
    sono: count((d) => d.sleep),
    'sono com score': count((d) => d.sleep?.score != null),
    hidratacao: count((d) => d.water),
    hrv: count((d) => d.hrv != null),
    estresse: count((d) => d.stress != null),
    'body battery': count((d) => d.battery != null),
    atividades: dataset.activities.length,
    'atividades com data diferente apos converter o fuso': timezoneShifted,
  });
}
