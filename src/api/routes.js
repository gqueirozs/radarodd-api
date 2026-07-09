const express  = require('express');
const router   = express.Router();
const cache    = require('../utils/cache');
const logger   = require('../utils/logger');
const mongoose = require('mongoose');
const { executarCicloCompleto } = require('../scraper/agendador');
const { ordenarJogosDesc, normalizarDataHora } = require('../utils/datas');
const auth = require('../auth/auth');
const trackRecord = require('../analise/trackRecord');
const financeiro = require('../analise/financeiro');

// Remove APENAS o que é premium: odds pré-jogo e sinais.
// Todo o resto (times, hora, placar, estatísticas de jogo, forma) é
// conteúdo público que qualquer portal esportivo mostra — esconder
// dá falsa impressão de "sem dados" e afasta o visitante.
function stripPremiumDoJogo(j) {
  const pre = j.statusReal !== 'ao-vivo' && j.statusReal !== 'encerrado';
  return {
    ...j,
    valueBets: undefined,
    analiseBase: undefined,
    sinaisBloqueados: (j.valueBets || []).length,
    odds: pre ? null : j.odds, // odds pré-jogo escondidas; placar ao vivo/encerrado fica
  };
}

// GET /api/status — saúde e status do scraper
router.get('/status', (req, res) => {
  const meta = cache.getMetadata();
  const mongoState = ['disconnected','connected','connecting','disconnecting'];
  res.json({
    ok: true,
    versao: '1.0.0',
    status: meta.status,
    ultimaAtualizacao: meta.ultimaAtualizacao,
    totalJogos: meta.totalJogos,
    erro: meta.erro,
    historico: meta.historico,
    uptime: process.uptime(),
    mongodb: mongoState[mongoose.connection.readyState] || 'unknown',
    cursorVarredura: meta.cursorVarredura,
  });
});

// GET /api/jogos — lista todos os jogos disponíveis
router.get('/jogos', auth.autenticarOpcional, async (req, res) => {
  const jogos = cache.get('jogos:lista');

  if (!jogos) {
    // Cache vazio: retorna status de carregando
    return res.status(202).json({
      ok: false,
      mensagem: 'Coletando dados, aguarde...',
      status: cache.getMetadata().status,
    });
  }

  // Filtros opcionais via query string
  let resultado = [...jogos];

  if (req.query.competicao) {
    resultado = resultado.filter(j =>
      j.competicao?.toLowerCase().includes(req.query.competicao.toLowerCase())
    );
  }

  if (req.query.time) {
    const time = req.query.time.toLowerCase();
    resultado = resultado.filter(j =>
      j.casa?.nome?.toLowerCase().includes(time) ||
      j.fora?.nome?.toLowerCase().includes(time)
    );
  }

  // Corrigir data/hora pro fuso de Brasília (registros antigos vieram em UTC)
  normalizarDataHora(resultado);

  // Ordenar por data/hora real: mais recente primeiro
  ordenarJogosDesc(resultado);

  // Anotar status real (encerrado/ao-vivo) e placar via ESPN
  try {
    const mataMata = require('../scraper/mataMata');
    await mataMata.anexarStatusReal(resultado);
  } catch (e) {
    logger.warn(`Status real indisponível: ${e.message}`);
  }

  // ── PORTÃO PREMIUM (server-side) ──────────────────────────────────
  // Não assinante: sem valueBets, sem odds pré-jogo. Só macro e placar.
  if (!req.assinante) resultado = resultado.map(stripPremiumDoJogo);

  res.json({
    ok: true,
    total: resultado.length,
    atualizadoEm: cache.getMetadata().ultimaAtualizacao,
    jogos: resultado,
  });
});

// GET /api/jogos/:id — odds completas de um jogo específico
router.get('/jogos/:id', auth.autenticarOpcional, async (req, res) => {
  const { id } = req.params;
  const jogo = cache.get(`jogo:${id}`);

  if (!jogo) {
    // Tentar buscar na lista geral
    const lista = cache.get('jogos:lista') || [];
    const encontrado = lista.find(j => j.id === id);

    if (!encontrado) {
      return res.status(404).json({
        ok: false,
        mensagem: `Jogo "${id}" não encontrado`,
      });
    }

    return res.json({ ok: true, jogo: req.assinante ? encontrado : stripPremiumDoJogo(encontrado) });
  }

  res.json({ ok: true, jogo: req.assinante ? jogo : stripPremiumDoJogo(jogo) });
});

// POST /api/scrape — força atualização manual (protegido por token simples)
router.post('/scrape', async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token !== process.env.ADMIN_TOKEN && process.env.NODE_ENV === 'production') {
    return res.status(401).json({ ok: false, mensagem: 'Não autorizado' });
  }

  logger.info('Scrape manual solicitado via API');
  res.json({ ok: true, mensagem: 'Scrape iniciado em background' });

  // Rodar em background sem bloquear a resposta
  executarCicloCompleto().catch(err => {
    logger.error(`Scrape manual falhou: ${err.message}`);
  });
});

// Middleware simples de autenticação admin (mesma regra do /scrape)
function exigirAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== process.env.ADMIN_TOKEN && process.env.NODE_ENV === 'production') {
    return res.status(401).json({ ok: false, mensagem: 'Não autorizado' });
  }
  next();
}

// GET /api/admin/jogos-db — inspeciona os documentos salvos no MongoDB
router.get('/admin/jogos-db', exigirAdmin, async (req, res) => {
  const db = require('../db/mongo');
  const docs = await db.listarJogosDB();
  if (!docs) {
    return res.status(503).json({ ok: false, mensagem: 'MongoDB não conectado' });
  }
  const orfaos = docs.filter(d => !d.eventId || !/^\d+$/.test(String(d.eventId)));
  res.json({
    ok: true,
    total: docs.length,
    totalOrfaos: orfaos.length,
    jogos: docs.map(d => ({
      eventId: d.eventId ?? null,
      jogo: `${d.nomeCasa || '?'} x ${d.nomeFora || '?'}`,
      orfao: !d.eventId || !/^\d+$/.test(String(d.eventId)),
      atualizadoEm: d.atualizadoEm,
    })),
  });
});

// POST /api/admin/limpar?modo=orfaos|reset — limpa o MongoDB e re-scrapeia
// - orfaos (padrão): remove só documentos com eventId não-numérico (scraper antigo)
// - reset: apaga a collection Jogo inteira (scraper repopula em seguida)
router.post('/admin/limpar', exigirAdmin, async (req, res) => {
  const db = require('../db/mongo');
  const modo = (req.query.modo || 'orfaos').toLowerCase();

  const resultado = modo === 'reset'
    ? await db.resetJogos()
    : await db.limparOrfaos();

  if (!resultado.ok) {
    return res.status(503).json(resultado);
  }

  logger.info(`Limpeza admin executada (modo=${modo}): ${resultado.removidos} removidos. Disparando novo ciclo...`);

  // Reconstruir o cache imediatamente com dados limpos
  executarCicloCompleto().catch(err => {
    logger.error(`Ciclo pós-limpeza falhou: ${err.message}`);
  });

  res.json({
    ok: true,
    modo,
    removidos: resultado.removidos,
    mensagem: 'Limpeza concluída. Novo ciclo de scrape iniciado em background — o cache será atualizado em instantes.',
  });
});

// GET /api/confronto?casa=X&fora=Y — estatísticas reais (ESPN): últimos
// jogos de cada seleção, confronto direto, gols, cartões e faltas
router.get('/confronto', auth.exigirAssinatura, async (req, res) => {
  const { casa, fora } = req.query;
  if (!casa || !fora) {
    return res.status(400).json({ ok: false, mensagem: 'Parâmetros casa e fora são obrigatórios' });
  }
  try {
    const espn = require('../scraper/espn');
    const dados = await espn.confronto(casa, fora);
    res.json(dados);
  } catch (err) {
    logger.error(`Confronto ${casa} x ${fora} falhou: ${err.message}`);
    res.status(502).json({ ok: false, mensagem: 'Falha ao buscar estatísticas na ESPN' });
  }
});

// GET /api/mata-mata — chaveamento do mata-mata montado automaticamente
// pela ESPN (placares reais, pênaltis, ao vivo) + nossas odds nos agendados
router.get('/mata-mata', auth.autenticarOpcional, async (req, res) => {
  try {
    const mataMata = require('../scraper/mataMata');
    const chave = await mataMata.obterChaveamento();
    if (!req.assinante && chave?.fases) {
      for (const fase of Object.values(chave.fases)) {
        for (const j of fase) if (j.status === 'agendado') j.odds = null;
      }
    }
    res.json(chave);
  } catch (err) {
    logger.error(`Mata-mata falhou: ${err.message}`);
    res.status(502).json({ ok: false, mensagem: 'Falha ao montar o chaveamento' });
  }
});

// GET /api/evento/:eventoId — local, escalações e banco (ESPN)
router.get('/evento/:eventoId', async (req, res) => {
  try {
    const espn = require('../scraper/espn');
    const liga = req.query.liga || 'fifa.world';
    res.json(await espn.eventoDetalhes(req.params.eventoId, liga));
  } catch (err) {
    logger.warn(`Evento ${req.params.eventoId} falhou: ${err.message}`);
    res.status(502).json({ ok: false, mensagem: 'Detalhes indisponíveis' });
  }
});

// GET /api/analise/:id — análise empírica completa dos mercados do jogo:
// prob. justa (sem margem), frequência real com amostra, EV e evidências
router.get('/analise/:id', auth.autenticarOpcional, async (req, res) => {
  const jogos = cache.get('jogos:lista') || [];
  const jogo = jogos.find(j => String(j.id) === String(req.params.id));
  if (!jogo) return res.status(404).json({ ok: false, mensagem: 'Jogo não encontrado' });
  if (!jogo.odds) return res.json({ ok: false, mensagem: 'Sem odds publicadas para este jogo' });
  try {
    const espn = require('../scraper/espn');
    const { analisarMercados } = require('../analise/mercados');
    const conf = await espn.confronto(jogo.casa?.nome, jogo.fora?.nome);
    if (!conf?.ok) return res.json({ ok: false, mensagem: 'Sem histórico suficiente para análise' });
    // Sinais só valem PRÉ-JOGO. Ao vivo ou encerrado, análise não vai
    if (jogo.statusReal === 'ao-vivo' || jogo.statusReal === 'encerrado') {
      return res.json({ ok: false, mensagem: 'Sinais só disponíveis antes do jogo começar', jogoIniciado: true });
    }
    const analise = analisarMercados(jogo, conf);

    if (req.assinante) {
      // Enriquecer cada mercado com Kelly e retorno de referência (R\$100)
      for (const m of analise.mercados) {
        m.kellyPct = +(financeiro.kellyQuarter(m.probFinal / 100, m.odd) * 100).toFixed(2);
        m.retornoPor100 = +(100 * m.odd).toFixed(2);
      }
      return res.json(analise);
    }

    // Teaser público: quantidade + tipo dos mercados, SEM odd/EV/prob final.
    // Confronto direto: só o placar V-E-D (sem detalhes por jogo).
    const teaser = {
      ok: true,
      teaser: true,
      base: analise.base,
      resumo: {
        mercadosComValor: analise.mercados.filter(m => m.nivel==='forte' || m.nivel==='valor').length,
        mercadosAnalisados: analise.mercados.length,
        evMedio: analise.mercados.filter(m => m.nivel==='forte' || m.nivel==='valor')
          .reduce((s,m,_,a)=>s+m.ev/a.length,0),
        forte: analise.mercados.filter(m => m.nivel==='forte').length,
      },

      // Só métricas agregadas, nada que revele o resultado prováve
      confrontosDiretos: conf.h2h?.length || 0,
      jogosBase: (conf.casa?.ultimos?.length || 0) + (conf.fora?.ultimos?.length || 0),
    };
    res.json(teaser);
  } catch (err) {
    logger.error(`Análise ${req.params.id} falhou: ${err.message}`);
    res.status(502).json({ ok: false, mensagem: 'Falha ao montar a análise' });
  }
});

// GET /api/value-bets — todos os value bets de todos os jogos ordenados por EV
router.get('/value-bets', auth.exigirAssinatura, (req, res) => {
  const jogos = cache.get('jogos:lista') || [];

  const todos = jogos.flatMap(jogo =>
    (jogo.valueBets || []).map(vb => ({
      ...vb,
      jogoId: jogo.id,
      jogoNome: `${jogo.casa?.nome} x ${jogo.fora?.nome}`,
      data: jogo.data,
      hora: jogo.hora,
    }))
  );

  todos.sort((a, b) => b.ev - a.ev);

  const minEV = parseFloat(req.query.minEV) || 0;
  const resultado = todos.filter(vb => vb.ev >= minEV);

  res.json({
    ok: true,
    total: resultado.length,
    valueBets: resultado,
  });
});


// GET /api/track-record — histórico honesto (público — ferramenta de venda)
router.get('/track-record', async (req, res) => {
  try {
    const stats = await trackRecord.estatisticasTrackRecord();
    res.json({ ok: true, ...stats });
  } catch (err) {
    logger.error(`track-record: ${err.message}`);
    res.status(500).json({ ok: false, mensagem: 'Falha ao calcular track record' });
  }
});

// GET /api/ranking — melhores oportunidades da rodada (assinantes)
// Consolida todos os sinais VALOR FORTE/VALOR de jogos futuros por EV
router.get('/ranking', auth.exigirAssinatura, async (req, res) => {
  try {
    const jogos = cache.get('jogos:lista') || [];
    const espn = require('../scraper/espn');
    const { analisarMercados } = require('../analise/mercados');

    const oportunidades = [];
    for (const jogo of jogos) {
      if (!jogo?.odds || jogo.statusReal === 'ao-vivo' || jogo.statusReal === 'encerrado') continue;
      try {
        const conf = await espn.confronto(jogo.casa?.nome, jogo.fora?.nome);
        if (!conf?.ok) continue;
        const analise = analisarMercados(jogo, conf);
        for (const m of analise.mercados) {
          if (m.nivel !== 'forte' && m.nivel !== 'valor') continue;
          oportunidades.push({
            jogoId: jogo.id,
            confronto: `${jogo.casa?.nome} × ${jogo.fora?.nome}`,
            competicao: jogo.competicao,
            data: jogo.data, hora: jogo.hora,
            mercadoId: m.id, mercado: m.mercado,
            odd: m.odd, probFinal: m.probFinal, ev: m.ev, nivel: m.nivel,
            evidencia: m.evidencia,
            kellyPct: +(financeiro.kellyQuarter(m.probFinal / 100, m.odd) * 100).toFixed(2),
          });
        }
      } catch { /* pula jogos com falha */ }
    }

    oportunidades.sort((a, b) => b.ev - a.ev);
    const evMedio = oportunidades.length
      ? oportunidades.reduce((a, o) => a + o.ev, 0) / oportunidades.length : 0;

    res.json({
      ok: true,
      total: oportunidades.length,
      forte: oportunidades.filter(o => o.nivel === 'forte').length,
      valor: oportunidades.filter(o => o.nivel === 'valor').length,
      evMedio: +evMedio.toFixed(1),
      oportunidades,
    });
  } catch (err) {
    logger.error(`ranking: ${err.message}`);
    res.status(500).json({ ok: false, mensagem: 'Falha ao gerar ranking' });
  }
});

// POST /api/combinada — calcula matemática de uma múltipla (assinantes)
// Body: { pernas: [{ odd, prob }], stake }
router.post('/combinada', auth.exigirAssinatura, express.json(), (req, res) => {
  try {
    const { pernas, stake } = req.body || {};
    if (!Array.isArray(pernas) || pernas.length === 0) {
      return res.status(400).json({ ok: false, mensagem: 'pernas obrigatório' });
    }
    const stakeNum = Number(stake) || 100;
    const r = financeiro.retornoCombinada(pernas, stakeNum);
    res.json({ ok: true, ...r });
  } catch (err) {
    logger.error(`combinada: ${err.message}`);
    res.status(500).json({ ok: false, mensagem: err.message });
  }
});

module.exports = router;
