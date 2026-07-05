/**
 * Autenticação e assinaturas.
 *
 * Segurança:
 *  - Senhas com bcrypt (custo 10), nunca armazenadas em claro
 *  - JWT assinado com JWT_SECRET (env), expiração 30 dias
 *  - Assinatura validada SEMPRE no servidor: quem não é assinante não
 *    recebe os dados premium na resposta — não há nada pra "descobrir"
 *    no HTML porque o conteúdo nunca sai da API
 */
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-apenas-trocar-em-producao';
if (!process.env.JWT_SECRET) {
  logger.warn('JWT_SECRET não definido — usando chave de desenvolvimento. Configure no Railway!');
}

const UsuarioSchema = new mongoose.Schema({
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  nome:      { type: String, required: true, trim: true },
  senhaHash: { type: String, required: true },
  telefone:  { type: String, default: '' },
  documento: { type: String, default: '' }, // CPF p/ cobrança
  assinatura: {
    expiraEm:        { type: Date, default: null },
    ultimoPagamento: { type: Date, default: null },
  },
}, { timestamps: true });

const PagamentoSchema = new mongoose.Schema({
  usuarioId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', required: true, index: true },
  orderUUID:   { type: String, index: true },
  valor:       { type: Number, required: true },
  status:      { type: String, enum: ['pendente', 'pago', 'expirado', 'falhou'], default: 'pendente' },
  pixCopiaCola:{ type: String, default: null },
  pixQrcode:   { type: String, default: null },
  pagoEm:      { type: Date, default: null },
}, { timestamps: true });

const Usuario   = mongoose.models.Usuario   || mongoose.model('Usuario', UsuarioSchema);
const Pagamento = mongoose.models.Pagamento || mongoose.model('Pagamento', PagamentoSchema);

/* ── Helpers ──────────────────────────────────────────────────────── */
function assinaturaAtiva(usuario) {
  return !!(usuario?.assinatura?.expiraEm && new Date(usuario.assinatura.expiraEm) > new Date());
}

function gerarToken(usuario) {
  return jwt.sign({ uid: usuario._id.toString() }, JWT_SECRET, { expiresIn: '30d' });
}

function usuarioPublico(u) {
  return {
    id: u._id,
    nome: u.nome,
    email: u.email,
    assinante: assinaturaAtiva(u),
    assinaturaExpiraEm: u.assinatura?.expiraEm || null,
  };
}

/* ── Operações ────────────────────────────────────────────────────── */
async function registrar({ nome, email, senha }) {
  if (!nome || nome.trim().length < 2) throw new ErroApp('Informe seu nome');
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw new ErroApp('E-mail inválido');
  if (!senha || senha.length < 8) throw new ErroApp('A senha precisa ter pelo menos 8 caracteres');

  const existente = await Usuario.findOne({ email: email.toLowerCase().trim() });
  if (existente) throw new ErroApp('Já existe uma conta com esse e-mail');

  const senhaHash = await bcrypt.hash(senha, 10);
  const usuario = await Usuario.create({ nome: nome.trim(), email, senhaHash });
  return { token: gerarToken(usuario), usuario: usuarioPublico(usuario) };
}

async function login({ email, senha }) {
  const usuario = await Usuario.findOne({ email: (email || '').toLowerCase().trim() });
  // mesma mensagem p/ email inexistente e senha errada (não vazar cadastro)
  if (!usuario) throw new ErroApp('E-mail ou senha incorretos', 401);
  const ok = await bcrypt.compare(senha || '', usuario.senhaHash);
  if (!ok) throw new ErroApp('E-mail ou senha incorretos', 401);
  return { token: gerarToken(usuario), usuario: usuarioPublico(usuario) };
}

async function usuarioDoToken(token) {
  try {
    const { uid } = jwt.verify(token, JWT_SECRET);
    return await Usuario.findById(uid);
  } catch {
    return null;
  }
}

/* Ativa/renova 30 dias a partir do fim atual (ou de agora, se expirada) */
async function ativarAssinatura(usuarioId, dataPagamento = new Date()) {
  const usuario = await Usuario.findById(usuarioId);
  if (!usuario) return null;
  const base = assinaturaAtiva(usuario) ? new Date(usuario.assinatura.expiraEm) : new Date();
  usuario.assinatura.expiraEm = new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000);
  usuario.assinatura.ultimoPagamento = dataPagamento;
  await usuario.save();
  logger.ok(`Assinatura ativa até ${usuario.assinatura.expiraEm.toISOString()} — ${usuario.email}`);
  return usuario;
}

/* ── Middlewares ──────────────────────────────────────────────────── */
function extrairToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Anexa req.usuario se houver token válido; nunca bloqueia
async function autenticarOpcional(req, _res, next) {
  const token = extrairToken(req);
  req.usuario = token ? await usuarioDoToken(token) : null;
  req.assinante = assinaturaAtiva(req.usuario);
  next();
}

// Exige login
async function exigirLogin(req, res, next) {
  const token = extrairToken(req);
  req.usuario = token ? await usuarioDoToken(token) : null;
  if (!req.usuario) return res.status(401).json({ ok: false, mensagem: 'Faça login para continuar' });
  req.assinante = assinaturaAtiva(req.usuario);
  next();
}

// Exige assinatura ativa — o portão do conteúdo premium
async function exigirAssinatura(req, res, next) {
  const token = extrairToken(req);
  req.usuario = token ? await usuarioDoToken(token) : null;
  if (!req.usuario) return res.status(401).json({ ok: false, mensagem: 'Faça login para continuar', codigo: 'login' });
  if (!assinaturaAtiva(req.usuario)) {
    return res.status(403).json({ ok: false, mensagem: 'Conteúdo exclusivo para assinantes', codigo: 'assinar' });
  }
  req.assinante = true;
  next();
}

class ErroApp extends Error {
  constructor(mensagem, status = 400) { super(mensagem); this.status = status; }
}

module.exports = {
  Usuario, Pagamento,
  registrar, login, usuarioDoToken, usuarioPublico,
  ativarAssinatura, assinaturaAtiva,
  autenticarOpcional, exigirLogin, exigirAssinatura,
  ErroApp,
};
