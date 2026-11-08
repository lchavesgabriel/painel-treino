// Publicacao na nuvem: criptografa o painel (e os dados, para o cache do GitHub Actions) com uma senha.
// Uso: node scripts/nuvem.mjs <comando> [opcoes]
//   senha                  gera uma senha forte aleatoria (mostrada so no seu terminal)
//   publicar               criptografa data/painel.html em site/index.html e os dados em cache-dados.enc
//   restaurar              descriptografa cache-dados.enc de volta para data/ (recusa se data/ ja existir, salvo --forcar)
// Opcoes: --raiz=<pasta> (padrao: a pasta do projeto)  --sem-dados (publicar so a pagina)  --forcar
// A senha vem da variavel de ambiente DASHBOARD_PASSWORD (minimo 16 caracteres). Nunca e impressa nem gravada.
// Formato: PBKDF2-SHA256 (600 mil iteracoes) + AES-256-GCM; a pagina decifra no navegador com a Web Crypto API.
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ROOT } from './garmin.mjs';

const ITERATIONS = 600000;
const MIN_PASSWORD = 16;
const [command, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(`--${name}`);
const option = (name) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = resolve(option('raiz') ?? ROOT);
const CACHE = join(root, 'cache-dados.enc');

const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const deriveKey = (password, salt, iterations) => pbkdf2Sync(password, salt, iterations, 32, 'sha256');

function encrypt(buffer, password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(password, salt, ITERATIONS), iv);
  const body = Buffer.concat([cipher.update(buffer), cipher.final(), cipher.getAuthTag()]); // texto cifrado + marca de 16 bytes, como a Web Crypto espera
  return { v: 1, iter: ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: body.toString('base64') };
}
function decrypt(payload, password) {
  const body = Buffer.from(payload.ct, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(password, Buffer.from(payload.salt, 'base64'), payload.iter), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
}
function needPassword() {
  const password = process.env.DASHBOARD_PASSWORD ?? '';
  if (password.length < MIN_PASSWORD) {
    fail(`Defina a variavel DASHBOARD_PASSWORD com pelo menos ${MIN_PASSWORD} caracteres (use "node scripts/nuvem.mjs senha" para gerar uma). A pagina publicada e publica; so a senha protege os dados.`);
  }
  return password;
}
function tar(args) {
  const result = spawnSync('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.status !== 0) fail(`tar falhou: ${String(result.stderr ?? '').trim().split('\n').slice(-2).join(' ')}`);
}

if (command === 'senha') {
  // Codigo facil de digitar no celular: 4 grupos de 4, sem letras que se confundem (i, l, o, 0, 1). ~79 bits de aleatoriedade.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const groups = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join(''));
  console.log(groups.join('-'));
} else if (command === 'publicar') {
  const password = needPassword();
  const pagePath = join(root, 'data', 'painel.html');
  if (!existsSync(pagePath)) fail('data/painel.html nao existe: gere o painel antes (node scripts/gerar-painel.mjs).');
  const shellPath = join(ROOT, 'scripts', 'casca.html');
  const shell = readFileSync(shellPath, 'utf8');
  if (!shell.includes('"__PAYLOAD__"')) fail('Marcador de dados ausente em scripts/casca.html');
  const payload = encrypt(gzipSync(readFileSync(pagePath), { level: 9 }), password);
  const site = join(root, 'site');
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, 'index.html'), shell.replace('"__PAYLOAD__"', () => JSON.stringify(payload)));
  writeFileSync(join(site, '.nojekyll'), '');
  console.log(`Pagina criptografada: site/index.html (${Math.round(Buffer.byteLength(JSON.stringify(payload)) / 1024)} KB)`);

  if (!flag('sem-dados')) {
    const work = mkdtempSync(join(tmpdir(), 'painel-'));
    try {
      const archive = join(work, 'dados.tgz');
      tar(['-czf', archive, '-C', root, '--exclude=data/painel.html', '--exclude=data/.staging', '--exclude=data/.antigo', '--exclude=data/.acesso.json', 'data']);
      writeFileSync(CACHE, JSON.stringify(encrypt(readFileSync(archive), password)));
      console.log(`Dados criptografados para o cache: cache-dados.enc (${Math.round(readFileSync(CACHE).length / 1024)} KB)`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
} else if (command === 'restaurar') {
  const password = needPassword();
  if (!existsSync(CACHE)) {
    console.log('Sem cache de dados: o primeiro download sera o historico completo.');
  } else if (existsSync(join(root, 'data', 'activities.json')) && !flag('forcar')) {
    fail('data/ ja existe nesta pasta; nao vou sobrescrever (use --forcar se for isso mesmo que voce quer).');
  } else {
    let archive;
    try {
      archive = decrypt(JSON.parse(readFileSync(CACHE, 'utf8')), password);
    } catch {
      console.log('Nao consegui descriptografar o cache (a senha mudou?). Vou baixar o historico completo.');
      process.exit(0);
    }
    const work = mkdtempSync(join(tmpdir(), 'painel-'));
    try {
      const file = join(work, 'dados.tgz');
      writeFileSync(file, archive);
      tar(['-xzf', file, '-C', root]);
      console.log('Dados restaurados do cache criptografado.');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
} else if (command === 'verificar') {
  // Teste: decifra site/index.html com a senha e confere que o resultado e o painel.
  const password = needPassword();
  const html = readFileSync(join(root, 'site', 'index.html'), 'utf8');
  const match = html.match(/<script type="application\/json" id="p">(.*?)<\/script>/s);
  if (!match) fail('Payload nao encontrado em site/index.html');
  const plain = gunzipSync(decrypt(JSON.parse(match[1]), password)).toString('utf8');
  console.log(`Decifrado: ${Math.round(plain.length / 1024)} KB, comeca com ${plain.slice(0, 15).trim()}, igual ao painel local: ${plain === readFileSync(join(root, 'data', 'painel.html'), 'utf8')}`);
} else {
  fail('Uso: node scripts/nuvem.mjs senha | publicar [--sem-dados] [--raiz=pasta] | restaurar [--forcar] [--raiz=pasta] | verificar');
}
