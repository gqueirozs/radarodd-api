/**
 * Integração Hoopay (PIX) — assinatura SinalOdds Premium.
 *
 * Fluxo:
 *  1. POST /charge (type: pix) → cria a cobrança, guarda orderUUID
 *  2. Frontend mostra QR/copia-e-cola e consulta o status
 *  3. Confirmação SEMPRE server-to-server via GET /pix/consult/:orderUUID
 *     — o webhook e o polling do front apenas DISPARAM a consulta;
 *     nunca confiamos no corpo de uma requisição externa pra ativar.
 */
const logger = require('../utils/logger');
const { Pagamento, ativarAssinatura } = require('../auth/auth');

const HOOPAY_BASE = process.env.HOOPAY_BASE_URL || 'https://api.pay.hoopay.com.br';
const HOOPAY_CLIENT_ID     = process.env.HOOPAY_CLIENT_ID || '';
const HOOPAY_CLIENT_SECRET = process.env.HOOPAY_CLIENT_SECRET || '';
const HOOPAY_KEY  = process.env.HOOPAY_API_KEY || ''; // alternativa: chave única
const PRECO_MENSAL = 9.99;

function headersHoopay() {
  const h = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (HOOPAY_CLIENT_ID && HOOPAY_CLIENT_SECRET) {
    // Client ID + Secret → HTTP Basic (padrão de gateways com esse par)
    const basic = Buffer.from(`${HOOPAY_CLIENT_ID}:${HOOPAY_CLIENT_SECRET}`).toString('base64');
    h['Authorization'] = `Basic ${basic}`;
    // alguns gateways aceitam/exigem os pares também como headers próprios
    h['ci'] = HOOPAY_CLIENT_ID;
    h['cs'] = HOOPAY_CLIENT_SECRET;
  } else if (HOOPAY_KEY) {
    h['Authorization'] = `Bearer ${HOOPAY_KEY}`;
  }
  return h;
}

async function hoopay(caminho, opts = {}) {
  const res = await fetch(`${HOOPAY_BASE}${caminho}`, {
    ...opts,
    headers: { ...headersHoopay(), ...(opts.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  const texto = await res.text();
  let json = null;
  try { json = JSON.parse(texto); } catch { /* resposta não-JSON */ }
  if (!res.ok) {
    logger.warn(`Hoopay ${caminho} → ${res.status}: ${texto.slice(0, 300)}`);
    throw new Error(json?.message || `Hoopay retornou ${res.status}`);
  }
  return json;
}

/* Cria a cobrança PIX de 1 mês para o usuário */
async function criarCobrancaPix(usuario, ipCliente) {
  const publicUrl = process.env.PUBLIC_API_URL || 'https://radarodd-api-production.up.railway.app';

  const payload = {
    amount: PRECO_MENSAL,
    customer: {
      email: usuario.email,
      name: usuario.nome,
      phone: usuario.telefone || '',
      document: usuario.documento || '',
    },
    products: [
      { title: 'SinalOdds Premium — 30 dias', amount: PRECO_MENSAL, quantity: 1 },
    ],
    payments: [
      { amount: PRECO_MENSAL, type: 'pix' },
    ],
    data: {
      ip: ipCliente || '0.0.0.0',
      src: 'sinalodds',
      callbackURL: `${publicUrl}/api/assinatura/webhook`,
    },
  };

  const resp = await hoopay('/charge', { method: 'POST', body: JSON.stringify(payload) });

  // Formato da Hoopay: payment.charges[0].{uuid,pixPayload,pixQrCode}
  const charge = resp?.payment?.charges?.[0] || resp?.charges?.[0] || resp?.charge || null;
  const orderUUID = charge?.uuid || charge?.orderUUID
    || resp?.payment?.uuid || resp?.orderUUID || resp?.uuid || null;
  const copiaCola = charge?.pixPayload || charge?.copyPaste || charge?.pix?.copyPaste
    || charge?.emv || null;
  const qrcode = charge?.pixQrCode || charge?.qrCode || charge?.pix?.qrcode || null;

  if (!orderUUID) {
    logger.error(`Hoopay /charge sem orderUUID reconhecível: ${JSON.stringify(resp).slice(0, 800)}`);
    throw new Error('Resposta inesperada do provedor de pagamento');
  }

  // Diagnóstico: se orderUUID veio mas copia/qr não, dá pra ver as chaves
  if (!copiaCola || !qrcode) {
    const amostra = JSON.stringify(resp).slice(0, 1500);
    logger.warn(`Hoopay /charge sem PIX (copia=${!!copiaCola} qr=${!!qrcode}). Resposta bruta: ${amostra}`);
  }

  const pagamento = await Pagamento.create({
    usuarioId: usuario._id,
    orderUUID,
    valor: PRECO_MENSAL,
    pixCopiaCola: copiaCola,
    pixQrcode: qrcode,
  });

  logger.ok(`PIX criado: ${orderUUID} — ${usuario.email}`);
  return {
    pagamentoId: pagamento._id,
    orderUUID,
    valor: PRECO_MENSAL,
    copiaCola,
    qrcode,
  };
}

/* Consulta a Hoopay e, se pago, ativa a assinatura (idempotente) */
async function confirmarSePago(orderUUID) {
  const pagamento = await Pagamento.findOne({ orderUUID });
  if (!pagamento) return { status: 'desconhecido' };
  if (pagamento.status === 'pago') return { status: 'pago' };

  const resp = await hoopay(`/pix/consult/${encodeURIComponent(orderUUID)}`, { method: 'GET' });
  const statusBruto = String(
    resp?.status || resp?.data?.status || resp?.payment?.status || resp?.pix?.status || ''
  ).toLowerCase();

  const pago = ['paid', 'approved', 'completed', 'confirmed', 'pago', 'aprovado'].some(s => statusBruto.includes(s));
  if (!pago) return { status: 'pendente', statusBruto };

  pagamento.status = 'pago';
  pagamento.pagoEm = new Date();
  await pagamento.save();
  await ativarAssinatura(pagamento.usuarioId, pagamento.pagoEm);
  return { status: 'pago' };
}

module.exports = { criarCobrancaPix, confirmarSePago, PRECO_MENSAL };
