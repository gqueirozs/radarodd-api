/**
 * Scraper EsportivaBet — com MongoDB Atlas para persistência
 * 
 * - MongoDB guarda jogos descobertos e cursor de varredura
 * - Sem MongoDB: fallback em memória (BANCO_MEM)
 * - Cada ciclo de 5min: atualiza jogos + varre 500 IDs novos em paralelo
 */
const logger = require('../utils/logger');
const db     = require('../db/mongo');

// Fallback em memória se MongoDB não disponível
const BANCO_MEM = {
  16913911: { nomeCasa:'Países Baixos', nomeFora:'Marrocos',              startDate:'2026-06-30T01:00:00Z' },
  16913912: { nomeCasa:'Brasil',        nomeFora:'Japão',                 startDate:'2026-06-29T17:00:00Z' },
  16913931: { nomeCasa:'Estados Unidos',nomeFora:'Bósnia e Herzegovina',  startDate:'2026-07-02T00:00:00Z' },
};
let cursorMem = 16913932;
const FIM = 16990000;
const BLOCO = 500, BATCH = 40;

// ── Altenar API ──────────────────────────────────────────────────────────────
const BASE   = 'https://sb2frontend-altenar2.biahosted.com/api/widget';
const PARAMS = 'culture=pt-BR&timezoneOffset=180&integration=esportiva&deviceType=1&numFormat=en-GB&countryCode=BR';
const HDRS   = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
  'Accept': 'application/json', 'Referer': 'https://esportiva.bet.br/',
};

async function getEvento(id) {
  const res = await fetch(`${BASE}/GetEventDetails?${PARAMS}&eventId=${id}&showNonBoosts=true`,
    { headers: HDRS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return j?.Result || j;
}

function ehCopa(ev) {
  if (!ev?.competitors || ev.competitors.length < 2) return false;
  const sport = (ev.sport?.name || '').toLowerCase();
  const champ = (ev.champ?.name || '').toLowerCase();
  return (sport === 'futebol' || sport === 'football') &&
         (champ.includes('copa do mundo') || champ.includes('world cup') || champ.includes('fifa world'));
}

function parsearInfo(ev, id) {
  const c = ev.competitors || [];
  let data = '--/--', hora = '--:--';
  if (ev.startDate) {
    const d = new Date(ev.startDate);
    data = d.toLocaleDateString('pt-BR');
    hora = d.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
  }
  const nomeCasa = c[0]?.name || BANCO_MEM[id]?.nomeCasa || 'Casa';
  const nomeFora = c[1]?.name || BANCO_MEM[id]?.nomeFora || 'Fora';
  return {
    id: `${nomeCasa.toLowerCase().replace(/[^a-z0-9]/g,'-')}-vs-${nomeFora.toLowerCase().replace(/[^a-z0-9]/g,'-')}`,
    eventId: String(id), nomeCasa, nomeFora,
    abbCasa: c[0]?.abbreviation || nomeCasa.slice(0,3).toUpperCase(),
    abbFora: c[1]?.abbreviation || nomeFora.slice(0,3).toUpperCase(),
    competicao: ev.champ?.name || 'Copa do Mundo 2026',
    fase: (ev.marketGroups?.[0]?.name) || 'Copa 2026',
    data, hora, estadio: ev.venue?.name || '',
    status: 'pre', startDate: ev.startDate || null,
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
    const ids  = Array.from({ length: Math.min(BATCH, fim - base + 1) }, (_, i) => base + i);
    const res  = await Promise.allSettled(ids.map(async id => {
      try {
        const ev = await getEvento(id);
        if (!ehCopa(ev)) return null;
        return { id, ev };
      } catch { return null; }
    }));
    for (const r of res) {
      if (r.status === 'fulfilled' && r.value) {
        novos.push(r.value);
        const { id, ev } = r.value;
        logger.ok(`✦ Novo: ${ev.competitors[0].name} x ${ev.competitors[1].name} (id ${id})`);
      }
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return novos;
}

// ── FUNÇÃO PRINCIPAL ─────────────────────────────────────────────────────────
async function executarScrape() {
  const resultados = [];
  const usandoMongo = !!process.env.MONGODB_URI;

  // Carregar jogos existentes do MongoDB ou fallback memória
  let jogosExistentes = {};
  let proximoId = cursorMem;

  if (usandoMongo) {
    const jogosDB = await db.getJogos();
    if (jogosDB && jogosDB.length > 0) {
      for (const j of jogosDB) {
        jogosExistentes[j.eventId] = j;
      }
      logger.scraper(`MongoDB: ${Object.keys(jogosExistentes).length} jogos`);
    } else {
      // Primeiro uso: popular com banco fixo
      for (const [id, meta] of Object.entries(BANCO_MEM)) {
        jogosExistentes[id] = { eventId: String(id), ...meta };
      }
    }
    const cursor = await db.getCursor();
    if (cursor) proximoId = cursor.proximo;
  } else {
    // Fallback memória
    for (const [id, meta] of Object.entries(BANCO_MEM)) {
      jogosExistentes[id] = { eventId: String(id), ...meta };
    }
  }

  // 1. Atualizar/buscar info atual de cada jogo conhecido
  for (const [idStr, meta] of Object.entries(jogosExistentes)) {
    const id = parseInt(idStr);
    try {
      const ev   = await getEvento(id);
      if (!ehCopa(ev)) continue;
      const info = parsearInfo(ev, id);
      const odds = ODDS_MANUAIS[id] || ODDS_VAZIAS();
      // Mesclar odds salvas no banco com as manuais
      const oddsFinal = { ...(meta.odds || ODDS_VAZIAS()), ...ODDS_MANUAIS[id] } || ODDS_VAZIAS();
      resultados.push({ info, odds: oddsFinal, coletadoEm: new Date().toISOString() });
      if (usandoMongo) await db.upsertJogo(info, oddsFinal);
      if (!BANCO_MEM[id]) BANCO_MEM[id] = { nomeCasa: info.nomeCasa, nomeFora: info.nomeFora, startDate: ev.startDate };
    } catch {
      // Usar dados do banco como fallback
      if (meta.nomeCasa || meta.nome) {
        const nomeCasa = meta.nomeCasa || meta.nome || 'Casa';
        const nomeFora = meta.nomeFora || 'Fora';
        const odds = meta.odds || ODDS_MANUAIS[id] || ODDS_VAZIAS();
        resultados.push({
          info: {
            id: `${nomeCasa.toLowerCase().replace(/[^a-z0-9]/g,'-')}-vs-${nomeFora.toLowerCase().replace(/[^a-z0-9]/g,'-')}`,
            eventId: String(id), nomeCasa, nomeFora,
            abbCasa: nomeCasa.slice(0,3).toUpperCase(), abbFora: nomeFora.slice(0,3).toUpperCase(),
            competicao:'Copa do Mundo 2026', fase:'Copa 2026',
            data: meta.startDate ? new Date(meta.startDate).toLocaleDateString('pt-BR') : '--/--',
            hora: meta.startDate ? new Date(meta.startDate).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) : '--:--',
            estadio:'', status:'pre', startDate: meta.startDate,
          },
          odds,
          coletadoEm: new Date().toISOString(),
        });
      }
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // 2. Varrer bloco de 500 IDs novos
  const inicio = proximoId;
  const fim    = Math.min(inicio + BLOCO - 1, FIM);
  logger.scraper(`Varrendo IDs ${inicio}–${fim}...`);

  const novos = await varrerBloco(inicio, fim);
  for (const { id, ev } of novos) {
    if (jogosExistentes[id]) continue;
    const info = parsearInfo(ev, id);
    const odds = ODDS_MANUAIS[id] || ODDS_VAZIAS();
    resultados.push({ info, odds, coletadoEm: new Date().toISOString() });
    BANCO_MEM[id] = { nomeCasa: info.nomeCasa, nomeFora: info.nomeFora, startDate: ev.startDate };
    if (usandoMongo) await db.upsertJogo(info, odds);
  }

  // Avançar cursor
  const novoProximo = (fim + 1 > FIM) ? 16880000 : fim + 1;
  cursorMem = novoProximo;
  if (usandoMongo) await db.setCursor(novoProximo);

  resultados.sort((a, b) => (a.info.startDate || '').localeCompare(b.info.startDate || ''));
  logger.ok(`Total: ${resultados.length} jogos | ${novos.length} novos | próx: ${novoProximo}`);
  return resultados;
}

async function scrapeListaJogos() { return []; }
module.exports = { executarScrape, scrapeListaJogos };
