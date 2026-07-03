/**
 * Chaveamento do mata-mata da Copa 2026, montado automaticamente
 * a partir do scoreboard público da ESPN.
 *
 * Fases classificadas pela janela de datas oficial (48 seleções):
 *   Segunda rodada (32-avos): 28/06 – 03/07
 *   Oitavas de final:         04/07 – 07/07
 *   Quartas de final:         09/07 – 11/07
 *   Semifinal:                14/07 – 15/07
 *   Terceiro lugar:           18/07
 *   Final:                    19/07
 *
 * Se a ESPN trouxer a nota da rodada no evento, ela tem prioridade
 * sobre a janela de datas.
 */
const cache  = require('../utils/cache');
const logger = require('../utils/logger');
const { confrontoId } = require('../utils/slug');

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (SinalOdds/1.0)', 'Accept': 'application/json' };

const JANELAS = [
  { fase: 'segunda',  ini: '2026-06-28', fim: '2026-07-03' },
  { fase: 'oitavas',  ini: '2026-07-04', fim: '2026-07-08' },
  { fase: 'quartas',  ini: '2026-07-09', fim: '2026-07-12' },
  { fase: 'semis',    ini: '2026-07-14', fim: '2026-07-16' },
  { fase: 'terceiro', ini: '2026-07-18', fim: '2026-07-18' },
  { fase: 'final',    ini: '2026-07-19', fim: '2026-07-19' },
];
const RANGE = '20260628-20260719';

const NOTAS_FASE = [
  [/round of 32|32.?avos|segunda rodada/i, 'segunda'],
  [/round of 16|oitavas/i,                 'oitavas'],
  [/quarter|quartas/i,                     'quartas'],
  [/semi/i,                                'semis'],
  [/third|terceiro/i,                      'terceiro'],
  [/\bfinal\b/i,                           'final'],
];

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  return res.json();
}

function faseDoEvento(ev) {
  // 1) nota/headline da ESPN, quando existe
  const textos = [];
  const comp = ev?.competitions?.[0];
  for (const n of (comp?.notes || [])) textos.push(n.headline || n.text || '');
  textos.push(ev?.season?.slug || '', comp?.type?.abbreviation || '');
  const junto = textos.join(' ');
  for (const [re, fase] of NOTAS_FASE) {
    if (re.test(junto)) return fase;
  }
  // 2) janela de datas
  const dia = (ev.date || '').slice(0, 10);
  for (const j of JANELAS) {
    if (dia >= j.ini && dia <= j.fim) return j.fase;
  }
  return null;
}

function parseEventoBracket(ev) {
  const comp = ev?.competitions?.[0];
  const lados = comp?.competitors || [];
  const casa = lados.find(c => c.homeAway === 'home') || lados[0];
  const fora = lados.find(c => c.homeAway === 'away') || lados[1];
  if (!casa || !fora) return null;

  const st = ev?.status?.type || comp?.status?.type || {};
  const status = st.completed ? 'encerrado' : (st.state === 'in' ? 'ao-vivo' : 'agendado');

  const lado = c => ({
    nome:     c.team?.displayName || c.team?.name || 'A definir',
    sigla:    c.team?.abbreviation || '',
    placar:   status === 'agendado' ? null : Number(c.score?.value ?? c.score ?? 0),
    penaltis: c.shootoutScore != null ? Number(c.shootoutScore) : null,
    vencedor: c.winner === true,
  });

  return {
    eventoId: String(ev.id),
    fase:     faseDoEvento(ev),
    data:     ev.date,
    status,
    relogio:  status === 'ao-vivo' ? (st.detail || ev?.status?.displayClock || '') : null,
    prorrogacao: /aet|prorroga/i.test(st.detail || st.description || ''),
    casa: lado(casa),
    fora: lado(fora),
  };
}

/* Anexa nossas odds (cache do scraper Altenar) aos jogos ainda agendados */
function anexarOdds(jogos) {
  const lista = cache.get('jogos:lista') || [];
  const porSlug = new Map();
  for (const j of lista) {
    porSlug.set(confrontoId(j.casa?.nome, j.fora?.nome), j);
    porSlug.set(confrontoId(j.fora?.nome, j.casa?.nome), j); // ordem invertida
  }
  for (const jogo of jogos) {
    const hit = porSlug.get(confrontoId(jogo.casa.nome, jogo.fora.nome));
    if (hit) {
      jogo.jogoId = hit.id;             // permite abrir o Analisador
      jogo.odds = hit.odds?.resultado ? {
        casa: hit.odds.resultado.casa, empate: hit.odds.resultado.empate, fora: hit.odds.resultado.fora,
      } : null;
      // se a ordem estava invertida na Altenar, inverte as odds
      if (hit.casa?.nome && confrontoId(hit.casa.nome, hit.fora?.nome) !== confrontoId(jogo.casa.nome, jogo.fora.nome) && jogo.odds) {
        jogo.odds = { casa: jogo.odds.fora, empate: jogo.odds.empate, fora: jogo.odds.casa };
      }
    }
  }
}

async function obterChaveamento() {
  const hit = cache.get('mata-mata');
  if (hit) return hit;

  let eventos = [];
  try {
    // 1ª tentativa: range completo em uma chamada
    const json = await fetchJson(`${SCOREBOARD}?dates=${RANGE}&limit=200&lang=pt&region=br`);
    eventos = json.events || [];
  } catch (e) {
    logger.warn(`ESPN scoreboard range falhou (${e.message}), tentando dia a dia`);
  }

  if (eventos.length === 0) {
    // Fallback: dia a dia dentro das janelas do mata-mata
    for (const j of JANELAS) {
      let d = new Date(`${j.ini}T00:00:00Z`);
      const fim = new Date(`${j.fim}T00:00:00Z`);
      while (d <= fim) {
        const yyyymmdd = d.toISOString().slice(0, 10).replace(/-/g, '');
        try {
          const json = await fetchJson(`${SCOREBOARD}?dates=${yyyymmdd}&limit=50&lang=pt&region=br`);
          eventos.push(...(json.events || []));
        } catch { /* dia sem jogos ou falha pontual */ }
        d = new Date(d.getTime() + 86400000);
      }
    }
  }

  const fases = { segunda: [], oitavas: [], quartas: [], semis: [], terceiro: [], final: [] };
  const vistos = new Set();
  for (const ev of eventos) {
    if (vistos.has(String(ev.id))) continue;
    vistos.add(String(ev.id));
    const p = parseEventoBracket(ev);
    if (p && p.fase && fases[p.fase]) fases[p.fase].push(p);
  }
  for (const fase of Object.values(fases)) {
    fase.sort((a, b) => new Date(a.data) - new Date(b.data));
    anexarOdds(fase);
  }

  const temAoVivo = Object.values(fases).some(f => f.some(j => j.status === 'ao-vivo'));
  const resp = {
    ok: true,
    fonte: 'ESPN',
    atualizadoEm: new Date().toISOString(),
    fases,
    totais: Object.fromEntries(Object.entries(fases).map(([k, v]) => [k, v.length])),
  };

  // Ao vivo: cache curto pra placar acompanhar; sem jogo rolando, 5 min
  cache.set('mata-mata', resp, temAoVivo ? 60 * 1000 : 5 * 60 * 1000);
  return resp;
}

/**
 * Anota jogos da nossa API (Altenar) com o status real vindo da ESPN:
 * statusReal ('agendado'|'ao-vivo'|'encerrado'), placar e relógio.
 * Usa o cache do chaveamento — custo praticamente zero.
 */
async function anexarStatusReal(jogos) {
  if (!Array.isArray(jogos) || jogos.length === 0) return jogos;
  let chave;
  try {
    chave = await obterChaveamento();
  } catch { return jogos; }
  if (!chave?.fases) return jogos;

  const porSlug = new Map();
  for (const fase of Object.values(chave.fases)) {
    for (const ev of fase) {
      const key = confrontoId(ev.casa.nome, ev.fora.nome);
      porSlug.set(key, ev);
      porSlug.set(confrontoId(ev.fora.nome, ev.casa.nome), { ...ev, invertido: true });
    }
  }

  for (const j of jogos) {
    const ev = porSlug.get(confrontoId(j.casa?.nome, j.fora?.nome));
    if (!ev) continue;
    // eventoId/liga sempre — permite buscar escalações e local no Analisador
    j.eventoId = ev.eventoId;
    j.ligaEspn = 'fifa.world';
    if (ev.status === 'agendado') continue;
    const casa = ev.invertido ? ev.fora : ev.casa;
    const fora = ev.invertido ? ev.casa : ev.fora;
    j.statusReal = ev.status;
    j.relogio = ev.relogio || null;
    j.prorrogacao = !!ev.prorrogacao;
    j.placar = {
      casa: casa.placar, fora: fora.placar,
      penaltisCasa: casa.penaltis, penaltisFora: fora.penaltis,
    };
  }
  return jogos;
}

module.exports = { obterChaveamento, anexarStatusReal };
