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

// Os value bets NÃO são estimados aqui: o agendador enriquece cada jogo
// com a análise empírica (src/analise/mercados.js), baseada nos resultados
// reais das seleções. Nunca inventamos probabilidade.

function parseJogo(dadosBrutos) {
  const {
    id, competicao, casa, fora, data, hora, estadio,
    odds: o,
  } = dadosBrutos;

  // Preenchido pelo enriquecimento empírico (agendador)
  const valueBets = [];

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
