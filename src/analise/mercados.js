/**
 * Motor de análise de mercados — 100% baseado em dados verificáveis.
 *
 * Para cada mercado com odd publicada:
 *   1. probImplicita  — 1/odd (o que a casa cobra)
 *   2. probJusta      — implícita SEM a margem da casa, normalizada dentro
 *                       do grupo do mercado (1X2 ou 2 vias)
 *   3. probEmpirica   — frequência REAL do evento nos últimos jogos das
 *                       duas seleções (ESPN), com a amostra explícita
 *   4. probFinal      — encolhimento bayesiano: média ponderada entre a
 *                       empírica e a justa, peso pela amostra
 *                       w = n/(n+K); pFinal = w·pEmp + (1−w)·pJusta
 *   5. ev             — pFinal · odd − 1 (em %)
 *
 * Classificação honesta: a maioria dos jogos NÃO tem valor. É impossível
 * dois lados do mesmo mercado terem EV positivo ao mesmo tempo.
 */

const K_ENCOLHIMENTO = 8; // amostras pequenas ficam coladas na prob. justa

function parseOdd(v) {
  if (!v) return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isNaN(n) || n <= 1 ? null : n;
}

/* Probabilidade justa: remove a margem normalizando o grupo completo */
function probsJustas(oddsGrupo) {
  const invs = oddsGrupo.map(o => (o ? 1 / o : null));
  const soma = invs.reduce((s, x) => s + (x || 0), 0);
  if (soma <= 0) return oddsGrupo.map(() => null);
  // só normaliza se o grupo está completo (senão a "margem" seria mentira)
  const completo = invs.every(x => x != null);
  return invs.map(x => (x == null ? null : completo ? x / soma : x));
}

function taxa(jogos, pred) {
  const n = jogos.length;
  const v = jogos.filter(pred).length;
  return { v, n, p: n > 0 ? v / n : null };
}

function analisarMercados(jogo, confrontoData) {
  const odds = jogo.odds || {};
  const jogosA = confrontoData?.casa?.ultimos || [];
  const jogosB = confrontoData?.fora?.ultimos || [];
  const h2h = confrontoData?.h2h || [];
  const nomeCasa = jogo.casa?.nome || 'Casa';
  const nomeFora = jogo.fora?.nome || 'Fora';

  const combinados = [...jogosA, ...jogosB];

  // ── Frequências empíricas (dos resultados reais) ─────────────────
  const btts   = taxa(combinados, j => j.golsPro > 0 && j.golsContra > 0);
  const over25 = taxa(combinados, j => j.golsPro + j.golsContra >= 3);
  const vitA   = taxa(jogosA, j => j.resultado === 'V');
  const derB   = taxa(jogosB, j => j.resultado === 'D');
  const vitB   = taxa(jogosB, j => j.resultado === 'V');
  const derA   = taxa(jogosA, j => j.resultado === 'D');

  // vitória de um lado: média entre "A vence seus jogos" e "B perde os dele"
  const pCasaEmp = (vitA.p != null && derB.p != null) ? (vitA.p + derB.p) / 2
    : vitA.p ?? derB.p;
  const pForaEmp = (vitB.p != null && derA.p != null) ? (vitB.p + derA.p) / 2
    : vitB.p ?? derA.p;

  // ── H2H: evidência direta quando existe ──────────────────────────
  const h2hBtts = taxa(h2h, j => j.golsPro > 0 && j.golsContra > 0);
  const h2hOver = taxa(h2h, j => j.golsPro + j.golsContra >= 3);
  const h2hCasa = taxa(h2h, j => j.resultado === 'V');

  // ── Probabilidades justas por grupo ──────────────────────────────
  const o1 = parseOdd(odds.resultado?.casa);
  const oX = parseOdd(odds.resultado?.empate);
  const o2 = parseOdd(odds.resultado?.fora);
  const [j1, , j2] = probsJustas([o1, oX, o2]);

  const oOver = parseOdd(odds.totalGols?.mais);
  const oUnder = parseOdd(odds.totalGols?.menos);
  const [jOver, jUnder] = probsJustas([oOver, oUnder]);

  const oSim = parseOdd(odds.ambasMarcam?.sim);
  const oNao = parseOdd(odds.ambasMarcam?.nao);
  const [jSim, jNao] = probsJustas([oSim, oNao]);

  const linha = odds.totalGols?.linha || 2.5;

  // ── Montagem dos mercados ─────────────────────────────────────────
  const defs = [
    { id: 'casa',  mercado: `${nomeCasa} vence`, odd: o1, pJusta: j1, pEmp: pCasaEmp,
      amostra: vitA.n + derB.n,
      evidencia: `${nomeCasa} venceu ${vitA.v} dos últimos ${vitA.n}; ${nomeFora} perdeu ${derB.v} dos últimos ${derB.n}`,
      h2hInfo: h2hCasa.n > 0 ? { v: h2hCasa.v, n: h2hCasa.n, texto: `${nomeCasa} venceu ${h2hCasa.v} de ${h2hCasa.n} confrontos diretos` } : null },
    { id: 'fora',  mercado: `${nomeFora} vence`, odd: o2, pJusta: j2, pEmp: pForaEmp,
      amostra: vitB.n + derA.n,
      evidencia: `${nomeFora} venceu ${vitB.v} dos últimos ${vitB.n}; ${nomeCasa} perdeu ${derA.v} dos últimos ${derA.n}`,
      h2hInfo: h2hCasa.n > 0 ? { v: h2hCasa.n - h2hCasa.v, n: h2hCasa.n, texto: `${nomeFora} não perdeu ${h2h.filter(x => x.resultado !== 'V').length} de ${h2hCasa.n} confrontos diretos` } : null },
    { id: 'over',  mercado: `Mais de ${linha} gols`, odd: oOver, pJusta: jOver, pEmp: over25.p,
      amostra: over25.n,
      evidencia: `Aconteceu em ${over25.v} dos últimos ${over25.n} jogos das duas seleções`,
      h2hInfo: h2hOver.n > 0 ? { v: h2hOver.v, n: h2hOver.n, texto: `No confronto direto: ${h2hOver.v} de ${h2hOver.n}` } : null },
    { id: 'under', mercado: `Menos de ${linha} gols`, odd: oUnder, pJusta: jUnder, pEmp: over25.p != null ? 1 - over25.p : null,
      amostra: over25.n,
      evidencia: `Aconteceu em ${over25.n - over25.v} dos últimos ${over25.n} jogos das duas seleções`,
      h2hInfo: h2hOver.n > 0 ? { v: h2hOver.n - h2hOver.v, n: h2hOver.n, texto: `No confronto direto: ${h2hOver.n - h2hOver.v} de ${h2hOver.n}` } : null },
    { id: 'btts',  mercado: 'Ambas marcam — Sim', odd: oSim, pJusta: jSim, pEmp: btts.p,
      amostra: btts.n,
      evidencia: `Ambas marcaram em ${btts.v} dos últimos ${btts.n} jogos das duas seleções`,
      h2hInfo: h2hBtts.n > 0 ? { v: h2hBtts.v, n: h2hBtts.n, texto: `No confronto direto: ${h2hBtts.v} de ${h2hBtts.n}` } : null },
    { id: 'bttsNao', mercado: 'Ambas marcam — Não', odd: oNao, pJusta: jNao, pEmp: btts.p != null ? 1 - btts.p : null,
      amostra: btts.n,
      evidencia: `Pelo menos uma não marcou em ${btts.n - btts.v} dos últimos ${btts.n} jogos`,
      h2hInfo: h2hBtts.n > 0 ? { v: h2hBtts.n - h2hBtts.v, n: h2hBtts.n, texto: `No confronto direto: ${h2hBtts.n - h2hBtts.v} de ${h2hBtts.n}` } : null },
  ];

  const mercados = [];
  for (const d of defs) {
    if (!d.odd) continue;
    // sem prob. justa (grupo incompleto) usamos a implícita crua — e dizemos isso
    const pImplicita = 1 / d.odd;
    const pJusta = d.pJusta ?? pImplicita;

    let pFinal = pJusta;
    let w = 0;
    if (d.pEmp != null && d.amostra > 0) {
      w = d.amostra / (d.amostra + K_ENCOLHIMENTO);
      pFinal = w * d.pEmp + (1 - w) * pJusta;
    }
    const ev = (pFinal * d.odd - 1) * 100;

    let nivel = 'neutro';
    if (d.pEmp != null) {
      if (ev >= 8 && d.pEmp > pJusta) nivel = 'forte';
      else if (ev >= 3 && d.pEmp > pJusta) nivel = 'valor';
      else if (ev <= -8) nivel = 'evitar';
    }

    mercados.push({
      id: d.id,
      mercado: d.mercado,
      odd: d.odd,
      probImplicita: +(pImplicita * 100).toFixed(1),
      probJusta: +(pJusta * 100).toFixed(1),
      probEmpirica: d.pEmp != null ? +(d.pEmp * 100).toFixed(1) : null,
      probFinal: +(pFinal * 100).toFixed(1),
      amostra: d.amostra,
      pesoEmpirico: +(w * 100).toFixed(0),
      ev: +ev.toFixed(1),
      nivel,
      evidencia: d.evidencia,
      h2h: d.h2hInfo,
    });
  }

  mercados.sort((a, b) => b.ev - a.ev);

  // Sinais no formato dos cards da Home (apenas valor real)
  const sinais = mercados
    .filter(m => m.nivel === 'forte' || m.nivel === 'valor')
    .map(m => ({
      mercado: m.mercado,
      odd: m.odd,
      probReal: m.probFinal,
      ev: m.ev,
      forca: m.nivel === 'forte' ? 'alta' : 'media',
      evidencia: m.evidencia,
    }));

  return {
    ok: true,
    base: {
      jogosAnalisados: combinados.length,
      confrontosDiretos: h2h.length,
      metodologia: `Frequência real nos últimos jogos (ESPN) combinada com a probabilidade justa das odds (sem margem), ponderada pela amostra (peso empírico ${Math.round((combinados.length / (combinados.length + K_ENCOLHIMENTO)) * 100)}%).`,
    },
    mercados,
    sinais,
  };
}

module.exports = { analisarMercados };
