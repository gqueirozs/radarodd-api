/**
 * Scraper EsportivaBet via API Altenar (GetEventDetails)
 * Estrutura descoberta via inspeção de rede:
 *   competitors[0|1].name = times
 *   marketGroups = mercados principais
 *   childMarkets = todos os mercados
 */
const logger = require('../utils/logger');

const ALTENAR = 'https://sb2frontend-altenar2.biahosted.com/api/widget';
const PARAMS  = 'culture=pt-BR&timezoneOffset=180&integration=esportiva&deviceType=1&numFormat=en-GB&countryCode=BR';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Referer': 'https://esportiva.bet.br/',
  'Origin': 'https://esportiva.bet.br',
};

async function altenarFetch(path, extra = '') {
  const url = `${ALTENAR}/${path}?${PARAMS}${extra ? '&' + extra : ''}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function parseOdd(v) {
  const n = parseFloat(v);
  return (!isNaN(n) && n >= 1.01 && n <= 999) ? n : null;
}

// Extrair odds dos marketGroups (mercados principais do evento)
function parsearMercados(evento) {
  const odds = {
    resultado: {}, totalGols: { linha: 2.5 }, ambasMarcam: {},
    primeiroGol: {}, chanceDupla: {}, qualificar: {},
    escanteios: { linha: 9.5 }, handicap: [], placares: [],
  };

  // marketGroups tem os mercados principais agrupados
  const grupos = evento.marketGroups || [];

  for (const grupo of grupos) {
    const markets = grupo.markets || grupo.childMarkets || [];

    for (const market of markets) {
      const nome = (market.name || market.shortName || '').toLowerCase();
      const odds_list = market.odds || market.selections || [];

      // 1x2
      if (nome === 'vencedor do encontro' || nome === '1x2' || nome === 'resultado final' || nome.includes('vencedor')) {
        for (const o of odds_list) {
          const n = (o.name || o.shortName || '').toLowerCase();
          const v = parseOdd(o.sv || o.price || o.odd);
          if (!v) continue;
          if (n === 'empate' || n === 'x' || n === 'draw') odds.resultado.empate = v;
          else if (odds_list.indexOf(o) === 0) odds.resultado.casa = v;
          else odds.resultado.fora = v;
        }
      }

      // Total de gols
      if ((nome.includes('total de gols') || nome.includes('over/under')) && !nome.includes('brasil') && !nome.includes('jap') && !nome.includes('escanteio')) {
        for (const o of odds_list) {
          const n = (o.name || '').toLowerCase();
          const v = parseOdd(o.sv || o.price);
          const linhaM = n.match(/(\d+[.,]\d)/);
          if (linhaM) odds.totalGols.linha = parseFloat(linhaM[1].replace(',', '.'));
          if (n.includes('mais') || n.includes('+') || n.includes('over')) odds.totalGols.mais = v;
          if (n.includes('menos') || n.includes('-') || n.includes('under')) odds.totalGols.menos = v;
        }
      }

      // Ambas marcam
      if (nome.includes('ambas') || nome.includes('btts')) {
        for (const o of odds_list) {
          const n = (o.name || '').toLowerCase();
          const v = parseOdd(o.sv || o.price);
          if (n.includes('sim') || n === 'yes') odds.ambasMarcam.sim = v;
          if (n.includes('não') || n === 'no') odds.ambasMarcam.nao = v;
        }
      }

      // Primeiro gol
      if (nome.includes('primeiro gol') || nome === 'primeiro a marcar') {
        for (const [i, o] of odds_list.entries()) {
          const n = (o.name || '').toLowerCase();
          const v = parseOdd(o.sv || o.price);
          if (n.includes('nenhum') || n.includes('sem gol')) odds.primeiroGol.nenhum = v;
          else if (i === 0) odds.primeiroGol.casa = v;
          else odds.primeiroGol.fora = v;
        }
      }

      // Chance dupla
      if (nome === 'chance dupla' || nome.includes('double chance')) {
        for (const [i, o] of odds_list.entries()) {
          const v = parseOdd(o.sv || o.price);
          if (i === 0) odds.chanceDupla.casaEmpate = v;
          else if (i === 1) odds.chanceDupla.casaFora = v;
          else odds.chanceDupla.empataFora = v;
        }
      }

      // Para qualificar
      if (nome.includes('qualificar') || nome.includes('para avançar') || nome.includes('classificar')) {
        for (const [i, o] of odds_list.entries()) {
          const v = parseOdd(o.sv || o.price);
          if (i === 0) odds.qualificar.casa = v;
          else odds.qualificar.fora = v;
        }
      }

      // Escanteios
      if (nome.includes('escanteio') || nome.includes('corner')) {
        for (const o of odds_list) {
          const n = (o.name || '').toLowerCase();
          const v = parseOdd(o.sv || o.price);
          const linhaM = n.match(/(\d+[.,]\d)/);
          if (linhaM) odds.escanteios.linha = parseFloat(linhaM[1].replace(',', '.'));
          if (n.includes('mais') || n.includes('+')) odds.escanteios.mais = v;
          if (n.includes('menos') || n.includes('-')) odds.escanteios.menos = v;
        }
      }

      // Handicap asiático
      if (nome.includes('handicap') && !nome.includes('europeu')) {
        for (const o of odds_list) {
          const n = o.name || '';
          const v = parseOdd(o.sv || o.price);
          const linhaM = n.match(/([+-]?\d+[.,]?\d*)/);
          if (v && linhaM) odds.handicap.push({ linha: linhaM[1], odd: v });
        }
      }

      // Resultado correto
      if (nome.includes('resultado correto') || nome.includes('correct score')) {
        for (const o of odds_list) {
          const n = o.name || '';
          const v = parseOdd(o.sv || o.price);
          const pM = n.match(/(\d+)[:\-x](\d+)/i);
          if (v && pM) {
            const g1 = parseInt(pM[1]), g2 = parseInt(pM[2]);
            odds.placares.push({ placar: `${g1}-${g2}`, odd: v, time: g1>g2?'casa':g1<g2?'fora':'empate' });
          }
        }
      }
    }
  }

  return odds;
}

// IDs dos eventos Copa do Mundo conhecidos
const IDS_COPA = [16913912]; // Brasil vs Japão — adicionar mais conforme avançar

async function executarScrape() {
  const resultados = [];

  for (const eventId of IDS_COPA) {
    try {
      logger.scraper(`Coletando evento ${eventId}...`);
      const json = await altenarFetch('GetEventDetails', `eventId=${eventId}&showNonBoosts=true`);
      const ev = json.Result || json;

      const comp = ev.competitors || [];
      const nomeCasa = comp[0]?.name || 'Casa';
      const nomeFora = comp[1]?.name || 'Fora';

      let data = '--/--', hora = '--:--';
      if (ev.startDate) {
        const d = new Date(ev.startDate);
        data = d.toLocaleDateString('pt-BR');
        hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      }

      const odds = parsearMercados(ev);

      resultados.push({
        info: {
          id: `${nomeCasa.toLowerCase().replace(/\s+/g,'-')}-vs-${nomeFora.toLowerCase().replace(/\s+/g,'-')}`,
          eventId: String(eventId),
          nomeCasa, nomeFora,
          competicao: ev.champ?.name || 'Copa do Mundo 2026',
          data, hora,
          estadio: '',
        },
        odds,
        coletadoEm: new Date().toISOString(),
      });

      logger.ok(`✓ ${nomeCasa} x ${nomeFora} — resultado: ${odds.resultado.casa}/${odds.resultado.empate}/${odds.resultado.fora}`);
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      logger.error(`Evento ${eventId}: ${err.message}`);
    }
  }

  return resultados;
}

async function scrapeListaJogos() { return []; }

module.exports = { executarScrape, scrapeListaJogos };
