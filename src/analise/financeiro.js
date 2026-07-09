/**
 * Ferramentas de gestão financeira para apostadores informados.
 *
 * Estas funções trabalham com os SINAIS já calculados pelo motor empírico
 * (src/analise/mercados.js). Não inventamos probabilidades — usamos as
 * `probFinal` (encolhimento bayesiano entre frequência real e prob. justa
 * das odds) que o motor já produz.
 */

/**
 * Critério de Kelly — quanto do bankroll apostar dado o EV.
 * f* = (b*p - q) / b   onde  b = odd - 1, p = prob, q = 1 - p
 *
 * Retornamos "quarter Kelly" (25% do sugerido). Isso é o padrão da indústria
 * profissional porque Kelly cheio é matematicamente ótimo mas empiricamente
 * volátil demais (uma seca de 5 apostas pode zerar 40% do bankroll).
 *
 * @returns Fração do bankroll sugerida (0-1). Zero se EV negativo.
 */
function kellyQuarter(prob, odd) {
  if (!prob || !odd || odd <= 1) return 0;
  const p = prob;         // probabilidade real (nossa estimativa)
  const q = 1 - p;
  const b = odd - 1;      // ganho líquido por unidade apostada
  const fCheio = (b * p - q) / b;
  if (fCheio <= 0) return 0;   // EV negativo → não apostar
  return fCheio * 0.25;        // quarter Kelly, mais seguro
}

/**
 * Retorno de uma aposta simples.
 * @param stake  Valor apostado (R$)
 * @param odd    Cotação decimal
 * @param prob   Probabilidade real (0-1) — usada pra EV esperado
 */
function retornoAposta(stake, odd, prob = null) {
  const retornoBruto = stake * odd;      // se acertar
  const lucroBruto = retornoBruto - stake;
  const evValor = prob != null ? stake * (prob * odd - 1) : null;
  return {
    stake,
    retornoBruto: +retornoBruto.toFixed(2),
    lucroBruto:   +lucroBruto.toFixed(2),
    evValor:      evValor != null ? +evValor.toFixed(2) : null,
  };
}

/**
 * Retorno de uma combinada (múltipla).
 *
 * ATENÇÃO EDUCATIVA:
 * A odd de uma múltipla é o produto das odds (payout multiplicativo).
 * A probabilidade real é o produto das probabilidades — SE as pernas
 * forem independentes. Na prática, as casas cobram margem em CADA perna,
 * então o EV da múltipla costuma ser negativo mesmo quando as pernas
 * individuais têm EV positivo.
 *
 * Este cálculo assume independência (aproximação padrão). Devolvemos
 * também o EV pra que a UI possa mostrar honestamente quando a
 * combinada é matematicamente pior que apostar em cada perna separada.
 */
function retornoCombinada(pernas, stake) {
  if (!pernas || pernas.length === 0) return null;
  const oddCombinada  = pernas.reduce((acc, p) => acc * p.odd, 1);
  const probCombinada = pernas.reduce((acc, p) => acc * (p.prob || 0), 1);
  const retornoBruto  = stake * oddCombinada;
  const lucroBruto    = retornoBruto - stake;
  const evValor       = stake * (probCombinada * oddCombinada - 1);
  const evPercent     = (probCombinada * oddCombinada - 1) * 100;

  // Comparação honesta: EV total apostando o mesmo stake dividido entre pernas
  const stakePorPerna = stake / pernas.length;
  const evSeparado = pernas.reduce((acc, p) =>
    acc + stakePorPerna * ((p.prob || 0) * p.odd - 1), 0);

  return {
    oddCombinada: +oddCombinada.toFixed(2),
    probCombinada: +(probCombinada * 100).toFixed(1),
    stake,
    retornoBruto: +retornoBruto.toFixed(2),
    lucroBruto:   +lucroBruto.toFixed(2),
    evValor:      +evValor.toFixed(2),
    evPercent:    +evPercent.toFixed(1),
    // Análise educativa
    evSeAtacadoSeparado: +evSeparado.toFixed(2),
    perdeValorAoCombinar: evValor < evSeparado,
  };
}

module.exports = { kellyQuarter, retornoAposta, retornoCombinada };
