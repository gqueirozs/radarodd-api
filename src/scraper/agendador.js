const cron = require('node-cron');
const cache = require('../utils/cache');
const logger = require('../utils/logger');
const { executarScrape, scrapeListaJogos } = require('./esportivabet');
const { parseJogo } = require('../utils/parser');

// URLs fixas dos eventos ativos (atualizar conforme a competição avança)
// Em produção, essa lista seria coletada dinamicamente pela função scrapeListaJogos()
const URLS_EVENTOS_COPA = [
  'https://esportiva.bet.br/sports/futebol/mundo/copa-do-mundo-2026/brasil-vs-japao/ev-16913912',
  // Adicionar mais URLs conforme necessário
];

let scrapeEmAndamento = false;

async function descobrirEventos() {
  try {
    logger.scraper('Descobrindo eventos disponíveis...');
    const eventos = await scrapeListaJogos();

    if (eventos && eventos.length > 0) {
      const urls = eventos
        .map(e => e.href)
        .filter(url => url && url.includes('/ev-'));
      logger.ok(`Descobertos ${urls.length} eventos`);
      return urls;
    }
  } catch (err) {
    logger.warn(`Falha ao descobrir eventos: ${err.message}. Usando URLs fixas.`);
  }
  return URLS_EVENTOS_COPA;
}

async function converterParaFormato(dadosBrutos) {
  // Converte o formato cru do scraper para o formato da API
  return {
    id: dadosBrutos.info.id,
    competicao: 'Copa do Mundo 2026 — 16-avos',
    data: dadosBrutos.info.dataHora?.split(' ')[0] || '--/--',
    hora: dadosBrutos.info.dataHora?.split(' ')[1] || '--:--',
    estadio: '',
    casa: {
      id: dadosBrutos.info.nomeCasa?.toLowerCase().replace(/\s/g, '-'),
      nome: dadosBrutos.info.nomeCasa,
      bandeira: '🏳️',
      grupo: '?',
      pts: 0,
      gp: 0,
      gc: 0,
      forma: [],
    },
    fora: {
      id: dadosBrutos.info.nomeFora?.toLowerCase().replace(/\s/g, '-'),
      nome: dadosBrutos.info.nomeFora,
      bandeira: '🏳️',
      grupo: '?',
      pts: 0,
      gp: 0,
      gc: 0,
      forma: [],
    },
    odds: dadosBrutos.odds,
    urlOrigem: dadosBrutos.url,
    coletadoEm: dadosBrutos.coletadoEm,
  };
}

async function executarCicloCompleto() {
  if (scrapeEmAndamento) {
    logger.warn('Scrape já em andamento, pulando ciclo');
    return;
  }

  scrapeEmAndamento = true;
  cache.setStatus('scraping');
  logger.info('Iniciando ciclo de scrape...');

  try {
    // 1. Descobrir eventos disponíveis
    const urls = await descobrirEventos();

    // 2. Coletar odds de cada evento
    logger.info(`Coletando odds de ${urls.length} eventos...`);
    const dadosBrutos = await executarScrape(urls);

    if (!dadosBrutos || dadosBrutos.length === 0) {
      throw new Error('Nenhum dado coletado pelo scraper');
    }

    // 3. Converter e validar
    const jogos = [];
    for (const bruto of dadosBrutos) {
      try {
        const convertido = await converterParaFormato(bruto);
        const jogoParsed = parseJogo(convertido);
        jogos.push(jogoParsed);

        // Salvar no cache individual
        cache.set(`jogo:${jogoParsed.id}`, jogoParsed, 10 * 60 * 1000);
      } catch (err) {
        logger.warn(`Erro ao converter jogo ${bruto.info?.id}: ${err.message}`);
      }
    }

    // 4. Salvar lista no cache
    cache.set('jogos:lista', jogos, 10 * 60 * 1000);
    cache.setTotalJogos(jogos.length);
    cache.setStatus('ok');

    logger.ok(`Ciclo concluído: ${jogos.length} jogos atualizados`);
    return jogos;

  } catch (err) {
    logger.error(`Falha no ciclo de scrape: ${err.message}`);
    cache.setStatus('error', err.message);
  } finally {
    scrapeEmAndamento = false;
  }
}

function iniciarAgendador() {
  const intervalo = process.env.SCRAPER_INTERVAL_MINUTES || 5;
  const cronExp = `*/${intervalo} * * * *`;

  logger.info(`Agendador configurado: a cada ${intervalo} minutos`);

  // Rodar imediatamente na inicialização
  executarCicloCompleto();

  // Agendar ciclos subsequentes
  cron.schedule(cronExp, () => {
    logger.info('Ciclo agendado iniciado');
    executarCicloCompleto();
  });
}

module.exports = { iniciarAgendador, executarCicloCompleto };
