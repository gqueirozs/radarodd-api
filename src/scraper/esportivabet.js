/**
 * Scraper EsportivaBet — Descoberta automática de todos os jogos da Copa
 * 
 * Estratégia:
 * 1. Mantém um arquivo JSON persistente com IDs já descobertos
 * 2. A cada ciclo, varre novos ranges de IDs em paralelo (batches de 50)
 * 3. Filtra por sport=Futebol + champ=Copa do Mundo FIFA
 * 4. Retorna todos os jogos encontrados com info real do Altenar
 */
const fs     = require('fs');
const path   = require('path');
const logger = require('../utils/logger');

const DB_PATH = path.join(__dirname, '../../data/jogos_copa.json');

// Garantir que o diretório de dados existe
if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

// Carregar banco persistente
function carregarBanco() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch {}
  return { jogos: {}, varredura: { proximo: 16880000, fim: 16990000 } };
}

// Salvar banco
function salvarBanco(banco) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(banco, null, 2));
  } catch (e) {
    logger.error('Erro ao salvar banco: ' + e.message);
  }
}

// ── Altenar API ──────────────────────────────────────────────────────────────
const ALTENAR = 'https://sb2frontend-altenar2.biahosted.com/api/widget';
const PARAMS  = 'culture=pt-BR&timezoneOffset=180&integration=esportiva&deviceType=1&numFormat=en-GB&countryCode=BR';
const HDRS    = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
  'Accept': 'application/json',
  'Referer': 'https://esportiva.bet.br/',
};

async function getEvento(eventId) {
  const url = `${ALTENAR}/GetEventDetails?${PARAMS}&eventId=${eventId}&showNonBoosts=true`;
  const res  = await fetch(url, { headers: HDRS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j  = await res.json();
  return j?.Result || j;
}

// Verificar se um ID é um jogo de futebol da Copa 2026
function ehJogoCopa(ev) {
  if (!ev?.competitors || ev.competitors.length < 2) return false;
  const sport = (ev.sport?.name || ev.sportName || '').toLowerCase();
  const champ = (ev.champ?.name || ev.champName || '').toLowerCase();
  const isFut = sport === 'futebol' || sport === 'football' || sport === 'soccer';
  const isCopa = champ.includes('copa do mundo') || champ.includes('world cup') || champ.includes('fifa world') || champ.includes('2026');
  return isFut && isCopa;
}

// Varrer um range de IDs em paralelo (batches)
async function varrerRange(inicio, fim, batchSize = 40) {
  const encontrados = [];
  for (let base = inicio; base <= fim; base += batchSize) {
    const ids  = Array.from({ length: Math.min(batchSize, fim - base + 1) }, (_, i) => base + i);
    const resultados = await Promise.allSettled(ids.map(async (id) => {
      try {
        const ev = await getEvento(id);
        if (ehJogoCopa(ev)) return { id, ev };
        return null;
      } catch {
        return null;
      }
    }));

    for (const r of resultados) {
      if (r.status === 'fulfilled' && r.value) {
        encontrados.push(r.value);
        const { id, ev } = r.value;
        process.stdout.write(`  ✦ ${id} ${ev.competitors[0].name} x ${ev.competitors[1].name}\n`);
      }
    }
    await new Promise(r => setTimeout(r, 200)); // pequena pausa entre batches
  }
  return encontrados;
}

// Parsear info de um evento para o formato RadarOdd
function parsearInfo(ev, id) {
  const comp = ev.competitors || [];
  let data = '--/--', hora = '--:--';
  if (ev.startDate) {
    const d = new Date(ev.startDate);
    data = d.toLocaleDateString('pt-BR');
    hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  return {
    id: `${(comp[0]?.name||'casa').toLowerCase().replace(/[^a-z0-9]/g,'-')}-vs-${(comp[1]?.name||'fora').toLowerCase().replace(/[^a-z0-9]/g,'-')}`,
    eventId: String(id),
    nomeCasa:  comp[0]?.name  || 'Casa',
    nomeFora:  comp[1]?.name  || 'Fora',
    abbCasa:   comp[0]?.abbreviation || comp[0]?.name?.slice(0,3).toUpperCase() || 'CA',
    abbFora:   comp[1]?.abbreviation || comp[1]?.name?.slice(0,3).toUpperCase() || 'FO',
    competicao: ev.champ?.name || 'Copa do Mundo 2026',
    fase:       (ev.marketGroups?.[0]?.name) || 'Copa 2026',
    data, hora,
    estadio:   ev.venue?.name || '',
    status:    'pre',
    startDate: ev.startDate || null,
  };
}

const ODDS_VAZIAS = () => ({
  resultado: {}, totalGols: { linha: 2.5 }, ambasMarcam: {},
  primeiroGol: {}, chanceDupla: {}, qualificar: {},
  escanteios: { linha: 9.5 }, handicap: [], placares: [],
});

// Odds base capturadas manualmente para jogos conhecidos
const ODDS_MANUAIS = {
  16913912: { // Brasil x Japão
    resultado:   { casa: 1.71, empate: 3.60, fora: 4.75 },
    totalGols:   { linha: 2.5, mais: 1.96, menos: 1.75 },
    ambasMarcam: { sim: 1.94, nao: 1.80 },
    primeiroGol: { casa: 1.57, nenhum: 10.00, fora: 2.90 },
    chanceDupla: { casaEmpate: 1.21, casaFora: 1.24, empataFora: 2.35 },
    qualificar:  { casa: 1.38, fora: 3.00 },
    escanteios:  { linha: 9.5, mais: 2.00, menos: 1.67 },
    handicap: [
      { linha: '+0.5', odd: 1.18 }, { linha: '+0.25', odd: 1.23 },
      { linha: '0', odd: 1.29 },    { linha: '-0.25', odd: 1.50 },
      { linha: '-0.5', odd: 1.69 }, { linha: '-0.75', odd: 1.89 },
    ],
    placares: [
      { placar:'1-0', odd:6.33, time:'casa' }, { placar:'2-0', odd:7.50, time:'casa' },
      { placar:'2-1', odd:8.50, time:'casa' }, { placar:'3-0', odd:13.00, time:'casa' },
      { placar:'3-1', odd:15.00, time:'casa' }, { placar:'0-0', odd:9.50, time:'empate' },
      { placar:'1-1', odd:6.67, time:'empate' }, { placar:'0-1', odd:14.00, time:'fora' },
    ],
  },
  16913911: { // Países Baixos x Marrocos
    resultado:   { casa: 1.80, empate: 3.50, fora: 4.50 },
    totalGols:   { linha: 2.5, mais: 1.90, menos: 1.82 },
    ambasMarcam: { sim: 1.90, nao: 1.85 },
    primeiroGol: { casa: 1.65, nenhum: 10.00, fora: 3.20 },
    chanceDupla: { casaEmpate: 1.18, casaFora: 1.22, empataFora: 2.40 },
    qualificar:  { casa: 1.42, fora: 2.85 },
    escanteios:  { linha: 9.5, mais: 1.95, menos: 1.75 },
    handicap: [], placares: [],
  },
  16913931: { // Estados Unidos x Bósnia e Herzegovina
    resultado:   { casa: 1.60, empate: 3.80, fora: 5.50 },
    totalGols:   { linha: 2.5, mais: 2.00, menos: 1.72 },
    ambasMarcam: { sim: 1.88, nao: 1.85 },
    primeiroGol: { casa: 1.50, nenhum: 10.00, fora: 3.50 },
    chanceDupla: { casaEmpate: 1.15, casaFora: 1.20, empataFora: 2.50 },
    qualificar:  { casa: 1.30, fora: 3.50 },
    escanteios:  { linha: 9.5, mais: 1.95, menos: 1.75 },
    handicap: [], placares: [],
  },
};

// ── FUNÇÃO PRINCIPAL ─────────────────────────────────────────────────────────
async function executarScrape() {
  const banco    = carregarBanco();
  const jogos    = banco.jogos || {};
  const varredura = banco.varredura || { proximo: 16880000, fim: 16990000 };

  logger.scraper(`Banco: ${Object.keys(jogos).length} jogos conhecidos`);

  // 1. Atualizar todos os jogos conhecidos com info atual do Altenar
  const resultados = [];
  for (const [idStr, meta] of Object.entries(jogos)) {
    const id = parseInt(idStr);
    try {
      const ev   = await getEvento(id);
      if (!ehJogoCopa(ev)) continue;
      const info = parsearInfo(ev, id);
      const odds = ODDS_MANUAIS[id] || ODDS_VAZIAS();
      resultados.push({ info, odds, coletadoEm: new Date().toISOString() });
      // Atualizar banco com info mais recente
      jogos[id] = { casa: info.nomeCasa, fora: info.nomeFora, startDate: ev.startDate };
    } catch (e) {
      logger.warn(`Evento ${id}: ${e.message}`);
      // Usar dados do banco se disponível
      if (meta.casa) {
        const odds = ODDS_MANUAIS[id] || ODDS_VAZIAS();
        resultados.push({
          info: {
            id: `${meta.casa.toLowerCase().replace(/[^a-z0-9]/g,'-')}-vs-${meta.fora.toLowerCase().replace(/[^a-z0-9]/g,'-')}`,
            eventId: String(id),
            nomeCasa: meta.casa, nomeFora: meta.fora,
            abbCasa: meta.casa.slice(0,3).toUpperCase(),
            abbFora: meta.fora.slice(0,3).toUpperCase(),
            competicao: 'Copa do Mundo 2026', fase: 'Copa 2026',
            data: meta.startDate ? new Date(meta.startDate).toLocaleDateString('pt-BR') : '--/--',
            hora: meta.startDate ? new Date(meta.startDate).toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'}) : '--:--',
            estadio: '', status: 'pre', startDate: meta.startDate,
          },
          odds,
          coletadoEm: new Date().toISOString(),
        });
      }
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // 2. Varrer próximo bloco de IDs para descobrir novos jogos
  const BLOCO = 500; // varrer 500 IDs por ciclo
  const inicio = varredura.proximo;
  const fim    = Math.min(inicio + BLOCO - 1, varredura.fim);

  if (inicio <= varredura.fim) {
    logger.scraper(`Varrendo IDs ${inicio}–${fim} em busca de novos jogos...`);
    const novos = await varrerRange(inicio, fim, 40);

    for (const { id, ev } of novos) {
      if (!jogos[id]) {
        jogos[id] = {
          casa:      ev.competitors[0].name,
          fora:      ev.competitors[1].name,
          startDate: ev.startDate,
          champ:     ev.champ?.name,
        };
        const info = parsearInfo(ev, id);
        const odds = ODDS_MANUAIS[id] || ODDS_VAZIAS();
        resultados.push({ info, odds, coletadoEm: new Date().toISOString() });
        logger.ok(`Novo jogo: ${info.nomeCasa} x ${info.nomeFora} (${info.data} ${info.hora})`);
      }
    }

    // Avançar para próximo bloco
    varredura.proximo = fim + 1;

    // Se terminou a faixa, recomeçar (IDs novos podem aparecer no futuro)
    if (varredura.proximo > varredura.fim) {
      varredura.proximo = 16880000;
      logger.scraper('Varredura completa — reiniciando do início');
    }
  }

  // Salvar banco atualizado
  banco.jogos     = jogos;
  banco.varredura = varredura;
  salvarBanco(banco);

  // Ordenar por data
  resultados.sort((a, b) => {
    const da = a.info.startDate || '';
    const db = b.info.startDate || '';
    return da.localeCompare(db);
  });

  logger.ok(`Total: ${resultados.length} jogos | Próxima varredura: ${varredura.proximo}`);
  return resultados;
}

async function scrapeListaJogos() { return []; }
module.exports = { executarScrape, scrapeListaJogos };
