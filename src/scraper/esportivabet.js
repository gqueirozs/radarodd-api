/**
 * Scraper da EsportivaBet usando a API interna do Altenar
 * Descoberta via análise de tráfego de rede: GetEventDetails e GetSportEvents
 */
const logger = require('../utils/logger');

const ALTENAR_BASE = 'https://sb2frontend-altenar2.biahosted.com/api/widget';
const ALTENAR_PARAMS = 'culture=pt-BR&timezoneOffset=180&integration=esportiva&deviceType=1&numFormat=en-GB&countryCode=BR';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Referer': 'https://esportiva.bet.br/',
  'Origin': 'https://esportiva.bet.br',
};

async function fetchAltenar(endpoint, params = '') {
  const url = `${ALTENAR_BASE}/${endpoint}?${ALTENAR_PARAMS}${params ? '&' + params : ''}`;
  logger.scraper(`GET ${endpoint}`);
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${endpoint}`);
  return res.json();
}

// Buscar lista de eventos de futebol/copa
async function buscarEventosCopa() {
  try {
    // Endpoint para listar eventos por categoria
    const data = await fetchAltenar('GetSportEvents', 'sportIds=1&champIds=&withLive=false&outrightsDisplay=none&couponType=0');
    
    const eventos = data?.Result?.Items || data?.Items || data?.events || [];
    logger.scraper(`${eventos.length} eventos retornados`);

    // Filtrar apenas Copa do Mundo 2026
    return eventos.filter(e =>
      e?.ChampionshipName?.toLowerCase().includes('copa') ||
      e?.ChampionshipName?.toLowerCase().includes('world cup') ||
      e?.ChampionshipId === 16913912 ||
      (e?.HomeTeam?.toLowerCase().includes('brasil') || e?.HomeTeam?.toLowerCase().includes('brazil'))
    );
  } catch (err) {
    logger.warn(`GetSportEvents falhou: ${err.message}`);
    return [];
  }
}

// Buscar detalhes completos de um evento por ID
async function buscarDetalhesEvento(eventId) {
  try {
    const data = await fetchAltenar('GetEventDetails', `eventId=${eventId}&showNonBoosts=true`);
    return data?.Result || data;
  } catch (err) {
    logger.error(`GetEventDetails ${eventId} falhou: ${err.message}`);
    return null;
  }
}

// Parsear odds do formato Altenar para o formato RadarOdd
function parsearOddsAltenar(detalhes) {
  const odds = {
    resultado: {},
    totalGols: { linha: 2.5 },
    ambasMarcam: {},
    primeiroGol: {},
    chanceDupla: {},
    qualificar: {},
    escanteios: { linha: 9.5 },
    handicap: [],
    placares: [],
  };

  if (!detalhes?.Markets) return odds;

  for (const market of detalhes.Markets) {
    const nome = (market.MarketName || market.Name || '').toLowerCase();
    const selecoes = market.Selections || market.Odds || [];

    // 1x2 Resultado
    if (nome.includes('vencedor') || nome === '1x2' || nome.includes('resultado final')) {
      for (const sel of selecoes) {
        const n = (sel.Name || '').toLowerCase();
        const odd = parseFloat(sel.Price || sel.Odd || 0);
        if (!odd) continue;
        if (n.includes('empate') || n === 'x') odds.resultado.empate = odd;
        else if (selecoes.indexOf(sel) === 0 || n.includes('1')) odds.resultado.casa = odd;
        else odds.resultado.fora = odd;
      }
    }

    // Total gols
    if (nome.includes('total de gols') && !nome.includes('brasil') && !nome.includes('japão') && !nome.includes('jap')) {
      for (const sel of selecoes) {
        const n = (sel.Name || '').toLowerCase();
        const odd = parseFloat(sel.Price || sel.Odd || 0);
        const linhaMatch = n.match(/(\d+[.,]\d)/);
        if (linhaMatch) odds.totalGols.linha = parseFloat(linhaMatch[1].replace(',', '.'));
        if (n.includes('mais') || n.includes('over') || n.includes('+')) odds.totalGols.mais = odd;
        if (n.includes('menos') || n.includes('under') || n.includes('-')) odds.totalGols.menos = odd;
      }
    }

    // Ambas marcam
    if (nome.includes('ambas') || nome.includes('btts') || nome.includes('ambas as equipes')) {
      for (const sel of selecoes) {
        const n = (sel.Name || '').toLowerCase();
        const odd = parseFloat(sel.Price || sel.Odd || 0);
        if (n.includes('sim') || n === 'yes') odds.ambasMarcam.sim = odd;
        if (n.includes('não') || n === 'no') odds.ambasMarcam.nao = odd;
      }
    }

    // Primeiro gol
    if (nome.includes('primeiro gol') || nome.includes('first goal scorer')) {
      for (const sel of selecoes) {
        const n = (sel.Name || '').toLowerCase();
        const odd = parseFloat(sel.Price || sel.Odd || 0);
        if (n.includes('nenhum') || n.includes('sem gol') || n === 'no goal') odds.primeiroGol.nenhum = odd;
        else if (selecoes.indexOf(sel) === 0) odds.primeiroGol.casa = odd;
        else odds.primeiroGol.fora = odd;
      }
    }

    // Chance dupla
    if (nome.includes('chance dupla') || nome.includes('double chance')) {
      for (const [i, sel] of selecoes.entries()) {
        const odd = parseFloat(sel.Price || sel.Odd || 0);
        if (i === 0) odds.chanceDupla.casaEmpate = odd;
        else if (i === 1) odds.chanceDupla.casaFora = odd;
        else odds.chanceDupla.empataFora = odd;
      }
    }

    // Para qualificar
    if (nome.includes('qualificar') || nome.includes('para avançar') || nome.includes('classificar')) {
      for (const [i, sel] of selecoes.entries()) {
        const odd = parseFloat(sel.Price || sel.Odd || 0);
        if (i === 0) odds.qualificar.casa = odd;
        else odds.qualificar.fora = odd;
      }
    }

    // Escanteios
    if (nome.includes('escanteio') || nome.includes('corner')) {
      for (const sel of selecoes) {
        const n = (sel.Name || '').toLowerCase();
        const odd = parseFloat(sel.Price || sel.Odd || 0);
        const linhaMatch = n.match(/(\d+[.,]\d)/);
        if (linhaMatch) odds.escanteios.linha = parseFloat(linhaMatch[1].replace(',', '.'));
        if (n.includes('mais') || n.includes('+')) odds.escanteios.mais = odd;
        if (n.includes('menos') || n.includes('-')) odds.escanteios.menos = odd;
      }
    }

    // Handicap
    if (nome.includes('handicap') && !nome.includes('europeu')) {
      for (const sel of selecoes) {
        const n = sel.Name || '';
        const odd = parseFloat(sel.Price || sel.Odd || 0);
        const linhaMatch = n.match(/([+-]?\d+[.,]?\d*)/);
        if (odd && linhaMatch) odds.handicap.push({ linha: linhaMatch[1], odd });
      }
    }

    // Resultado correto
    if (nome.includes('resultado correto') || nome.includes('correct score')) {
      for (const sel of selecoes) {
        const n = sel.Name || '';
        const odd = parseFloat(sel.Price || sel.Odd || 0);
        const placarMatch = n.match(/(\d+)[:\-x](\d+)/i);
        if (odd && placarMatch) {
          const g1 = parseInt(placarMatch[1]);
          const g2 = parseInt(placarMatch[2]);
          odds.placares.push({
            placar: `${g1}-${g2}`,
            odd,
            time: g1 > g2 ? 'casa' : g1 < g2 ? 'fora' : 'empate',
          });
        }
      }
    }
  }

  return odds;
}

// Parsear informações do evento (times, data, hora)
function parsearInfoEvento(detalhes, eventId) {
  const home = detalhes?.HomeTeam || detalhes?.HomeTeamName || 'Casa';
  const away = detalhes?.AwayTeam || detalhes?.AwayTeamName || 'Fora';
  const dataHora = detalhes?.EventDate || detalhes?.StartDate || '';

  let data = '--/--', hora = '--:--';
  if (dataHora) {
    const d = new Date(dataHora);
    data = d.toLocaleDateString('pt-BR');
    hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  const champ = detalhes?.ChampionshipName || 'Copa do Mundo 2026';

  return {
    id: `${home.toLowerCase().replace(/\s+/g, '-')}-vs-${away.toLowerCase().replace(/\s+/g, '-')}`,
    eventId: String(eventId),
    nomeCasa: home,
    nomeFora: away,
    competicao: champ,
    data,
    hora,
    estadio: detalhes?.Venue || detalhes?.Stadium || '',
  };
}

// IDs fixos dos eventos da Copa conhecidos
const EVENTOS_COPA_IDS = [
  16913912, // Brasil vs Japão
];

// Função principal exportada
async function executarScrape(urlsOuIds = []) {
  const resultados = [];

  // Tentar descobrir eventos dinamicamente primeiro
  try {
    const eventosDinamicos = await buscarEventosCopa();
    for (const ev of eventosDinamicos) {
      const id = ev.EventId || ev.Id;
      if (id && !EVENTOS_COPA_IDS.includes(id)) EVENTOS_COPA_IDS.push(id);
    }
  } catch (err) {
    logger.warn(`Busca dinâmica falhou: ${err.message}`);
  }

  // Coletar detalhes de cada evento
  for (const eventId of EVENTOS_COPA_IDS) {
    try {
      logger.scraper(`Coletando evento ${eventId}...`);
      const detalhes = await buscarDetalhesEvento(eventId);
      if (!detalhes) continue;

      const info = parsearInfoEvento(detalhes, eventId);
      const odds = parsearOddsAltenar(detalhes);

      resultados.push({ info, odds, coletadoEm: new Date().toISOString() });
      logger.ok(`Evento ${eventId} coletado: ${info.nomeCasa} x ${info.nomeFora}`);

      // Pausa entre requests
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      logger.error(`Erro evento ${eventId}: ${err.message}`);
    }
  }

  return resultados;
}

async function scrapeListaJogos() {
  return buscarEventosCopa();
}

module.exports = { executarScrape, scrapeListaJogos };
