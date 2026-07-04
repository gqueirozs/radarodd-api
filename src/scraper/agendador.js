const cron   = require('node-cron');
const cache  = require('../utils/cache');
const logger = require('../utils/logger');
const db     = require('../db/mongo');
const { executarScrape } = require('./esportivabet');
const { parseJogo }       = require('../utils/parser');
const { nomeParaId, confrontoId } = require('../utils/slug');
const { ordenarJogosDesc } = require('../utils/datas');

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
      id:       nomeParaId(bruto.info.nomeCasa) || 'casa',
      nome:     bruto.info.nomeCasa || 'Casa',
      bandeira: '🏳️',
      grupo:    bruto.info.grupoCasa || '?',
      pts:      bruto.info.ptsCasa   || 0,
      gp: 0, gc: 0,
      forma:    bruto.info.formaCasa || [],
    },
    fora: {
      id:       nomeParaId(bruto.info.nomeFora) || 'fora',
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

    // 3. (Removido) O complemento com jogos do banco é feito DENTRO do
    //    esportivabet.js, com deduplicação por confronto normalizado.
    //    Nada de refazer aqui — era a fonte das duplicatas no cache.

    // 3b. Autolimpeza do banco: remove órfãos e duplicatas a cada ciclo,
    //     garantindo que resíduos nunca voltem a se acumular.
    db.limparOrfaos().catch(err => logger.warn(`Autolimpeza falhou: ${err.message}`));

    // 3c. Enriquecimento empírico (async, não bloqueia o ciclo):
    //     sinais calculados dos resultados reais via ESPN
    enriquecerComAnalise(jogos).catch(err => logger.warn(`Análise empírica falhou: ${err.message}`));

    // Ordenar por data/hora real: mais recente primeiro
    ordenarJogosDesc(jogos);

    // 4. Salvar lista no cache
    cache.set('jogos:lista', jogos, 10 * 60 * 1000);
    cache.setTotalJogos(jogos.length);
    cache.setStatus('ok');

    logger.ok(`Ciclo concluído: ${jogos.length} jogos no cache | eventos da API: ${dadosBrutos._novosDescobertos || 0}`);
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
            const idJogo = j.confrontoId || confrontoId(j.nomeCasa, j.nomeFora);
            const convertido = converterParaFormato({
              info: { ...j, id: idJogo },
              odds: j.odds || {},
              coletadoEm: j.atualizadoEm || new Date().toISOString(),
            });
            jogos.push(parseJogo(convertido));
          } catch {}
        }
        if (jogos.length > 0) {
          // Dedup de segurança por confronto
          const vistos = new Set();
          const unicos = jogos.filter(j => !vistos.has(j.id) && vistos.add(j.id));
          jogos.length = 0; jogos.push(...unicos);
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

/* Calcula os sinais de cada jogo com base empírica (resultados reais).
 * espn.confronto tem cache de 6h, então após a primeira passada o custo
 * é praticamente zero. Roda em background e atualiza o cache ao final. */
async function enriquecerComAnalise(jogos) {
  const espn = require('./espn');
  const { analisarMercados } = require('../analise/mercados');
  let comSinal = 0;
  for (const jogo of jogos) {
    if (!jogo?.odds || jogo.statusReal === 'encerrado') continue;
    try {
      const conf = await espn.confronto(jogo.casa?.nome, jogo.fora?.nome);
      if (!conf?.ok) continue;
      const analise = analisarMercados(jogo, conf);
      jogo.valueBets = analise.sinais;
      jogo.analiseBase = analise.base;
      if (analise.sinais.length > 0) comSinal++;
    } catch { /* sem análise para este jogo */ }
    await new Promise(r => setTimeout(r, 250)); // gentileza com a ESPN
  }
  cache.set('jogos:lista', jogos, 10 * 60 * 1000);
  logger.ok(`Análise empírica: ${jogos.length} jogos processados, ${comSinal} com sinais de valor`);
}

module.exports = { iniciarAgendador, executarCicloCompleto };
