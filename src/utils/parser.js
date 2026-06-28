/**
 * Transforma os dados brutos extraídos pelo scraper
 * no formato padrão usado pela API e pelo frontend
 */

function parseOdd(valor) {
  if (!valor) return null;
  const n = parseFloat(String(valor).replace(',', '.'));
  return isNaN(n) ? null : n;
}

function calcProbImplicita(odd) {
  if (!odd || odd <= 0) return null;
  return parseFloat((100 / odd).toFixed(1));
}

function calcEV(odd, probRealEstimada) {
  if (!odd || !probRealEstimada) return null;
  return parseFloat(((odd * probRealEstimada) - 1) * 100).toFixed(1);
}

// Estimativa de probabilidade real baseada em modelo simples
// (na versão completa isso viria de um modelo estatístico)
function estimarProbReal(mercado, oddCasa, oddFora, odd) {
  const margem = 1 / oddCasa + 1 / (oddFora || 1);
  const probSemMargem = (1 / odd) / margem;
  // Ajuste conservador: assume mercado com 2-5% de edge
  return parseFloat((probSemMargem * 0.97).toFixed(3));
}

function detectarValueBet(mercado, odd, probReal) {
  const ev = parseFloat(calcEV(odd, probReal));
  if (ev > 8) return { forca: 'alta', ev };
  if (ev > 3) return { forca: 'media', ev };
  if (ev > 0) return { forca: 'baixa', ev };
  return null;
}

function parseJogo(dadosBrutos) {
  const {
    id, competicao, casa, fora, data, hora, estadio,
    odds: o,
  } = dadosBrutos;

  // Calcular value bets automaticamente
  const valueBets = [];
  const oddCasa = parseOdd(o?.resultado?.casa);
  const oddFora = parseOdd(o?.resultado?.fora);

  const mercadosParaAnalisar = [
    { mercado: `${casa?.nome} vence`, odd: oddCasa },
    { mercado: `${fora?.nome} vence`, odd: oddFora },
    { mercado: `Mais de ${o?.totalGols?.linha || 2.5} gols`, odd: parseOdd(o?.totalGols?.mais) },
    { mercado: `Menos de ${o?.totalGols?.linha || 2.5} gols`, odd: parseOdd(o?.totalGols?.menos) },
    { mercado: 'Ambas marcam — Sim', odd: parseOdd(o?.ambasMarcam?.sim) },
    { mercado: 'Ambas marcam — Não', odd: parseOdd(o?.ambasMarcam?.nao) },
    { mercado: `${casa?.nome} marca primeiro`, odd: parseOdd(o?.primeiroGol?.casa) },
  ];

  for (const { mercado, odd } of mercadosParaAnalisar) {
    if (!odd) continue;
    const probReal = estimarProbReal(mercado, oddCasa, oddFora, odd);
    const vb = detectarValueBet(mercado, odd, probReal);
    if (vb) {
      valueBets.push({ mercado, odd, probReal, ...vb });
    }
  }

  // Ordenar por EV decrescente
  valueBets.sort((a, b) => b.ev - a.ev);

  return {
    id,
    competicao,
    data,
    hora,
    estadio,
    status: 'pre',
    casa: {
      ...casa,
      gp: casa?.gp || 0,
      gc: casa?.gc || 0,
      forma: casa?.forma || [],
    },
    fora: {
      ...fora,
      gp: fora?.gp || 0,
      gc: fora?.gc || 0,
      forma: fora?.forma || [],
    },
    odds: {
      resultado: {
        casa: parseOdd(o?.resultado?.casa),
        empate: parseOdd(o?.resultado?.empate),
        fora: parseOdd(o?.resultado?.fora),
      },
      chanceDupla: {
        casaEmpate: parseOdd(o?.chanceDupla?.casaEmpate),
        casaFora: parseOdd(o?.chanceDupla?.casaFora),
        empataFora: parseOdd(o?.chanceDupla?.empataFora),
      },
      qualificar: {
        casa: parseOdd(o?.qualificar?.casa),
        fora: parseOdd(o?.qualificar?.fora),
      },
      totalGols: {
        linha: o?.totalGols?.linha || 2.5,
        mais: parseOdd(o?.totalGols?.mais),
        menos: parseOdd(o?.totalGols?.menos),
      },
      ambasMarcam: {
        sim: parseOdd(o?.ambasMarcam?.sim),
        nao: parseOdd(o?.ambasMarcam?.nao),
      },
      primeiroGol: {
        casa: parseOdd(o?.primeiroGol?.casa),
        nenhum: parseOdd(o?.primeiroGol?.nenhum),
        fora: parseOdd(o?.primeiroGol?.fora),
      },
      escanteios: {
        linha: o?.escanteios?.linha || 9.5,
        mais: parseOdd(o?.escanteios?.mais),
        menos: parseOdd(o?.escanteios?.menos),
      },
      handicap: (o?.handicap || []).map(h => ({
        linha: h.linha,
        odd: parseOdd(h.odd),
      })),
      placares: (o?.placares || []).map(p => ({
        placar: p.placar,
        odd: parseOdd(p.odd),
        time: p.time,
      })),
    },
    valueBets,
    atualizadoEm: new Date().toISOString(),
  };
}

module.exports = { parseJogo, parseOdd, calcEV, calcProbImplicita };
