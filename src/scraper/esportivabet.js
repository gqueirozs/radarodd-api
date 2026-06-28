/**
 * Scraper EsportivaBet — Descoberta automática de todos os jogos da Copa
 * 
 * Banco de IDs em memória (acumula durante vida do processo).
 * A cada ciclo de 5min, varre 500 IDs novos em paralelo.
 * Jogos já conhecidos são fixos no código — novos são descobertos automaticamente.
 */
const logger = require('../utils/logger');

// ── Banco em memória ─────────────────────────────────────────────────────────
// IDs já confirmados como jogos da Copa do Mundo FIFA 2026 na EsportivaBet
const BANCO = {
  16913911: { casa: 'Países Baixos', fora: 'Marrocos',              startDate: '2026-06-30T01:00:00Z' },
  16913912: { casa: 'Brasil',        fora: 'Japão',                 startDate: '2026-06-29T17:00:00Z' },
  16913931: { casa: 'Estados Unidos', fora: 'Bósnia e Herzegovina', startDate: '2026-07-02T00:00:00Z' },
};

// Próximo ID a varrer (avança a cada ciclo, cobre todo range da Copa)
let proximoId = 16913932;
const FIM_RANGE = 16990000;
const BLOCO    = 500;
const BATCH    = 40; // paralelo por batch

// ── Altenar API ──────────────────────────────────────────────────────────────
const ALTENAR = 'https://sb2frontend-altenar2.biahosted.com/api/widget';
const PARAMS  = 'culture=pt-BR&timezoneOffset=180&integration=esportiva&deviceType=1&numFormat=en-GB&countryCode=BR';
const HDRS    = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
  'Accept': 'application/json',
  'Referer': 'https://esportiva.bet.br/',
};

async function getEvento(id) {
  const url = `${ALTENAR}/GetEventDetails?${PARAMS}&eventId=${id}&showNonBoosts=true`;
  const res  = await fetch(url, { headers: HDRS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return j?.Result || j;
}

function ehCopa(ev) {
  if (!ev?.competitors || ev.competitors.length < 2) return false;
  const sport = (ev.sport?.name || '').toLowerCase();
  const champ = (ev.champ?.name || '').toLowerCase();
  const isFut  = sport === 'futebol' || sport === 'football';
  const isCopa = champ.includes('copa do mundo') || champ.includes('world cup') || champ.includes('fifa world');
  return isFut && isCopa;
}

function parsearInfo(ev, id) {
  const c = ev.competitors || [];
  let data = '--/--', hora = '--:--';
  if (ev.startDate) {
    const d = new Date(ev.startDate);
    data = d.toLocaleDateString('pt-BR');
    hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  const nomeCasa = c[0]?.name || BANCO[id]?.casa || 'Casa';
  const nomeFora = c[1]?.name || BANCO[id]?.fora || 'Fora';
  return {
    id: `${nomeCasa.toLowerCase().replace(/[^a-z0-9]/g,'-')}-vs-${nomeFora.toLowerCase().replace(/[^a-z0-9]/g,'-')}`,
    eventId: String(id), nomeCasa, nomeFora,
    abbCasa: c[0]?.abbreviation || nomeCasa.slice(0,3).toUpperCase(),
    abbFora: c[1]?.abbreviation || nomeFora.slice(0,3).toUpperCase(),
    competicao: ev.champ?.name || 'Copa do Mundo 2026',
    fase: (ev.marketGroups?.[0]?.name) || 'Copa 2026',
    data, hora,
    estadio: ev.venue?.name || '',
    status: 'pre',
    startDate: ev.startDate || BANCO[id]?.startDate || null,
  };
}

const ODDS_VAZIAS = () => ({
  resultado:{}, totalGols:{linha:2.5}, ambasMarcam:{}, primeiroGol:{},
  chanceDupla:{}, qualificar:{}, escanteios:{linha:9.5}, handicap:[], placares:[],
});

const ODDS_MANUAIS = {
  16913912: {
    resultado:   { casa:1.71, empate:3.60, fora:4.75 },
    totalGols:   { linha:2.5, mais:1.96, menos:1.75 },
    ambasMarcam: { sim:1.94, nao:1.80 },
    primeiroGol: { casa:1.57, nenhum:10.00, fora:2.90 },
    chanceDupla: { casaEmpate:1.21, casaFora:1.24, empataFora:2.35 },
    qualificar:  { casa:1.38, fora:3.00 },
    escanteios:  { linha:9.5, mais:2.00, menos:1.67 },
    handicap:[{linha:'+0.5',odd:1.18},{linha:'+0.25',odd:1.23},{linha:'0',odd:1.29},{linha:'-0.25',odd:1.50},{linha:'-0.5',odd:1.69},{linha:'-0.75',odd:1.89}],
    placares:[{placar:'1-0',odd:6.33,time:'casa'},{placar:'2-0',odd:7.50,time:'casa'},{placar:'2-1',odd:8.50,time:'casa'},{placar:'3-0',odd:13.00,time:'casa'},{placar:'0-0',odd:9.50,time:'empate'},{placar:'1-1',odd:6.67,time:'empate'},{placar:'0-1',odd:14.00,time:'fora'}],
  },
  16913911: {
    resultado:   { casa:1.80, empate:3.50, fora:4.50 },
    totalGols:   { linha:2.5, mais:1.90, menos:1.82 },
    ambasMarcam: { sim:1.90, nao:1.85 },
    primeiroGol: { casa:1.65, nenhum:10.00, fora:3.20 },
    chanceDupla: { casaEmpate:1.18, casaFora:1.22, empataFora:2.40 },
    qualificar:  { casa:1.42, fora:2.85 },
    escanteios:  { linha:9.5, mais:1.95, menos:1.75 },
    handicap:[], placares:[],
  },
  16913931: {
    resultado:   { casa:1.60, empate:3.80, fora:5.50 },
    totalGols:   { linha:2.5, mais:2.00, menos:1.72 },
    ambasMarcam: { sim:1.88, nao:1.85 },
    primeiroGol: { casa:1.50, nenhum:10.00, fora:3.50 },
    chanceDupla: { casaEmpate:1.15, casaFora:1.20, empataFora:2.50 },
    qualificar:  { casa:1.30, fora:3.50 },
    escanteios:  { linha:9.5, mais:1.95, menos:1.75 },
    handicap:[], placares:[],
  },
};

// Varrer bloco de IDs em paralelo
async function varrerBloco(inicio, fim) {
  const novos = [];
  for (let base = inicio; base <= fim; base += BATCH) {
    const ids = Array.from({ length: Math.min(BATCH, fim - base + 1) }, (_, i) => base + i);
    const res = await Promise.allSettled(ids.map(async id => {
      if (BANCO[id]) return null;
      try {
        const ev = await getEvento(id);
        if (!ehCopa(ev)) return null;
        return { id, ev };
      } catch { return null; }
    }));
    for (const r of res) {
      if (r.status === 'fulfilled' && r.value) {
        const { id, ev } = r.value;
        BANCO[id] = { casa: ev.competitors[0].name, fora: ev.competitors[1].name, startDate: ev.startDate };
        novos.push({ id, ev });
        logger.ok(`Novo: ${ev.competitors[0].name} x ${ev.competitors[1].name} (${id})`);
      }
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return novos;
}

// ── FUNÇÃO PRINCIPAL ─────────────────────────────────────────────────────────
async function executarScrape() {
  const resultados = [];

  // 1. Buscar dados atualizados para jogos conhecidos
  logger.scraper(`Banco: ${Object.keys(BANCO).length} jogos conhecidos`);
  for (const [idStr, meta] of Object.entries(BANCO)) {
    const id = parseInt(idStr);
    try {
      const ev   = await getEvento(id);
      if (!ehCopa(ev)) continue;
      const info = parsearInfo(ev, id);
      const odds = ODDS_MANUAIS[id] || ODDS_VAZIAS();
      resultados.push({ info, odds, coletadoEm: new Date().toISOString() });
      // Atualizar banco em memória
      BANCO[id] = { ...meta, casa: info.nomeCasa, fora: info.nomeFora, startDate: ev.startDate };
    } catch (e) {
      logger.warn(`Evento ${id}: ${e.message} — usando banco`);
      // Usar dados do banco
      const info = {
        id: `${meta.casa.toLowerCase().replace(/[^a-z0-9]/g,'-')}-vs-${meta.fora.toLowerCase().replace(/[^a-z0-9]/g,'-')}`,
        eventId: String(id), nomeCasa: meta.casa, nomeFora: meta.fora,
        abbCasa: meta.casa.slice(0,3).toUpperCase(), abbFora: meta.fora.slice(0,3).toUpperCase(),
        competicao:'Copa do Mundo 2026', fase:'Copa 2026',
        data: meta.startDate ? new Date(meta.startDate).toLocaleDateString('pt-BR') : '--/--',
        hora: meta.startDate ? new Date(meta.startDate).toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'}) : '--:--',
        estadio:'', status:'pre', startDate: meta.startDate,
      };
      resultados.push({ info, odds: ODDS_MANUAIS[id] || ODDS_VAZIAS(), coletadoEm: new Date().toISOString() });
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // 2. Varrer bloco de 500 IDs novos
  const inicio = proximoId;
  const fim    = Math.min(inicio + BLOCO - 1, FIM_RANGE);
  logger.scraper(`Varrendo IDs ${inicio}–${fim}...`);

  const novos = await varrerBloco(inicio, fim);
  for (const { id, ev } of novos) {
    const info = parsearInfo(ev, id);
    resultados.push({ info, odds: ODDS_MANUAIS[id] || ODDS_VAZIAS(), coletadoEm: new Date().toISOString() });
  }

  // Avançar cursor
  proximoId = fim + 1;
  if (proximoId > FIM_RANGE) {
    proximoId = 16880000;
    logger.scraper('Varredura completa — reiniciando');
  }

  // Ordenar por data de início
  resultados.sort((a, b) => (a.info.startDate || '').localeCompare(b.info.startDate || ''));

  logger.ok(`Total: ${resultados.length} jogos | ${novos.length} novos | próx: ${proximoId}`);
  return resultados;
}

async function scrapeListaJogos() { return []; }
module.exports = { executarScrape, scrapeListaJogos };
