/**
 * Gerador de odds estatístico — usado quando não há odds reais capturadas.
 * Calcula odds justas baseado em força relativa dos times (ranking FIFA aproximado
 * + heurística de poder ofensivo) e aplica margem de casa de apostas (~6%) realista.
 */

// Forças relativas aproximadas (ranking FIFA invertido, normalizado 0-100)
// Quanto maior, mais forte
const FORCA_TIMES = {
  'brasil': 92, 'argentina': 90, 'frança': 89, 'inglaterra': 86, 'espanha': 85,
  'portugal': 84, 'países baixos': 83, 'bélgica': 81, 'alemanha': 80, 'itália': 79,
  'croácia': 76, 'uruguai': 75, 'colômbia': 74, 'marrocos': 73, 'estados unidos': 72,
  'japão': 70, 'suíça': 70, 'senegal': 69, 'dinamarca': 69, 'áustria': 68,
  'méxico': 67, 'equador': 65, 'sérvia': 64, 'gana': 63, 'coreia do sul': 63,
  'irã': 62, 'tunísia': 61, 'austrália': 60, 'canadá': 60, 'qatar': 55,
  'arábia saudita': 54, 'argélia': 58, 'costa do marfim': 60, 'noruega': 66,
  'ucrânia': 62, 'polônia': 64, 'escócia': 61, 'país de gales': 58,
  'bósnia e herzegovina': 56, 'paraguai': 57, 'rd congo': 50, 'haiti': 45,
  'jordânia': 48, 'panamá': 50, 'cabo verde': 48, 'uzbequistão': 50,
  'nova zelândia': 47, 'curaçao': 44, 'jamaica': 49,
};

function forcaTime(nome) {
  if (!nome) return 55;
  const k = nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const [key, val] of Object.entries(FORCA_TIMES)) {
    const kn = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (kn === k || k.includes(kn) || kn.includes(k)) return val;
  }
  return 55; // default para times não mapeados
}

// Margem da casa de apostas (overround) — odds reais sempre somam mais que 100%
const MARGEM = 1.06;

function probParaOdd(prob) {
  // Converte probabilidade (0-1) em odd decimal já COM margem da casa
  const odd = (1 / prob) / MARGEM;
  return Math.max(1.01, Math.min(15, Math.round(odd * 100) / 100));
}

/**
 * Gera odds estatisticamente coerentes para um confronto, baseado na força dos times.
 * Usa modelo simplificado de Elo/Poisson para estimar probabilidades.
 */
function gerarOdds(nomeCasa, nomeFora) {
  const fCasa = forcaTime(nomeCasa);
  const fFora = forcaTime(nomeFora);

  // Vantagem de mandante leve (+3 pontos) — mesmo em campo neutro da Copa, ajuda psicológica
  const fCasaAjust = fCasa + 3;
  const diff = fCasaAjust - fFora;

  // Modelo logístico para probabilidade de vitória
  const probCasaBase = 1 / (1 + Math.pow(10, -diff / 25));
  // Probabilidade de empate cai conforme a diferença de força aumenta
  const probEmpate = Math.max(0.18, 0.30 - Math.abs(diff) * 0.004);
  const probCasa = probCasaBase * (1 - probEmpate);
  const probFora = (1 - probCasaBase) * (1 - probEmpate);

  // Normalizar para somar 1
  const soma = probCasa + probEmpate + probFora;
  const pC = probCasa / soma, pE = probEmpate / soma, pF = probFora / soma;

  const oddCasa = probParaOdd(pC);
  const oddEmpate = probParaOdd(pE);
  const oddFora = probParaOdd(pF);

  // Gols esperados (Poisson simplificado baseado na força)
  const golsEsperados = 1.3 + (fCasaAjust + fFora) / 200; // entre ~1.6 e ~2.0
  const probMais25 = golsEsperados > 2.5 ? 0.58 : 0.45;

  // Ambas marcam — times mais fortes ofensivamente marcam mais
  const probAmbas = 0.42 + Math.min(fCasa, fFora) / 250;

  // Para classificar (penaltis/prorrogação) — favorece levemente o mais forte
  const probClassCasa = 0.5 + diff / 200;

  return {
    resultado: {
      casa: oddCasa,
      empate: oddEmpate,
      fora: oddFora,
    },
    totalGols: {
      linha: 2.5,
      mais: probParaOdd(probMais25),
      menos: probParaOdd(1 - probMais25),
    },
    ambasMarcam: {
      sim: probParaOdd(probAmbas),
      nao: probParaOdd(1 - probAmbas),
    },
    primeiroGol: {
      casa: probParaOdd(pC * 0.92),
      nenhum: probParaOdd(0.09),
      fora: probParaOdd(pF * 0.92),
    },
    chanceDupla: {
      casaEmpate: probParaOdd(pC + pE),
      casaFora: probParaOdd(pC + pF),
      empataFora: probParaOdd(pE + pF),
    },
    qualificar: {
      casa: probParaOdd(Math.min(0.92, Math.max(0.08, probClassCasa))),
      fora: probParaOdd(Math.min(0.92, Math.max(0.08, 1 - probClassCasa))),
    },
    escanteios: {
      linha: 9.5,
      mais: probParaOdd(0.52),
      menos: probParaOdd(0.48),
    },
    handicap: [],
    placares: gerarPlacares(pC, pE, pF, golsEsperados),
    _gerado: true, // flag indicando que são odds geradas, não capturadas
  };
}

function gerarPlacares(pC, pE, pF, golsEsperados) {
  const placares = [];
  const combos = [
    { p:'1-0', c:'casa', peso:1.0 }, { p:'2-0', c:'casa', peso:0.6 }, { p:'2-1', c:'casa', peso:0.7 },
    { p:'3-0', c:'casa', peso:0.3 }, { p:'3-1', c:'casa', peso:0.35 },
    { p:'0-0', c:'empate', peso:0.7 }, { p:'1-1', c:'empate', peso:1.0 }, { p:'2-2', c:'empate', peso:0.4 },
    { p:'0-1', c:'fora', peso:1.0 }, { p:'0-2', c:'fora', peso:0.6 }, { p:'1-2', c:'fora', peso:0.7 },
    { p:'0-3', c:'fora', peso:0.3 }, { p:'1-3', c:'fora', peso:0.35 },
  ];
  for (const { p, c, peso } of combos) {
    const probBase = c === 'casa' ? pC : c === 'empate' ? pE : pF;
    const prob = (probBase * peso) / 4; // distribuir entre os placares do grupo
    placares.push({ placar: p, odd: probParaOdd(Math.max(0.015, prob)), time: c });
  }
  return placares;
}

module.exports = { gerarOdds, forcaTime };
