/**
 * Scraper EsportivaBet via API Altenar
 * 
 * Estrutura real descoberta:
 * - competitors[0/1].name = times (BRA / JPN)
 * - marketGroups[].name = "Principal", "Totais", etc. + marketIds[]
 * - markets = objeto { [id]: {name, odds:[]} } — odds chegam vazio (WebSocket)
 * - childMarkets = array de 1825 apostas individuais com .name e .sv (a odd real)
 * 
 * Solução: filtrar childMarkets pelos nomes dos mercados principais
 */
const logger = require('../utils/logger');

const ALTENAR = 'https://sb2frontend-altenar2.biahosted.com/api/widget';
const PARAMS  = 'culture=pt-BR&timezoneOffset=180&integration=esportiva&deviceType=1&numFormat=en-GB&countryCode=BR';
const HDRS    = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
  'Accept': 'application/json',
  'Referer': 'https://esportiva.bet.br/',
  'Origin': 'https://esportiva.bet.br',
};

async function altenarGet(path, extra = '') {
  const url = `${ALTENAR}/${path}?${PARAMS}${extra ? '&' + extra : ''}`;
  const res  = await fetch(url, { headers: HDRS, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} → ${path}`);
  return res.json();
}

function p(v) {                        // parse odd segura
  const n = parseFloat(v);
  return (!isNaN(n) && n >= 1.01 && n <= 999) ? n : null;
}

// Buscar odds via GET do grupo "Principal" usando marketGroupId
async function fetchGroupOdds(eventId, groupId) {
  try {
    const endpoints = [
      `GetMarketGroupOdds?eventId=${eventId}&marketGroupId=${groupId}`,
      `GetEventMarketGroup?eventId=${eventId}&marketGroupId=${groupId}`,
      `GetMarkets?eventId=${eventId}&marketGroupId=${groupId}`,
      `GetEventOdds?eventId=${eventId}&marketGroupId=${groupId}`,
    ];
    for (const ep of endpoints) {
      try {
        const j = await altenarGet(ep.split('?')[0], ep.split('?')[1]);
        const s = JSON.stringify(j);
        if (s.length > 50 && !s.includes('"Result":null')) {
          logger.scraper(`✓ ${ep.split('?')[0]} retornou dados`);
          return j;
        }
      } catch { /* tenta próximo */ }
    }
  } catch {}
  return null;
}

// Parser principal: filtra childMarkets pelos nomes dos mercados
function parsearOdds(ev) {
  const odds = {
    resultado:    {},
    totalGols:    { linha: 2.5 },
    ambasMarcam:  {},
    primeiroGol:  {},
    chanceDupla:  {},
    qualificar:   {},
    escanteios:   { linha: 9.5 },
    handicap:     [],
    placares:     [],
  };

  const cm = ev.childMarkets || [];
  logger.scraper(`childMarkets disponíveis: ${cm.length}`);

  // Agrupar childMarkets por sportMarketId para encontrar mercados principais
  const byMarket = {};
  for (const item of cm) {
    const mid = item.sportMarketId || item.typeId || 0;
    if (!byMarket[mid]) byMarket[mid] = { name: item.name || '', items: [] };
    byMarket[mid].items.push(item);
  }

  // Os mercados do grupo "Principal" têm IDs específicos
  const mg    = ev.marketGroups || [];
  const mks   = ev.markets || {};
  const grpPrincipal = mg.find(g => g.name === 'Principal' || g.name === 'Main') || mg[0];
  const principalIds = grpPrincipal?.marketIds || [];

  logger.scraper(`Grupo Principal: ${grpPrincipal?.name} — ${principalIds.length} mercados`);

  // Iterar pelos mercados do grupo principal
  for (const mid of principalIds) {
    const market = mks[mid];
    if (!market) continue;
    const nome = (market.name || '').toLowerCase();

    // Buscar childMarkets correspondentes a este market id
    const itens = cm.filter(c => c.sportMarketId === mid || c.typeId === mid);
    if (!itens.length) continue;

    logger.scraper(`Mercado: ${market.name} (${mid}) — ${itens.length} seleções`);

    // 1x2 Resultado
    if (nome.includes('vencedor') || nome === '1x2') {
      const sorted = itens.sort((a,b) => a.so - b.so); // so = sort order
      if (sorted[0]) odds.resultado.casa   = p(sorted[0].sv);
      if (sorted[1]) odds.resultado.empate = p(sorted[1].sv);
      if (sorted[2]) odds.resultado.fora   = p(sorted[2].sv);
    }

    // Total gols
    else if (nome.includes('total') && !nome.includes('brasil') && !nome.includes('japão') && !nome.includes('escanteio')) {
      for (const item of itens) {
        const n = (item.name || '').toLowerCase();
        const v = p(item.sv);
        if (!v) continue;
        const linhaM = n.match(/(\d+[.,]\d)/);
        if (linhaM) odds.totalGols.linha = parseFloat(linhaM[1].replace(',', '.'));
        if (n.includes('mais') || n.includes('+') || n.includes('over')) odds.totalGols.mais = v;
        if (n.includes('menos') || n.includes('-') || n.includes('under')) odds.totalGols.menos = v;
      }
    }

    // Ambas marcam
    else if (nome.includes('ambas') || nome.includes('btts')) {
      for (const item of itens) {
        const n = (item.name || '').toLowerCase();
        const v = p(item.sv);
        if (n.includes('sim') || n === 'yes') odds.ambasMarcam.sim = v;
        if (n.includes('não') || n === 'no') odds.ambasMarcam.nao = v;
      }
    }

    // Primeiro gol
    else if (nome.includes('primeiro gol') || nome === 'primeiro a marcar') {
      const sorted = itens.sort((a,b) => a.so - b.so);
      if (sorted[0]) odds.primeiroGol.casa   = p(sorted[0].sv);
      if (sorted[1]) odds.primeiroGol.fora   = p(sorted[1].sv);
      const nenhumItem = itens.find(i => (i.name||'').toLowerCase().includes('nenhum'));
      if (nenhumItem) odds.primeiroGol.nenhum = p(nenhumItem.sv);
    }

    // Chance dupla
    else if (nome.includes('chance dupla') || nome.includes('double chance')) {
      const sorted = itens.sort((a,b) => a.so - b.so);
      if (sorted[0]) odds.chanceDupla.casaEmpate = p(sorted[0].sv);
      if (sorted[1]) odds.chanceDupla.casaFora   = p(sorted[1].sv);
      if (sorted[2]) odds.chanceDupla.empataFora  = p(sorted[2].sv);
    }

    // Para qualificar
    else if (nome.includes('qualificar') || nome.includes('avançar') || nome.includes('classificar')) {
      const sorted = itens.sort((a,b) => a.so - b.so);
      if (sorted[0]) odds.qualificar.casa = p(sorted[0].sv);
      if (sorted[1]) odds.qualificar.fora = p(sorted[1].sv);
    }

    // Escanteios
    else if (nome.includes('escanteio') || nome.includes('corner')) {
      for (const item of itens) {
        const n = (item.name || '').toLowerCase();
        const v = p(item.sv);
        if (!v) continue;
        const linhaM = n.match(/(\d+[.,]\d)/);
        if (linhaM) odds.escanteios.linha = parseFloat(linhaM[1].replace(',', '.'));
        if (n.includes('mais') || n.includes('+')) odds.escanteios.mais = v;
        if (n.includes('menos') || n.includes('-')) odds.escanteios.menos = v;
      }
    }

    // Handicap
    else if (nome.includes('handicap') && !nome.includes('europeu')) {
      for (const item of itens) {
        const n = item.name || '';
        const v = p(item.sv);
        const linhaM = n.match(/([+-]?\d+[.,]?\d*)/);
        if (v && linhaM) odds.handicap.push({ linha: linhaM[1], odd: v });
      }
    }

    // Resultado correto
    else if (nome.includes('resultado correto') || nome.includes('correct score')) {
      for (const item of itens) {
        const n = item.name || '';
        const v = p(item.sv);
        const pM = n.match(/(\d+)[:\-x](\d+)/i);
        if (v && pM) {
          const g1 = parseInt(pM[1]), g2 = parseInt(pM[2]);
          odds.placares.push({ placar: `${g1}-${g2}`, odd: v, time: g1>g2?'casa':g1<g2?'fora':'empate' });
        }
      }
    }
  }

  // Fallback: se resultado ainda vazio, buscar diretamente nos childMarkets por nome
  if (!odds.resultado.casa) {
    logger.scraper('Fallback: buscando resultado em todos os childMarkets...');
    const vencedor = cm.find(c => c.name?.toLowerCase().includes('brasil') && c.typeId && c.sv > 1);
    // Buscar pelo nome do sportMarketId do mercado "Vencedor do encontro"
    const mktVencedor = Object.entries(mks).find(([,m]) => m.name?.toLowerCase().includes('vencedor'));
    if (mktVencedor) {
      const [vencedorId] = mktVencedor;
      const selecoes = cm.filter(c => String(c.sportMarketId) === String(vencedorId));
      logger.scraper(`Fallback vencedor: ${selecoes.length} seleções`);
      const sorted = selecoes.sort((a,b) => a.so - b.so);
      if (sorted[0]) odds.resultado.casa   = p(sorted[0].sv);
      if (sorted[1]) odds.resultado.empate = p(sorted[1].sv);
      if (sorted[2]) odds.resultado.fora   = p(sorted[2].sv);
    }
  }

  // Segundo fallback: buscar por typeId nos mercados
  if (!odds.resultado.casa) {
    logger.scraper('Fallback 2: buscando por typeId nos mercados...');
    for (const [id, market] of Object.entries(mks)) {
      const nome = (market.name || '').toLowerCase();
      if (nome.includes('vencedor') || nome === '1x2') {
        const selecoes = cm.filter(c => c.sportMarketId === parseInt(id) || c.typeId === parseInt(id));
        logger.scraper(`Fallback 2: ${market.name} → ${selecoes.length} seleções`);
        if (selecoes.length >= 2) {
          const sorted = selecoes.sort((a,b) => (a.so||0) - (b.so||0));
          odds.resultado.casa   = p(sorted[0]?.sv);
          odds.resultado.empate = p(sorted[1]?.sv);
          odds.resultado.fora   = p(sorted[2]?.sv);
          break;
        }
      }
    }
  }

  return odds;
}

// IDs fixos dos eventos Copa 2026 conhecidos
const IDS_COPA = [16913912]; // Brasil x Japão

async function executarScrape() {
  const resultados = [];

  for (const eventId of IDS_COPA) {
    try {
      logger.scraper(`Coletando evento ${eventId}...`);

      const json = await altenarGet('GetEventDetails', `eventId=${eventId}&showNonBoosts=true`);
      const ev   = json.Result || json;

      // Info básica dos times
      const comp     = ev.competitors || [];
      const nomeCasa = comp[0]?.name  || 'Casa';
      const nomeFora = comp[1]?.name  || 'Fora';
      const abbCasa  = comp[0]?.abbreviation || 'CA';
      const abbFora  = comp[1]?.abbreviation || 'FO';

      // Data/hora
      let data = '--/--', hora = '--:--';
      if (ev.startDate) {
        const d = new Date(ev.startDate);
        data = d.toLocaleDateString('pt-BR');
        hora = d.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
      }

      const odds = parsearOdds(ev);

      logger.ok(`${nomeCasa} x ${nomeFora} — resultado: ${odds.resultado.casa}/${odds.resultado.empate}/${odds.resultado.fora}`);

      resultados.push({
        info: {
          id: `${nomeCasa.toLowerCase().replace(/\s+/g,'-')}-vs-${nomeFora.toLowerCase().replace(/\s+/g,'-')}`,
          eventId: String(eventId),
          nomeCasa, nomeFora, abbCasa, abbFora,
          competicao: ev.champ?.name || 'Copa do Mundo 2026',
          fase: '16-avos de final',
          data, hora,
          estadio: 'NRG Stadium, Houston',
          status: 'pre',
        },
        odds,
        coletadoEm: new Date().toISOString(),
      });

      await new Promise(r => setTimeout(r, 600));
    } catch (err) {
      logger.error(`Evento ${eventId}: ${err.message}`);
    }
  }

  return resultados;
}

async function scrapeListaJogos() { return []; }

module.exports = { executarScrape, scrapeListaJogos };
