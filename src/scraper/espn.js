/**
 * Estatísticas reais via API pública da ESPN (sem chave).
 *
 * Endpoints usados:
 *  - Times da Copa:  site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/teams
 *  - Agenda do time: site.api.espn.com/apis/site/v2/sports/soccer/{liga}/teams/{id}/schedule?season=YYYY
 *  - Detalhe do jogo: site.api.espn.com/apis/site/v2/sports/soccer/{liga}/summary?event={id}
 *    (traz keyEvents com gols/cartões e boxscore com faltas etc.)
 *
 * Tudo com cache agressivo em memória — jogo encerrado não muda.
 */
const cache  = require('../utils/cache');
const logger = require('../utils/logger');
const { nomeParaId } = require('../utils/slug');

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const LIGAS = ['fifa.world', 'fifa.friendly']; // Copa + amistosos
const TEMPORADAS = [2026, 2025];
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (SinalOdds/1.0)', 'Accept': 'application/json' };

// Aliases pt-BR → possíveis slugs da ESPN (pt e en)
const ALIASES = {
  'estados-unidos': ['usa', 'united-states', 'eua'],
  'rd-congo':       ['republica-democratica-do-congo', 'dr-congo', 'congo-dr'],
  'costa-do-marfim':['ivory-coast', 'cote-d-ivoire'],
  'cabo-verde':     ['cape-verde-islands', 'cape-verde'],
  'coreia-do-sul':  ['south-korea'],
  'irlanda-do-norte': ['northern-ireland'],
  'arabia-saudita': ['saudi-arabia'],
};

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`ESPN ${res.status} em ${url}`);
  return res.json();
}

/* ── Mapa nome → teamId ──────────────────────────────────────────── */
async function mapaTimes() {
  const hit = cache.get('espn:times');
  if (hit) return hit;

  const mapa = new Map(); // slug → { id, nome }
  for (const lang of ['pt', 'en']) {
    try {
      const json = await fetchJson(`${BASE}/fifa.world/teams?limit=200&lang=${lang}&region=${lang === 'pt' ? 'br' : 'us'}`);
      const times = json?.sports?.[0]?.leagues?.[0]?.teams || [];
      for (const t of times) {
        const team = t.team || {};
        for (const nome of [team.displayName, team.name, team.shortDisplayName, team.location]) {
          const slug = nomeParaId(nome);
          if (slug && !mapa.has(slug)) mapa.set(slug, { id: String(team.id), nome: team.displayName });
        }
      }
    } catch (e) {
      logger.warn(`ESPN mapa de times (${lang}) falhou: ${e.message}`);
    }
  }
  if (mapa.size > 0) cache.set('espn:times', mapa, 24 * 60 * 60 * 1000);
  return mapa;
}

async function acharTime(nome) {
  const mapa = await mapaTimes();
  const slug = nomeParaId(nome);
  if (mapa.has(slug)) return mapa.get(slug);
  for (const alias of (ALIASES[slug] || [])) {
    if (mapa.has(alias)) return mapa.get(alias);
  }
  // busca parcial (ex: "Bósnia" vs "Bósnia e Herzegovina")
  for (const [k, v] of mapa) {
    if (k.includes(slug) || slug.includes(k)) return v;
  }
  return null;
}

/* ── Resultados recentes de um time ──────────────────────────────── */
function parseEvento(ev, teamId, liga) {
  const comp = ev?.competitions?.[0] || ev;
  const lados = comp?.competitors || [];
  const eu   = lados.find(c => String(c.team?.id ?? c.id) === String(teamId));
  const ele  = lados.find(c => String(c.team?.id ?? c.id) !== String(teamId));
  if (!eu || !ele) return null;

  const done = (ev?.status?.type?.completed) ?? (comp?.status?.type?.completed) ?? false;
  if (!done) return null;

  const gEu  = Number(eu.score?.value ?? eu.score ?? NaN);
  const gEle = Number(ele.score?.value ?? ele.score ?? NaN);
  if (Number.isNaN(gEu) || Number.isNaN(gEle)) return null;

  return {
    eventoId:   String(ev.id),
    liga,
    data:       ev.date,
    competicao: ev?.season?.slug || ev?.league?.name || (liga === 'fifa.world' ? 'Copa do Mundo' : 'Amistoso internacional'),
    adversario: ele.team?.displayName || ele.team?.name || '?',
    adversarioId: String(ele.team?.id ?? ele.id),
    golsPro:    gEu,
    golsContra: gEle,
    resultado:  gEu > gEle ? 'V' : gEu < gEle ? 'D' : 'E',
    emCasa:     eu.homeAway === 'home',
  };
}

async function resultadosTime(teamId) {
  const key = `espn:resultados:${teamId}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const eventos = [];
  for (const liga of LIGAS) {
    for (const season of TEMPORADAS) {
      try {
        const json = await fetchJson(`${BASE}/${liga}/teams/${teamId}/schedule?season=${season}&lang=pt&region=br`);
        for (const ev of (json.events || [])) {
          const p = parseEvento(ev, teamId, liga);
          if (p) eventos.push(p);
        }
      } catch { /* liga/temporada sem dados para esse time — normal */ }
    }
  }

  // Dedup por eventoId, mais recente primeiro
  const vistos = new Set();
  const unicos = eventos.filter(e => !vistos.has(e.eventoId) && vistos.add(e.eventoId));
  unicos.sort((a, b) => new Date(b.data) - new Date(a.data));

  cache.set(key, unicos, 6 * 60 * 60 * 1000);
  return unicos;
}

/* ── Detalhes de um jogo (gols, cartões, faltas) ─────────────────── */
function extrairEstatistica(boxTeam, nomes) {
  for (const n of nomes) {
    const st = (boxTeam?.statistics || []).find(s => (s.name || '').toLowerCase() === n);
    if (st) return st.displayValue ?? st.value;
  }
  return null;
}

async function detalhesJogo(eventoId, liga) {
  const key = `espn:detalhe:${eventoId}`;
  const hit = cache.get(key);
  if (hit) return hit;

  try {
    const json = await fetchJson(`${BASE}/${liga}/summary?event=${eventoId}&lang=pt&region=br`);

    const gols = [];
    const cartoes = [];
    for (const ke of (json.keyEvents || [])) {
      const tipo = (ke.type?.id || ke.type?.text || '').toString().toLowerCase();
      const texto = (ke.type?.text || '').toLowerCase();
      const jogador = ke.participants?.[0]?.athlete?.displayName || null;
      const minuto  = ke.clock?.displayValue || '';
      const timeId  = String(ke.team?.id || '');
      if (texto.includes('goal') || texto.includes('gol') || tipo === '70' || tipo === '137' || tipo === '98') {
        if (!texto.includes('own') || true) gols.push({ jogador, minuto, timeId, contra: texto.includes('own') || texto.includes('contra') });
      } else if (texto.includes('yellow') || texto.includes('amarelo')) {
        cartoes.push({ tipo: 'amarelo', jogador, minuto, timeId });
      } else if (texto.includes('red') || texto.includes('vermelho')) {
        cartoes.push({ tipo: 'vermelho', jogador, minuto, timeId });
      }
    }

    const faltas = {};
    for (const bt of (json.boxscore?.teams || [])) {
      const tid = String(bt.team?.id || '');
      faltas[tid] = {
        faltas:     extrairEstatistica(bt, ['foulscommitted', 'fouls']),
        escanteios: extrairEstatistica(bt, ['wonCorners'.toLowerCase(), 'cornerkicks', 'corners']),
        posse:      extrairEstatistica(bt, ['possessionpct', 'possession']),
        chutesGol:  extrairEstatistica(bt, ['shotsongoal', 'shotsontarget']),
      };
    }

    const det = { gols, cartoes, faltas };
    cache.set(key, det, 24 * 60 * 60 * 1000); // jogo encerrado não muda
    return det;
  } catch (e) {
    logger.warn(`ESPN detalhe ${eventoId} falhou: ${e.message}`);
    return null;
  }
}

/* ── Confronto completo: últimos jogos de cada time + H2H ────────── */
async function confronto(nomeCasa, nomeFora) {
  const key = `espn:confronto:${nomeParaId(nomeCasa)}:${nomeParaId(nomeFora)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const [tCasa, tFora] = await Promise.all([acharTime(nomeCasa), acharTime(nomeFora)]);
  if (!tCasa && !tFora) return { ok: false, mensagem: 'Times não encontrados na ESPN' };

  const [rCasa, rFora] = await Promise.all([
    tCasa ? resultadosTime(tCasa.id) : [],
    tFora ? resultadosTime(tFora.id) : [],
  ]);

  // H2H: jogos da casa contra o id do visitante (e vice-versa como reserva)
  const h2hBase = tCasa && tFora
    ? rCasa.filter(j => j.adversarioId === tFora.id)
    : [];

  // Enriquecer com detalhes: H2H completo + 3 últimos de cada time
  const paraDetalhar = [
    ...h2hBase,
    ...rCasa.slice(0, 3),
    ...rFora.slice(0, 3),
  ];
  const vistos = new Set();
  await Promise.all(paraDetalhar.map(async j => {
    if (vistos.has(j.eventoId)) return;
    vistos.add(j.eventoId);
    j.detalhes = await detalhesJogo(j.eventoId, j.liga);
  }));

  const resp = {
    ok: true,
    fonte: 'ESPN',
    casa: tCasa ? { nome: nomeCasa, espnId: tCasa.id, ultimos: rCasa.slice(0, 6) } : null,
    fora: tFora ? { nome: nomeFora, espnId: tFora.id, ultimos: rFora.slice(0, 6) } : null,
    h2h: h2hBase,
    resumoH2H: {
      vitoriasCasa: h2hBase.filter(j => j.resultado === 'V').length,
      empates:      h2hBase.filter(j => j.resultado === 'E').length,
      vitoriasFora: h2hBase.filter(j => j.resultado === 'D').length,
      total:        h2hBase.length,
    },
  };

  cache.set(key, resp, 6 * 60 * 60 * 1000);
  return resp;
}

/* ── Detalhes de um evento: local, escalações e banco ────────────── */
function parseRoster(r) {
  const jogador = it => ({
    nome:    it.athlete?.displayName || it.athlete?.fullName || '?',
    numero:  it.jersey ?? it.athlete?.jersey ?? null,
    posicao: it.position?.abbreviation || it.athlete?.position?.abbreviation || '',
  });
  const itens = r?.roster || [];
  return {
    time:      r?.team?.displayName || '',
    formacao:  r?.formation || null,
    titulares: itens.filter(i => i.starter === true).map(jogador),
    banco:     itens.filter(i => i.starter !== true).map(jogador),
  };
}

const ESTATS_PARTIDA = [
  { label: 'Chutes',            nomes: ['totalshots', 'shots', 'shotsattempted'] },
  { label: 'Chutes a gol',      nomes: ['shotsontarget', 'shotsongoal'] },
  { label: 'Posse de bola',     nomes: ['possessionpct', 'possession'], sufixo: '%' },
  { label: 'Passes',            nomes: ['totalpasses', 'passes', 'passesattempted'] },
  { label: 'Precisão de passe', nomes: ['passpct', 'passcompletionpct', 'accuratepasspct'], sufixo: '%' },
  { label: 'Faltas',            nomes: ['foulscommitted', 'fouls'] },
  { label: 'Cartões amarelos',  nomes: ['yellowcards'] },
  { label: 'Cartões vermelhos', nomes: ['redcards'] },
  { label: 'Impedimentos',      nomes: ['offsides'] },
  { label: 'Escanteios',        nomes: ['woncorners', 'cornerkicks', 'corners'] },
  { label: 'Defesas',           nomes: ['saves', 'goalkeepersaves'] },
];

function estatisticasDaPartida(boxscore, casaId, foraId) {
  const times = boxscore?.teams || [];
  const porId = {};
  for (const bt of times) porId[String(bt.team?.id || '')] = bt;
  const btCasa = porId[casaId];
  const btFora = porId[foraId];
  if (!btCasa && !btFora) return [];

  const pegar = (bt, nomes) => {
    for (const n of nomes) {
      const st = (bt?.statistics || []).find(x => (x.name || '').toLowerCase() === n);
      if (st) return st.displayValue ?? st.value ?? null;
    }
    return null;
  };

  const linhas = [];
  for (const e of ESTATS_PARTIDA) {
    const c = pegar(btCasa, e.nomes);
    const f = pegar(btFora, e.nomes);
    if (c != null || f != null) {
      linhas.push({ label: e.label, casa: c, fora: f, sufixo: e.sufixo || '' });
    }
  }
  return linhas;
}

async function eventoDetalhes(eventoId, liga = 'fifa.world') {
  const key = `espn:evento:${eventoId}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const json = await fetchJson(`${BASE}/${liga}/summary?event=${eventoId}&lang=pt&region=br`);

  const venue = json?.gameInfo?.venue || {};
  const local = {
    estadio: venue.fullName || null,
    cidade:  venue.address?.city || null,
    pais:    venue.address?.country || null,
  };

  const rosters = (json?.rosters || []).map(parseRoster)
    .filter(r => r.titulares.length > 0 || r.banco.length > 0);
  const casaRoster = (json?.rosters || []).findIndex(r => r.homeAway === 'home');

  const arbitros = (json?.gameInfo?.officials || [])
    .map(o => o.displayName || o.fullName).filter(Boolean);

  // ── Estado do jogo + placar (header do summary) ──────────────────
  const compHeader = json?.header?.competitions?.[0] || {};
  const stHeader = compHeader?.status?.type || {};
  const status = stHeader.completed ? 'encerrado' : (stHeader.state === 'in' ? 'ao-vivo' : 'agendado');
  const compCasa = (compHeader.competitors || []).find(c => c.homeAway === 'home');
  const compFora = (compHeader.competitors || []).find(c => c.homeAway === 'away');
  const casaId = String(compCasa?.team?.id ?? compCasa?.id ?? '');
  const foraId = String(compFora?.team?.id ?? compFora?.id ?? '');

  // ── Lances: gols e cartões (keyEvents) ───────────────────────────
  const gols = [];
  const cartoes = [];
  for (const ke of (json.keyEvents || [])) {
    const texto = ((ke.type?.text || '') + ' ' + (ke.text || '')).toLowerCase();
    const jogador = ke.participants?.[0]?.athlete?.displayName || null;
    const minuto  = ke.clock?.displayValue || '';
    const timeId  = String(ke.team?.id || '');
    if (/goal|gol|p.nalti convertido/.test(texto) && !/perdido|missed|anulado|disallowed/.test(texto)) {
      gols.push({ jogador, minuto, timeId, contra: /own|contra/.test(texto), penalti: /penalty|p.nalti/.test(texto) });
    } else if (/yellow|amarelo/.test(texto)) {
      cartoes.push({ tipo: 'amarelo', jogador, minuto, timeId });
    } else if (/red|vermelho/.test(texto)) {
      cartoes.push({ tipo: 'vermelho', jogador, minuto, timeId });
    }
  }

  // Probabilidade de vitória ao vivo (lance a lance) — último ponto da série
  let probAoVivo = null;
  const wp = Array.isArray(json.winprobability) && json.winprobability.length
    ? json.winprobability[json.winprobability.length - 1] : null;
  if (wp && wp.homeWinPercentage != null) {
    const casaP   = Math.round((wp.homeWinPercentage ?? 0) * 100);
    const empateP = wp.tiePercentage != null ? Math.round(wp.tiePercentage * 100) : null;
    const foraP   = wp.awayWinPercentage != null
      ? Math.round(wp.awayWinPercentage * 100)
      : Math.max(0, 100 - casaP - (empateP ?? 0));
    probAoVivo = { casa: casaP, empate: empateP ?? Math.max(0, 100 - casaP - foraP), fora: foraP };
  }

  const det = {
    ok: true,
    status,
    probAoVivo,
    relogio: status === 'ao-vivo' ? (stHeader.detail || compHeader?.status?.displayClock || '') : null,
    placar: status === 'agendado' ? null : {
      casa: Number(compCasa?.score ?? 0),
      fora: Number(compFora?.score ?? 0),
    },
    casaId, foraId,
    gols, cartoes,
    estatisticas: status === 'agendado' ? [] : estatisticasDaPartida(json.boxscore, casaId, foraId),
    local,
    arbitros,
    escalacoes: rosters.length === 2 ? {
      casa: casaRoster === 1 ? rosters[1] : rosters[0],
      fora: casaRoster === 1 ? rosters[0] : rosters[1],
    } : null,
  };

  // TTL: ao vivo 45s (placar/lances fresquinhos); encerrado 24h;
  // agendado 5 min sem escalação, 30 min com escalação publicada
  const ttl = status === 'ao-vivo' ? 45 * 1000
    : status === 'encerrado' ? 24 * 60 * 60 * 1000
    : det.escalacoes ? 30 * 60 * 1000 : 5 * 60 * 1000;
  cache.set(key, det, ttl);
  return det;
}

module.exports = { confronto, acharTime, eventoDetalhes };
