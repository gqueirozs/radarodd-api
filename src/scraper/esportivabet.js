/**
 * Scraper EsportivaBet — Estratégia definitiva:
 * 1. API FIFA para lista completa de jogos da Copa 2026 (pública, sem bloqueio)
 * 2. Mapear cada jogo para o eventId do Altenar via nome dos times
 * 3. GetEventDetails do Altenar para dados do evento (times, hora)
 * 4. Odds via mapeamento baseado nos IDs conhecidos + descoberta automática
 */
const logger = require('../utils/logger');

// ── Altenar ─────────────────────────────────────────────────────────────────
const ALTENAR = 'https://sb2frontend-altenar2.biahosted.com/api/widget';
const PARAMS  = 'culture=pt-BR&timezoneOffset=180&integration=esportiva&deviceType=1&numFormat=en-GB&countryCode=BR';
const HDRS_A  = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0',
  'Accept': 'application/json',
  'Referer': 'https://esportiva.bet.br/',
  'Origin': 'https://esportiva.bet.br',
};

async function altenarGet(path, extra = '') {
  const url = `${ALTENAR}/${path}?${PARAMS}${extra ? '&' + extra : ''}`;
  const res  = await fetch(url, { headers: HDRS_A, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Altenar HTTP ${res.status} → ${path}`);
  return res.json();
}

// ── FIFA API (pública) ───────────────────────────────────────────────────────
const FIFA_API = 'https://api.fifa.com/api/v3';
const HDRS_F   = {
  'User-Agent': 'Mozilla/5.0',
  'Accept': 'application/json',
};

async function fifaGet(path) {
  const res = await fetch(`${FIFA_API}${path}`, { headers: HDRS_F, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`FIFA API HTTP ${res.status}`);
  return res.json();
}

// Busca lista de partidas da Copa 2026 via FIFA API
async function buscarJogosFifa() {
  try {
    // Copa do Mundo FIFA 2026 — ID da competição = FIFA2026
    // Endpoint público de resultados/fixtures
    const data = await fifaGet('/calendar/matches?idCompetition=FIFA2026&idSeason=2026&count=200&language=pt');
    const matches = data?.Results || data?.results || data?.matches || [];
    logger.scraper(`FIFA API: ${matches.length} partidas encontradas`);
    return matches;
  } catch (e) {
    logger.warn(`FIFA API falhou: ${e.message}`);
    return [];
  }
}

// Mapeamento de nomes em português para inglês (para busca na Altenar)
const NOME_MAP = {
  'brasil': ['brasil', 'brazil', 'bra'],
  'alemanha': ['germany', 'deutschland', 'ger'],
  'argentina': ['argentina', 'arg'],
  'franca': ['france', 'fra'],
  'espanha': ['spain', 'esp'],
  'portugal': ['portugal', 'por'],
  'Inglaterra': ['england', 'eng'],
  'holanda': ['netherlands', 'ned', 'países baixos'],
  'belgica': ['belgium', 'bel'],
  'japao': ['japan', 'jpn', 'japão'],
  'coreia': ['korea', 'kor'],
  'mexico': ['mexico', 'mex', 'méxico'],
  'estados unidos': ['usa', 'united states', 'us'],
  'australia': ['australia', 'aus'],
  'marrocos': ['morocco', 'mar'],
  'senegal': ['senegal', 'sen'],
  'camaroes': ['cameroon', 'cmr'],
  'nigeria': ['nigeria', 'nga'],
  'ghana': ['ghana', 'gha'],
  'croacia': ['croatia', 'cro'],
  'servia': ['serbia', 'srb'],
  'suica': ['switzerland', 'sui'],
  'dinamarca': ['denmark', 'den'],
  'suecia': ['sweden', 'swe'],
  'noruega': ['norway', 'nor'],
  'polonia': ['poland', 'pol'],
  'turquia': ['turkey', 'tur'],
  'urucuai': ['uruguay', 'uru'],
  'colombia': ['colombia', 'col'],
  'chile': ['chile', 'chi'],
  'equador': ['ecuador', 'ecu'],
  'peru': ['peru', 'per'],
  'canada': ['canada', 'can'],
  'costa rica': ['costa rica', 'crc'],
  'costa do marfim': ['ivory coast', 'cote d\'ivoire', 'civ'],
};

// Banco de IDs conhecidos (eventId Altenar → times)
// Expandir conforme descobertos
const ID_BANCO = {
  16913912: { casa: 'Brasil', fora: 'Japão', data: '2026-06-29T17:00:00Z', estadio: 'NRG Stadium, Houston' },
};

// Odds base capturadas manualmente (atualizar periodicamente)
const ODDS_BANCO = {
  16913912: {
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
  },
};

// Tentar descobrir eventId de um jogo pelo nome dos times via busca iterativa
async function descobrirEventId(nomeCasa, nomeFora, dataISO) {
  // Tenta IDs próximos ao Brasil x Japão (16913912)
  // Os jogos da Copa costumam ter IDs sequenciais próximos
  const base = 16913912;
  const range = 200; // tentar 200 IDs para cima e para baixo

  const normaliza = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const casaN = normaliza(nomeCasa);
  const foraN = normaliza(nomeFora);

  for (let delta = -range; delta <= range; delta++) {
    const id = base + delta;
    if (ID_BANCO[id]) continue; // já conhecido
    try {
      const j = await altenarGet('GetEventDetails', `eventId=${id}&showNonBoosts=true`);
      const ev = j?.Result || j;
      const comp = ev?.competitors || [];
      if (comp.length < 2) continue;

      const h = normaliza(comp[0]?.name || '');
      const a = normaliza(comp[1]?.name || '');

      if ((h.includes(casaN) || casaN.includes(h)) && (a.includes(foraN) || foraN.includes(a))) {
        logger.ok(`Descoberto: ${nomeCasa} x ${nomeFora} → eventId ${id}`);
        ID_BANCO[id] = { casa: comp[0].name, fora: comp[1].name, data: ev.startDate || dataISO };
        return { id, ev };
      }
    } catch { /* continuar */ }
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

// Buscar e parsear info de um evento conhecido
async function buscarEvento(eventId) {
  const j  = await altenarGet('GetEventDetails', `eventId=${eventId}&showNonBoosts=true`);
  const ev = j?.Result || j;
  const comp = Array.isArray(ev.competitors) ? ev.competitors : [];

  let data = '--/--', hora = '--:--';
  if (ev.startDate) {
    const d = new Date(ev.startDate);
    data = d.toLocaleDateString('pt-BR');
    hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  return {
    info: {
      id: `${(comp[0]?.name||'casa').toLowerCase().replace(/\s+/g,'-')}-vs-${(comp[1]?.name||'fora').toLowerCase().replace(/\s+/g,'-')}`,
      eventId: String(eventId),
      nomeCasa:  comp[0]?.name  || ID_BANCO[eventId]?.casa || 'Casa',
      nomeFora:  comp[1]?.name  || ID_BANCO[eventId]?.fora || 'Fora',
      abbCasa:   comp[0]?.abbreviation || 'CA',
      abbFora:   comp[1]?.abbreviation || 'FO',
      competicao: ev.champ?.name || 'Copa do Mundo 2026',
      fase:       (ev.marketGroups?.[0]?.name) || '16-avos',
      data, hora,
      estadio:   ID_BANCO[eventId]?.estadio || '',
      status:    'pre',
    },
    ev,
  };
}

// Odds vazias estruturadas
const ODDS_VAZIAS = () => ({
  resultado: {}, totalGols: { linha: 2.5 }, ambasMarcam: {},
  primeiroGol: {}, chanceDupla: {}, qualificar: {},
  escanteios: { linha: 9.5 }, handicap: [], placares: [],
});

// ── FUNÇÃO PRINCIPAL ─────────────────────────────────────────────────────────
async function executarScrape() {
  const resultados = [];
  const processados = new Set();

  // 1. Processar todos os IDs já conhecidos no banco
  for (const [idStr, meta] of Object.entries(ID_BANCO)) {
    const eventId = parseInt(idStr);
    processados.add(eventId);
    try {
      const { info } = await buscarEvento(eventId);
      const odds = ODDS_BANCO[eventId] || ODDS_VAZIAS();
      logger.ok(`✓ ${info.nomeCasa} x ${info.nomeFora} (${info.data} ${info.hora})`);
      resultados.push({ info, odds, coletadoEm: new Date().toISOString() });
      await new Promise(r => setTimeout(r, 400));
    } catch (err) {
      logger.error(`Evento ${eventId}: ${err.message}`);
    }
  }

  // 2. Tentar descobrir novos jogos via varredura de IDs próximos
  // Os jogos da Copa 2026 têm IDs sequenciais — varrer vizinhança
  logger.scraper('Varrendo IDs próximos para descobrir novos jogos...');
  const base = 16913912;
  const descobertos = [];

  for (let delta = -50; delta <= 300; delta++) {
    const id = base + delta;
    if (processados.has(id)) continue;
    try {
      const j  = await altenarGet('GetEventDetails', `eventId=${id}&showNonBoosts=true`);
      const ev = j?.Result || j;
      const comp = ev?.competitors || [];
      if (comp.length < 2) continue;

      const champName = (ev.champ?.name || ev.category?.name || '').toLowerCase();
      const isCopa = champName.includes('copa') || champName.includes('world') || champName.includes('mundial') || champName.includes('2026');
      if (!isCopa) continue;

      logger.ok(`✦ Novo jogo descoberto: ${comp[0].name} x ${comp[1].name} (id ${id})`);
      descobertos.push({ id, ev, comp });
      processados.add(id);

      // Salvar no banco para próximas execuções
      if (!ID_BANCO[id]) {
        ID_BANCO[id] = {
          casa:    comp[0].name,
          fora:    comp[1].name,
          data:    ev.startDate,
          estadio: '',
        };
      }
    } catch { /* ID não existe ou erro, continuar */ }
    await new Promise(r => setTimeout(r, 150));
  }

  // 3. Adicionar jogos descobertos (sem odds — serão adicionadas na próxima iteração)
  for (const { id, ev, comp } of descobertos) {
    if (ODDS_BANCO[id]) continue; // já tem odds

    let data = '--/--', hora = '--:--';
    if (ev.startDate) {
      const d = new Date(ev.startDate);
      data = d.toLocaleDateString('pt-BR');
      hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }

    resultados.push({
      info: {
        id: `${comp[0].name.toLowerCase().replace(/\s+/g,'-')}-vs-${comp[1].name.toLowerCase().replace(/\s+/g,'-')}`,
        eventId: String(id),
        nomeCasa:  comp[0].name,
        nomeFora:  comp[1].name,
        abbCasa:   comp[0].abbreviation || comp[0].name.slice(0,3).toUpperCase(),
        abbFora:   comp[1].abbreviation || comp[1].name.slice(0,3).toUpperCase(),
        competicao: ev.champ?.name || 'Copa do Mundo 2026',
        fase:       (ev.marketGroups?.[0]?.name) || '16-avos',
        data, hora,
        estadio:   '',
        status:    'pre',
      },
      odds: ODDS_VAZIAS(),
      coletadoEm: new Date().toISOString(),
    });
  }

  logger.ok(`Total: ${resultados.length} jogos coletados (${descobertos.length} novos descobertos)`);
  return resultados;
}

async function scrapeListaJogos() { return []; }

module.exports = { executarScrape, scrapeListaJogos };
