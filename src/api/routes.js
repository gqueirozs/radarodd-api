const express  = require('express');
const router   = express.Router();
const cache    = require('../utils/cache');
const logger   = require('../utils/logger');
const mongoose = require('mongoose');
const { executarCicloCompleto } = require('../scraper/agendador');
const { ordenarJogosDesc } = require('../utils/datas');

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
router.get('/jogos', (req, res) => {
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

  // Ordenar por data/hora real: mais recente primeiro
  ordenarJogosDesc(resultado);

  res.json({
    ok: true,
    total: resultado.length,
    atualizadoEm: cache.getMetadata().ultimaAtualizacao,
    jogos: resultado,
  });
});

// GET /api/jogos/:id — odds completas de um jogo específico
router.get('/jogos/:id', (req, res) => {
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

    return res.json({ ok: true, jogo: encontrado });
  }

  res.json({ ok: true, jogo });
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

// GET /api/value-bets — todos os value bets de todos os jogos ordenados por EV
router.get('/value-bets', (req, res) => {
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

module.exports = router;
