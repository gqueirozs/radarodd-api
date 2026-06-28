/**
 * Scraper EsportivaBet — API Altenar
 *
 * Descoberta técnica completa:
 * - GetEventDetails retorna estrutura do evento mas odds chegam via WebSocket
 * - markets[] tem structure real mas desktopOddIds apontam para IDs que só chegam via WS
 * - childMarkets tem apostas de jogadores com sv = multiplicador (não a odd final)
 * 
 * Estratégia atual:
 * 1. Buscar info do evento via API (times, data, horário, campeonato)
 * 2. Buscar lista de eventos Copa via GetSportLeagueTopEvents
 * 3. Odds são definidas via configuração e atualizadas quando disponíveis via API
 */
const logger = require('../utils/logger');

const ALTENAR = 'https://sb2frontend-altenar2.biahosted.com/api/widget';
const PARAMS  = 'culture=pt-BR&timezoneOffset=180&integration=esportiva&deviceType=1&numFormat=en-GB&countryCode=BR';
const HDRS    = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0',
  'Accept': 'application/json',
  'Referer': 'https://esportiva.bet.br/',
  'Origin': 'https://esportiva.bet.br',
};

async function altenarGet(path, extra = '') {
  const url = `${ALTENAR}/${path}?${PARAMS}${extra ? '&' + extra : ''}`;
  const res  = await fetch(url, { headers: HDRS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} → ${path}`);
  return res.json();
}

// Buscar lista de eventos Copa do Mundo
async function buscarEventosCopa() {
  try {
    // Tentar GetSportLeagueTopEvents com champId da Copa 2026
    const j = await altenarGet('GetSportLeagueTopEvents',
      'champId=134750&sportId=1&withLive=true&couponType=0&startDate=&endDate=');
    const items = j?.Result?.Items || j?.Items || j?.events || [];
    logger.scraper(`GetSportLeagueTopEvents: ${items.length} eventos`);
    return items;
  } catch (e1) {
    logger.warn(`GetSportLeagueTopEvents falhou: ${e1.message}`);
    try {
      const j = await altenarGet('GetSportTopEvents', 'sportId=1&withLive=true&couponType=0');
      const items = j?.Result?.Items || j?.Items || [];
      const copa = items.filter(ev =>
        (ev.ChampionshipName || ev.champName || '').toLowerCase().includes('copa') ||
        (ev.ChampionshipName || ev.champName || '').toLowerCase().includes('world'));
      logger.scraper(`GetSportTopEvents Copa: ${copa.length} eventos`);
      return copa;
    } catch (e2) {
      logger.warn(`GetSportTopEvents falhou: ${e2.message}`);
      return [];
    }
  }
}

// Buscar detalhes de um evento específico
async function buscarEvento(eventId) {
  const j = await altenarGet('GetEventDetails', `eventId=${eventId}&showNonBoosts=true`);
  return j?.Result || j;
}

// Parsear info do evento (times, datas)
function parsearInfo(ev, eventId) {
  const comp     = Array.isArray(ev.competitors) ? ev.competitors : [];
  const nomeCasa = comp[0]?.name || 'Casa';
  const nomeFora = comp[1]?.name || 'Fora';
  const abbCasa  = comp[0]?.abbreviation || nomeCasa.slice(0,3).toUpperCase();
  const abbFora  = comp[1]?.abbreviation || nomeFora.slice(0,3).toUpperCase();

  let data = '--/--', hora = '--:--';
  if (ev.startDate) {
    const d = new Date(ev.startDate);
    data = d.toLocaleDateString('pt-BR');
    hora = d.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
  }

  const mks   = ev.markets || {};
  const grupo0 = (ev.marketGroups || [])[0];
  const grupoNome = grupo0?.name || '';

  // Extrair hint do mercado vencedor (pode ter estatísticas)
  const mktVenc = mks[0];
  const hint    = mktVenc?.hint || '';

  return {
    id: `${nomeCasa.toLowerCase().replace(/\s+/g,'-')}-vs-${nomeFora.toLowerCase().replace(/\s+/g,'-')}`,
    eventId: String(eventId),
    nomeCasa, nomeFora, abbCasa, abbFora,
    competicao: ev.champ?.name || 'Copa do Mundo 2026',
    fase: grupoNome || '16-avos',
    data, hora,
    estadio: '',
    status: 'pre',
    hint,
    marketIds: grupo0?.marketIds || [],
  };
}

// Odds base do Brasil x Japão (Copa 2026 — 29/06)
// Fonte: captura manual em 28/06/2026 via EsportivaBet
const ODDS_BRASIL_JAPAO = {
  resultado:   { casa: 1.71, empate: 3.60, fora: 4.75 },
  totalGols:   { linha: 2.5, mais: 1.96, menos: 1.75 },
  ambasMarcam: { sim: 1.94, nao: 1.80 },
  primeiroGol: { casa: 1.57, nenhum: 10.00, fora: 2.90 },
  chanceDupla: { casaEmpate: 1.21, casaFora: 1.24, empataFora: 2.35 },
  qualificar:  { casa: 1.38, fora: 3.00 },
  escanteios:  { linha: 9.5, mais: 2.00, menos: 1.67 },
  handicap: [
    { linha: '+0.5', odd: 1.18 }, { linha: '+0.25', odd: 1.23 },
    { linha: '0',   odd: 1.29 }, { linha: '-0.25', odd: 1.50 },
    { linha: '-0.5', odd: 1.69 }, { linha: '-0.75', odd: 1.89 },
  ],
  placares: [
    { placar:'1-0', odd:6.33, time:'casa' }, { placar:'2-0', odd:7.50,  time:'casa' },
    { placar:'2-1', odd:8.50, time:'casa' }, { placar:'3-0', odd:13.00, time:'casa' },
    { placar:'3-1', odd:15.00, time:'casa' }, { placar:'0-0', odd:9.50,  time:'empate' },
    { placar:'1-1', odd:6.67, time:'empate' }, { placar:'0-1', odd:14.00, time:'fora' },
  ],
};

// IDs fixos dos eventos Copa 2026 conhecidos
const EVENTOS_FIXOS = [
  { eventId: 16913912, oddsBase: ODDS_BRASIL_JAPAO },
];

async function executarScrape() {
  const resultados = [];

  // Tentar buscar eventos dinamicamente primeiro
  let eventosDinamicos = [];
  try {
    eventosDinamicos = await buscarEventosCopa();
  } catch (e) {
    logger.warn('Busca dinâmica falhou, usando lista fixa');
  }

  // Processar eventos fixos (com odds base conhecidas)
  for (const { eventId, oddsBase } of EVENTOS_FIXOS) {
    try {
      logger.scraper(`Coletando evento ${eventId}...`);
      const ev   = await buscarEvento(eventId);
      const info = parsearInfo(ev, eventId);

      // Usar odds base (capturadas manualmente)
      // TODO: quando WS for implementado, substituir por odds em tempo real
      const odds = { ...oddsBase };

      logger.ok(`✓ ${info.nomeCasa} x ${info.nomeFora} | ${info.data} ${info.hora}`);
      logger.ok(`  Resultado: ${odds.resultado.casa} / ${odds.resultado.empate} / ${odds.resultado.fora}`);

      resultados.push({
        info,
        odds,
        fonte: 'base+altenar-info',
        coletadoEm: new Date().toISOString(),
      });

      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      logger.error(`Evento ${eventId}: ${err.message}`);
    }
  }

  // Adicionar eventos dinâmicos da Copa encontrados via API
  for (const ev of eventosDinamicos) {
    const id = ev.EventId || ev.Id || ev.id;
    if (!id || EVENTOS_FIXOS.find(e => e.eventId === id)) continue;

    try {
      const detalhes = await buscarEvento(id);
      const info     = parsearInfo(detalhes, id);

      // Sem odds pré-capturadas — retornar estrutura vazia
      resultados.push({
        info,
        odds: {
          resultado: {}, totalGols: { linha: 2.5 }, ambasMarcam: {},
          primeiroGol: {}, chanceDupla: {}, qualificar: {},
          escanteios: { linha: 9.5 }, handicap: [], placares: [],
        },
        fonte: 'altenar-dinamico',
        coletadoEm: new Date().toISOString(),
      });

      logger.ok(`✓ Dinâmico: ${info.nomeCasa} x ${info.nomeFora}`);
    } catch (e) {
      logger.warn(`Evento dinâmico ${id}: ${e.message}`);
    }
  }

  return resultados;
}

async function scrapeListaJogos() {
  return buscarEventosCopa();
}

module.exports = { executarScrape, scrapeListaJogos };
