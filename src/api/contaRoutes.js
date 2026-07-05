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

/* Webhook Hoopay — desenho de segurança:
 *   1. O corpo NUNCA é fonte de verdade. Ativação só via confirmação
 *      server-to-server (GET /pix/consult) na API oficial.
 *   2. Aceita GET e POST (Hoopay às vezes faz healthcheck do endpoint
 *      via GET no cadastro do webhook).
 *   3. Extrai UUID de qualquer estrutura conhecida do payload.
 *   4. Sempre responde 200 pra Hoopay não re-tentar; erros ficam no log.
 *   5. Log inclui um resumo do payload pra rastreabilidade em auditoria. */
async function tratarWebhook(req, res) {
  try {
    const b = req.body || {};
    // Formato Hoopay: charges[i].uuid | payment.charges[i].uuid; também aceita orderUUID/uuid soltos
    const uuidsDoBody = [];
    const coletar = obj => {
      if (!obj || typeof obj !== 'object') return;
      if (obj.uuid && typeof obj.uuid === 'string') uuidsDoBody.push(obj.uuid);
      if (obj.orderUUID && typeof obj.orderUUID === 'string') uuidsDoBody.push(obj.orderUUID);
      if (Array.isArray(obj.charges)) obj.charges.forEach(coletar);
      if (obj.payment) coletar(obj.payment);
      if (obj.data) coletar(obj.data);
      if (obj.order) coletar(obj.order);
    };
    coletar(b);

    // Query string como fallback (?uuid=… ou ?orderUUID=…)
    if (req.query?.uuid) uuidsDoBody.push(req.query.uuid);
    if (req.query?.orderUUID) uuidsDoBody.push(req.query.orderUUID);

    const unicos = [...new Set(uuidsDoBody)];
    logger.info(`Webhook Hoopay recebido (${req.method}): ${unicos.length} uuid(s) [${unicos.join(', ')}]`);

    for (const uuid of unicos) {
      try {
        const r = await hoopay.confirmarSePago(uuid);
        logger.info(`Webhook → ${uuid}: ${r.status}${r.statusBruto ? ` (raw=${r.statusBruto})` : ''}`);
      } catch (e) {
        logger.warn(`Webhook consulta ${uuid} falhou: ${e.message}`);
      }
    }

    res.json({ ok: true, processados: unicos.length });
  } catch (err) {
    logger.warn(`Webhook exceção: ${err.message}`);
    res.json({ ok: true }); // 200 sempre, pra Hoopay não re-tentar
  }
}

router.post('/assinatura/webhook', express.json({ limit: '100kb' }), tratarWebhook);
router.get('/assinatura/webhook', tratarWebhook); // healthcheck / validação da Hoopay
router.head('/assinatura/webhook', (req, res) => res.status(200).end());

module.exports = router;
