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
  // 2) janela de datas — SEMPRE no fuso de Brasília (22:30 BRT já é
  //    o dia seguinte em UTC e classificava o jogo na fase errada)
  const dt = new Date(ev.date || 0);
  const dia = Number.isNaN(dt.getTime())
    ? (ev.date || '').slice(0, 10)
    : dt.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
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
    relogio:  status === 'ao-vivo' ? (ev?.status?.displayClock || comp?.status?.displayClock || st.detail || '') : null,
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

  const chaves = montarChaves(fases);

  const temAoVivo = Object.values(fases).some(f => f.some(j => j.status === 'ao-vivo'));
  const resp = {
    ok: true,
    fonte: 'ESPN',
    atualizadoEm: new Date().toISOString(),
    fases,
    chaves,
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

/* ── Montagem das 2 chaves (árvore do bracket) ────────────────────
 * A ESPN numera os confrontos nos placeholders:
 *   "Vencedor 14 dos 16avos"        → alimentado pelo jogo 14 da 2ª rodada
 *   "Vencedor oitavas de final (5)" → alimentado pelas oitavas 5
 *   "Vencedor quartas de final (1)" → alimentado pelas quartas 1
 * Numeração oficial: Q(k) recebe O(2k-1) e O(2k); Semi(m) recebe
 * Q(2m-1) e Q(2m). Chave A = árvore da Semi 1; Chave B = Semi 2.
 * Onde os times já estão definidos, ligamos pelo vencedor real.
 */
function refsDoJogo(jogo) {
  const refs = [];
  for (const lado of [jogo.casa, jogo.fora]) {
    const n = lado?.nome || '';
    let m = n.match(/\((\d+)\)/);
    if (!m) m = n.match(/(\d+)\s+dos\s+16/i);
    if (m) refs.push(+m[1]);
  }
  return refs;
}

const ehDefinido = nome => nome && nome !== 'A definir' && !/vencedor|perdedor|winner|loser|\d+ dos/i.test(nome);

function montarChaves(fases) {
  const porData = f => [...(fases[f] || [])].sort((a, b) => new Date(a.data) - new Date(b.data));
  const segunda = porData('segunda');
  const oitavas = porData('oitavas');
  const quartas = porData('quartas');
  const semis   = porData('semis');

  // Copa 2026 (48 seleções): 32 na segunda rodada → 16 oitavas → 8 quartas
  // → 4 semis (2 por chave) → 2 finais (final + 3º lugar).
  // Nós dividimos em 2 chaves visuais (A e B) só para o layout, cada uma
  // ficando com metade do bracket alimentando UMA final.
  segunda.forEach((j, i) => { j.ordem = i + 1; });
  oitavas.forEach((j, i) => { j.ordem = i + 1; });

  // Quartas: refs de oitavas 1–16 (Copa tem 16 oitavas)
  quartas.forEach((j, i) => {
    const refs = refsDoJogo(j).filter(n => n >= 1 && n <= 16);
    j.feeds = refs.length ? refs : [2 * (i + 1) - 1, 2 * (i + 1)];
    j.ordem = Math.ceil(Math.min(...j.feeds) / 2); // ordem 1-8 (8 quartas)
  });
  quartas.sort((a, b) => a.ordem - b.ordem);

  // Semis: refs de quartas 1–8 (Copa tem 8 quartas)
  semis.forEach((j, i) => {
    const refs = refsDoJogo(j).filter(n => n >= 1 && n <= 8);
    j.feeds = refs.length ? refs : [2 * (i + 1) - 1, 2 * (i + 1)];
    j.ordem = Math.ceil(Math.min(...j.feeds) / 2); // ordem 1-4 (4 semis)
  });
  semis.sort((a, b) => a.ordem - b.ordem);

  // 2ª rodada → oitavas: primeiro pelo vencedor real, depois pelo nº do placeholder
  const usados = new Set();
  const alimentadores = new Map(); // ordemOitavas → [jogoSegunda|null, jogoSegunda|null]
  for (const o of oitavas) {
    const feeds = [null, null];
    [o.casa, o.fora].forEach((lado, idx) => {
      if (ehDefinido(lado?.nome)) {
        const alvo = nomeParaIdLocal(lado.nome);
        const g = segunda.find(sg => !usados.has(sg.eventoId) && sg.status === 'encerrado' &&
          nomeParaIdLocal((sg.casa.vencedor ? sg.casa : sg.fora.vencedor ? sg.fora : {}).nome) === alvo);
        if (g) { feeds[idx] = g; usados.add(g.eventoId); }
      } else {
        const m = (lado?.nome || '').match(/(\d+)/);
        if (m) {
          const g = segunda.find(sg => sg.ordem === +m[1] && !usados.has(sg.eventoId));
          if (g) { feeds[idx] = g; usados.add(g.eventoId); }
        }
      }
    });
    alimentadores.set(o.ordem, feeds);
  }
  // Sobras (sem link possível): distribui pela numeração O(k) ← S(2k-1),S(2k)
  for (const sg of segunda) {
    if (usados.has(sg.eventoId)) continue;
    const alvo = Math.ceil(sg.ordem / 2);
    const feeds = alimentadores.get(alvo);
    if (feeds) {
      const vaga = feeds[0] == null ? 0 : feeds[1] == null ? 1 : -1;
      if (vaga >= 0) { feeds[vaga] = sg; usados.add(sg.eventoId); }
    }
  }

  // Divisão A/B é FIXA por ordem (segue layout oficial FIFA):
  //   Chave A: ordens 1-16 na segunda, 1-8 nas oitavas, 1-4 nas quartas, 1-2 nas semis
  //   Chave B: ordens 17-32 na segunda, 9-16 nas oitavas, 5-8 nas quartas, 3-4 nas semis
  // Determinística e sem depender de feeds que a ESPN pode não ter publicado.
  const montarChave = (nome) => {
    const isA = nome === 'Chave A';
    const rangeSegunda = isA ? [1, 16]  : [17, 32];
    const rangeOitavas = isA ? [1, 8]   : [9, 16];
    const rangeQuartas = isA ? [1, 4]   : [5, 8];
    const rangeSemis   = isA ? [1, 2]   : [3, 4];

    const pegar = (arr, [ini, fim]) => {
      const r = [];
      for (let k = ini; k <= fim; k++) {
        r.push(arr.find(x => x.ordem === k) || null);
      }
      return r;
    };

    return {
      nome,
      semis:   pegar(semis,   rangeSemis),
      quartas: pegar(quartas, rangeQuartas),
      oitavas: pegar(oitavas, rangeOitavas),
      segunda: pegar(segunda, rangeSegunda),
    };
  };

  return [ montarChave('Chave A'), montarChave('Chave B') ];
}

// normalização local leve (evita import circular com utils/slug em runtime)
function nomeParaIdLocal(nome) {
  return (nome || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-');
}

module.exports = { obterChaveamento, anexarStatusReal };
