/**
 * Scraper EsportivaBet — Copa do Mundo 2026
 *
 * ESTRATÉGIA NOVA (substitui varredura por ID sequencial):
 * Usa o endpoint GetEvents?champIds=3146 que retorna TODOS os jogos
 * já cadastrados da Copa do Mundo 2026 em uma única chamada, junto
 * com seus markets/odds. Muito mais rápido e confiável que varrer
 * IDs aleatórios (os IDs de eventos não são sequenciais/previsíveis).
 */
const logger = require('../utils/logger');
const db     = require('../db/mongo');
const { gerarOdds } = require('./geradorOdds');

const BASE     = 'https://sb2frontend-altenar2.biahosted.com/api/widget';
const PARAMS   = 'culture=pt-BR&timezoneOffset=180&integration=esportiva&deviceType=1&numFormat=en-GB&countryCode=BR';
const CHAMP_ID = 3146; // Copa do Mundo 2026 na Esportiva Bet / Altenar
const HDRS     = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
  'Accept': 'application/json',
  'Referer': 'https://esportiva.bet.br/',
};

// Mapa de tipos de mercado relevantes (Altenar typeId)
const TYPE_RESULTADO    = 1;  // 1 / X / 2
const TYPE_CHANCE_DUPLA = 10; // 1X / 12 / X2
const TYPE_TOTAL_GOLS   = 18; // mais/menos de N gols
const TYPE_AMBAS_MARCAM = 29; // sim/não

async function buscarEventosCopa() {
  const url = `${BASE}/GetEvents?${PARAMS}&eventCount=0&sportId=0&champIds=${CHAMP_ID}`;
  const res = await fetch(url, { headers: HDRS, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar eventos da Copa`);
  return res.json();
}

function montarMapaCompetidores(json) {
  const map = {};
  (json.competitors || []).forEach(c => { map[c.id] = c.name; });
  return map;
}

function montarMapaOdds(json) {
  const map = {};
  (json.odds || []).forEach(o => { if (o.id != null) map[o.id] = o; });
  return map;
}

function extrairOddsDoEvento(ev, json, oddsMap) {
  const marketsDoEvento = (ev.marketIds || [])
    .map(mid => (json.markets || []).find(m => m.id === mid))
    .filter(Boolean);

  const odds = {
    resultado:   { casa: null, empate: null, fora: null },
    chanceDupla: { casaEmpate: null, casaFora: null, empataFora: null },
    qualificar:  { casa: null, fora: null },
    totalGols:   { linha: 2.5, mais: null, menos: null },
    ambasMarcam: { sim: null, nao: null },
    primeiroGol: { casa: null, nenhum: null, fora: null },
    escanteios:  { linha: 9.5, mais: null, menos: null },
    handicap: [],
    placares: [],
  };

  // Resultado (1X2)
  const mResultado = marketsDoEvento.find(m => m.typeId === TYPE_RESULTADO);
  if (mResultado) {
    for (const oid of mResultado.oddIds) {
      const o = oddsMap[oid];
      if (!o) continue;
      if (o.typeId === 1) odds.resultado.casa = o.price;
      if (o.typeId === 2) odds.resultado.empate = o.price;
      if (o.typeId === 3) odds.resultado.fora = o.price;
    }
  }

  // Chance dupla
  const mChance = marketsDoEvento.find(m => m.typeId === TYPE_CHANCE_DUPLA);
  if (mChance) {
    for (const oid of mChance.oddIds) {
      const o = oddsMap[oid];
      if (!o) continue;
      if (o.name === '1X') odds.chanceDupla.casaEmpate = o.price;
      if (o.name === '12') odds.chanceDupla.casaFora = o.price;
      if (o.name === 'X2') odds.chanceDupla.empataFora = o.price;
    }
  }

  // Total de gols — pegar a linha mais próxima de 2.5 (mercado principal)
  const mercadosGols = marketsDoEvento.filter(m => m.typeId === TYPE_TOTAL_GOLS);
  if (mercadosGols.length) {
    const principal = mercadosGols.reduce((melhor, m) => {
      const linha = parseFloat(m.sv);
      const diffAtual = Math.abs(linha - 2.5);
      const diffMelhor = melhor ? Math.abs(parseFloat(melhor.sv) - 2.5) : Infinity;
      return diffAtual < diffMelhor ? m : melhor;
    }, null);
    if (principal) {
      odds.totalGols.linha = parseFloat(principal.sv);
      for (const oid of principal.oddIds) {
        const o = oddsMap[oid];
        if (!o) continue;
        if (o.typeId === 12) odds.totalGols.mais = o.price;
        if (o.typeId === 13) odds.totalGols.menos = o.price;
      }
    }
  }

  // Ambas marcam
  const mAmbas = marketsDoEvento.find(m => m.typeId === TYPE_AMBAS_MARCAM);
  if (mAmbas) {
    for (const oid of mAmbas.oddIds) {
      const o = oddsMap[oid];
      if (!o) continue;
      if (o.typeId === 74) odds.ambasMarcam.sim = o.price;
      if (o.typeId === 76) odds.ambasMarcam.nao = o.price;
    }
  }

  return odds;
}

function temOddsValidas(odds) {
  return !!(odds.resultado.casa && odds.resultado.fora);
}

function nomeParaId(nome) {
  return (nome || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function parsearEvento(ev, compMap, oddsMap) {
  const nomeCasa = compMap[ev.competitorIds?.[0]] || 'Casa';
  const nomeFora = compMap[ev.competitorIds?.[1]] || 'Fora';
  let data = '--/--', hora = '--:--';
  if (ev.startDate) {
    const d = new Date(ev.startDate);
    data = d.toLocaleDateString('pt-BR');
    hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  const odds = extrairOddsDoEvento(ev, ev._json, ev._oddsMap);
  const oddsFinal = temOddsValidas(odds) ? odds : gerarOdds(nomeCasa, nomeFora);

  const info = {
    id: `${nomeParaId(nomeCasa)}-vs-${nomeParaId(nomeFora)}`,
    eventId: String(ev.id),
    nomeCasa, nomeFora,
    abbCasa: nomeCasa.slice(0, 3).toUpperCase(),
    abbFora: nomeFora.slice(0, 3).toUpperCase(),
    competicao: 'Copa do Mundo 2026',
    fase: 'Copa 2026',
    data, hora,
    estadio: '',
    status: 'pre',
    startDate: ev.startDate || null,
  };

  return { info, odds: oddsFinal, coletadoEm: new Date().toISOString() };
}

// ── FUNÇÃO PRINCIPAL ─────────────────────────────────────────────────────────
async function executarScrape() {
  const resultados = [];
  const usandoMongo = !!process.env.MONGODB_URI;

  let json;
  try {
    json = await buscarEventosCopa();
  } catch (err) {
    logger.error(`Falha ao buscar eventos da Copa: ${err.message}`);
    // Fallback: usar o que estiver salvo no MongoDB
    if (usandoMongo) {
      const jogosDB = await db.getJogos();
      if (jogosDB && jogosDB.length) {
        logger.warn(`Usando ${jogosDB.length} jogos salvos no MongoDB como fallback`);
        return jogosDB.map(j => ({
          info: { ...j, id: j.id || `${nomeParaId(j.nomeCasa)}-vs-${nomeParaId(j.nomeFora)}` },
          odds: j.odds || gerarOdds(j.nomeCasa, j.nomeFora),
          coletadoEm: j.atualizadoEm || new Date().toISOString(),
        }));
      }
    }
    throw err;
  }

  const compMap = montarMapaCompetidores(json);
  const oddsMap = montarMapaOdds(json);
  const eventos = json.events || [];

  logger.scraper(`API retornou ${eventos.length} eventos da Copa do Mundo 2026`);

  for (const ev of eventos) {
    try {
      ev._json = json;
      ev._oddsMap = oddsMap;
      const parsed = parsearEvento(ev, compMap, oddsMap);
      resultados.push(parsed);
      if (usandoMongo) await db.upsertJogo(parsed.info, parsed.odds);
      logger.ok(`✦ ${parsed.info.nomeCasa} x ${parsed.info.nomeFora} (${parsed.info.data} ${parsed.info.hora})`);
    } catch (err) {
      logger.warn(`Erro ao processar evento ${ev.id}: ${err.message}`);
    }
  }

  // Complementar com jogos do banco que não vieram nesta rodada
  // (ex: jogos que já passaram da data e saíram da API ao vivo, mas ainda
  // queremos manter visíveis até o próximo ciclo de limpeza)
  // Deduplica por confronto (id slug), não por eventId — protege contra
  // registros antigos no banco salvos sob eventIds diferentes para o
  // mesmo confronto (resíduo do scraper antigo por varredura de IDs).
  if (usandoMongo) {
    const jogosDB = await db.getJogos();
    if (jogosDB && jogosDB.length) {
      const confrontosNaRodada = new Set(resultados.map(r => r.info.id));
      for (const j of jogosDB) {
        if (!j.nomeCasa || !j.nomeFora) continue;
        const idConfronto = `${nomeParaId(j.nomeCasa)}-vs-${nomeParaId(j.nomeFora)}`;
        if (confrontosNaRodada.has(idConfronto)) continue;
        confrontosNaRodada.add(idConfronto);
        resultados.push({
          info: { ...j, id: idConfronto },
          odds: j.odds || gerarOdds(j.nomeCasa, j.nomeFora),
          coletadoEm: j.atualizadoEm || new Date().toISOString(),
        });
      }
    }
  }

  // Dedup final de segurança por confronto (caso a API retorne duplicatas)
  const vistos = new Set();
  const resultadosUnicos = [];
  for (const r of resultados) {
    if (vistos.has(r.info.id)) continue;
    vistos.add(r.info.id);
    resultadosUnicos.push(r);
  }
  resultadosUnicos.sort((a, b) => (a.info.startDate || '').localeCompare(b.info.startDate || ''));
  logger.ok(`Total: ${resultadosUnicos.length} jogos da Copa do Mundo 2026`);
  resultadosUnicos._novosDescobertos = eventos.length;
  return resultadosUnicos;
}

async function scrapeListaJogos() { return []; }
module.exports = { executarScrape, scrapeListaJogos };
