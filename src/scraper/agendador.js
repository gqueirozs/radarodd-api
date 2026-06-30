const cron   = require('node-cron');
const cache  = require('../utils/cache');
const logger = require('../utils/logger');
const db     = require('../db/mongo');
const { executarScrape } = require('./esportivabet');
const { parseJogo }       = require('../utils/parser');

let scrapeEmAndamento = false;

// Converte formato do scraper → formato da API/cache
function converterParaFormato(bruto) {
  return {
    id:         bruto.info.id,
    competicao: bruto.info.competicao || 'Copa do Mundo 2026 — 16-avos',
    data:       bruto.info.data  || '--/--',
    hora:       bruto.info.hora  || '--:--',
    estadio:    bruto.info.estadio || '',
    casa: {
      id:       (bruto.info.nomeCasa || 'casa').toLowerCase().replace(/[^a-z0-9]/g,'-'),
      nome:     bruto.info.nomeCasa || 'Casa',
      bandeira: '🏳️',
      grupo:    bruto.info.grupoCasa || '?',
      pts:      bruto.info.ptsCasa   || 0,
      gp: 0, gc: 0,
      forma:    bruto.info.formaCasa || [],
    },
    fora: {
      id:       (bruto.info.nomeFora || 'fora').toLowerCase().replace(/[^a-z0-9]/g,'-'),
      nome:     bruto.info.nomeFora || 'Fora',
      bandeira: '🏳️',
      grupo:    bruto.info.grupoFora || '?',
      pts:      bruto.info.ptsFora   || 0,
      gp: 0, gc: 0,
      forma:    bruto.info.formaFora || [],
    },
    odds:       bruto.odds,
    startDate:  bruto.info.startDate || null,
    coletadoEm: bruto.coletadoEm,
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
    // 1. Executar scrape (varre IDs + atualiza jogos conhecidos)
    const dadosBrutos = await executarScrape();

    if (!dadosBrutos || dadosBrutos.length === 0) {
      throw new Error('Nenhum dado coletado pelo scraper');
    }

    // 2. Converter, parsear e salvar
    const jogos = [];
    for (const bruto of dadosBrutos) {
      try {
        const convertido = converterParaFormato(bruto);
        const jogoParsed = parseJogo(convertido);
        jogos.push(jogoParsed);

        // Cache individual
        cache.set(`jogo:${jogoParsed.id}`, jogoParsed, 10 * 60 * 1000);

        // MongoDB — salvar/atualizar jogo
        await db.upsertJogo(bruto.info, bruto.odds);
      } catch (err) {
        logger.warn(`Erro ao converter jogo ${bruto.info?.id}: ${err.message}`);
      }
    }

    // 3. Complementar com jogos do banco que não vieram no scrape desta rodada
    // (garante que jogos descobertos em ciclos anteriores continuem aparecendo)
    const jogosDB = await db.getJogos();
    if (jogosDB && jogosDB.length > 0) {
      const idsNoCache = new Set(jogos.map(j => j.id));
      for (const j of jogosDB) {
        const idJogo = j.id || `${(j.nomeCasa||'').toLowerCase().replace(/[^a-z0-9]/g,'-')}-vs-${(j.nomeFora||'').toLowerCase().replace(/[^a-z0-9]/g,'-')}`;
        if (!idsNoCache.has(idJogo) && j.nomeCasa && j.nomeFora) {
          try {
            const convertido = converterParaFormato({
              info: { ...j, id: idJogo },
              odds: j.odds || {},
              coletadoEm: j.atualizadoEm || new Date().toISOString(),
            });
            const jogoParsed = parseJogo(convertido);
            jogos.push(jogoParsed);
            cache.set(`jogo:${jogoParsed.id}`, jogoParsed, 10 * 60 * 1000);
          } catch {}
        }
      }
    }

    // Ordenar por data
    jogos.sort((a, b) => (a.startDate || a.data || '').localeCompare(b.startDate || b.data || ''));

    // 4. Salvar lista no cache
    cache.set('jogos:lista', jogos, 10 * 60 * 1000);
    cache.setTotalJogos(jogos.length);
    cache.setCursorVarredura(dadosBrutos._cursorVarredura || null);
    cache.setStatus('ok');

    logger.ok(`Ciclo concluído: ${jogos.length} jogos no cache | novos descobertos: ${dadosBrutos._novosDescobertos || 0}`);
    return jogos;

  } catch (err) {
    logger.error(`Falha no ciclo de scrape: ${err.message}`);
    cache.setStatus('error', err.message);

    // Fallback: carregar do MongoDB se disponível
    try {
      const jogosDB = await db.getJogos();
      if (jogosDB && jogosDB.length > 0) {
        const jogos = [];
        for (const j of jogosDB) {
          try {
            const idJogo = j.id || `${(j.nomeCasa||'').toLowerCase().replace(/[^a-z0-9]/g,'-')}-vs-${(j.nomeFora||'').toLowerCase().replace(/[^a-z0-9]/g,'-')}`;
            const convertido = converterParaFormato({
              info: { ...j, id: idJogo },
              odds: j.odds || {},
              coletadoEm: j.atualizadoEm || new Date().toISOString(),
            });
            jogos.push(parseJogo(convertido));
          } catch {}
        }
        if (jogos.length > 0) {
          cache.set('jogos:lista', jogos, 10 * 60 * 1000);
          cache.setTotalJogos(jogos.length);
          cache.setStatus('ok');
          logger.ok(`Fallback MongoDB: ${jogos.length} jogos carregados`);
        }
      }
    } catch {}
  } finally {
    scrapeEmAndamento = false;
  }
}

function iniciarAgendador() {
  const intervalo = process.env.SCRAPER_INTERVAL_MINUTES || 5;
  const cronExp   = `*/${intervalo} * * * *`;

  logger.info(`Agendador configurado: a cada ${intervalo} minutos`);

  // Rodar imediatamente
  executarCicloCompleto();

  // Agendar ciclos
  cron.schedule(cronExp, () => {
    logger.info('Ciclo agendado iniciado');
    executarCicloCompleto();
  });
}

module.exports = { iniciarAgendador, executarCicloCompleto };
