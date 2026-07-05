/**
 * Rotas de conta e assinatura.
 * POST /api/auth/registrar  { nome, email, senha }
 * POST /api/auth/login      { email, senha }
 * GET  /api/auth/me         (Bearer)
 * POST /api/assinatura/pix  (Bearer) { documento?, telefone? } → QR PIX
 * GET  /api/assinatura/status/:orderUUID (Bearer) → pendente|pago
 * POST /api/assinatura/webhook — callback Hoopay (confirma via consulta)
 */
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const auth = require('../auth/auth');
const hoopay = require('../pagamentos/hoopay');

/* rate-limit simples em memória p/ endpoints sensíveis (força bruta) */
const tentativas = new Map();
function limitar(chavePrefixo, max, janelaMs) {
  return (req, res, next) => {
    const chave = `${chavePrefixo}:${req.ip}`;
    const agora = Date.now();
    const item = tentativas.get(chave) || { n: 0, inicio: agora };
    if (agora - item.inicio > janelaMs) { item.n = 0; item.inicio = agora; }
    item.n++;
    tentativas.set(chave, item);
    if (item.n > max) {
      return res.status(429).json({ ok: false, mensagem: 'Muitas tentativas. Aguarde um minuto.' });
    }
    next();
  };
}

function tratarErro(res, err, contexto) {
  const status = err.status || 500;
  if (status >= 500) logger.error(`${contexto}: ${err.message}`);
  res.status(status).json({ ok: false, mensagem: status >= 500 ? 'Erro interno' : err.message });
}

/* ── Conta ────────────────────────────────────────────────────────── */
router.post('/auth/registrar', limitar('reg', 10, 60 * 1000), async (req, res) => {
  try {
    const { token, usuario } = await auth.registrar(req.body || {});
    res.json({ ok: true, token, usuario });
  } catch (err) { tratarErro(res, err, 'registrar'); }
});

router.post('/auth/login', limitar('login', 15, 60 * 1000), async (req, res) => {
  try {
    const { token, usuario } = await auth.login(req.body || {});
    res.json({ ok: true, token, usuario });
  } catch (err) { tratarErro(res, err, 'login'); }
});

router.get('/auth/me', auth.exigirLogin, (req, res) => {
  res.json({ ok: true, usuario: auth.usuarioPublico(req.usuario) });
});

/* ── Assinatura ───────────────────────────────────────────────────── */
router.post('/assinatura/pix', auth.exigirLogin, limitar('pix', 6, 60 * 1000), async (req, res) => {
  try {
    // CPF/telefone informados no checkout ficam salvos p/ próximas renovações
    const { documento, telefone } = req.body || {};
    let mudou = false;
    if (documento && /^\d{11}$/.test(documento.replace(/\D/g, ''))) {
      req.usuario.documento = documento.replace(/\D/g, ''); mudou = true;
    }
    if (telefone && telefone.replace(/\D/g, '').length >= 10) {
      req.usuario.telefone = telefone.replace(/\D/g, ''); mudou = true;
    }
    if (mudou) await req.usuario.save();

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
    const cobranca = await hoopay.criarCobrancaPix(req.usuario, ip);
    res.json({ ok: true, ...cobranca });
  } catch (err) { tratarErro(res, err, 'assinatura/pix'); }
});

router.get('/assinatura/status/:orderUUID', auth.exigirLogin, async (req, res) => {
  try {
    // só o dono do pagamento pode consultar
    const { Pagamento } = auth;
    const pg = await Pagamento.findOne({ orderUUID: req.params.orderUUID });
    if (!pg || String(pg.usuarioId) !== String(req.usuario._id)) {
      return res.status(404).json({ ok: false, mensagem: 'Pagamento não encontrado' });
    }
    const r = await hoopay.confirmarSePago(req.params.orderUUID);
    const usuario = r.status === 'pago'
      ? auth.usuarioPublico(await auth.Usuario.findById(req.usuario._id))
      : auth.usuarioPublico(req.usuario);
    res.json({ ok: true, status: r.status, usuario });
  } catch (err) { tratarErro(res, err, 'assinatura/status'); }
});

/* Webhook Hoopay: o corpo NUNCA é confiável — extraímos o orderUUID e
 * confirmamos server-to-server na API da Hoopay antes de ativar. */
router.post('/assinatura/webhook', express.json({ limit: '100kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const orderUUID = b.orderUUID || b.order_uuid || b.uuid || b.order?.uuid || b.data?.orderUUID || null;
    if (orderUUID) {
      const r = await hoopay.confirmarSePago(orderUUID);
      logger.info(`Webhook Hoopay ${orderUUID} → ${r.status}`);
    }
    res.json({ ok: true }); // sempre 200 pra Hoopay não re-tentar infinito
  } catch (err) {
    logger.warn(`Webhook falhou: ${err.message}`);
    res.json({ ok: true });
  }
});

module.exports = router;
