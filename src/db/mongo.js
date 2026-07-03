const mongoose = require('mongoose');
const logger   = require('../utils/logger');

let connected = false;

async function conectar() {
  if (connected) return;
  const uri = process.env.MONGODB_URI;
  if (!uri) { logger.warn('MONGODB_URI não definida — rodando sem banco'); return; }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    connected = true;
    logger.ok('MongoDB Atlas conectado');
  } catch (e) {
    logger.error('MongoDB conexão falhou: ' + e.message);
  }
}

const JogoSchema = new mongoose.Schema({
  eventId:    { type: String, required: true, unique: true },
  nomeCasa:   String, nomeFora: String,
  abbCasa:    String, abbFora:  String,
  competicao: String, fase:     String,
  data:       String, hora:     String,
  estadio:    String, startDate: String,
  status:     { type: String, default: 'pre' },
  odds:       mongoose.Schema.Types.Mixed,
  atualizadoEm: { type: Date, default: Date.now },
}, { timestamps: true });

const Jogo = mongoose.models.Jogo || mongoose.model('Jogo', JogoSchema);

async function getJogos() {
  if (!connected) return null;
  return Jogo.find({}).sort({ startDate: 1 }).lean();
}

async function upsertJogo(info, odds) {
  if (!connected) return;
  await Jogo.findOneAndUpdate(
    { eventId: info.eventId },
    { ...info, odds, atualizadoEm: new Date() },
    { upsert: true, new: true }
  );
}

const CursorSchema = new mongoose.Schema({
  _id:     { type: String, default: 'varredura' },
  proximo: { type: Number, default: 16913900 }, // próximo aos IDs reais da Copa 2026
});
const Cursor = mongoose.models.Cursor || mongoose.model('Cursor', CursorSchema);

async function getCursor() {
  if (!connected) return null;
  let c = await Cursor.findById('varredura').lean();
  if (!c) { await Cursor.create({ _id: 'varredura' }); c = { proximo: 16913900 }; }
  // Correção: se o cursor salvo estiver muito abaixo dos IDs reais conhecidos, resetar
  if (c.proximo < 16900000) {
    await Cursor.findByIdAndUpdate('varredura', { proximo: 16913900 }, { upsert: true });
    c = { proximo: 16913900 };
    logger.warn('Cursor de varredura estava desatualizado — resetado para 16913900');
  }
  return c;
}

async function setCursor(proximo) {
  if (!connected) return;
  await Cursor.findByIdAndUpdate('varredura', { proximo }, { upsert: true });
}

// Lista resumida dos documentos no banco (para diagnóstico via admin)
async function listarJogosDB() {
  if (!connected) return null;
  return Jogo.find({}, { eventId: 1, nomeCasa: 1, nomeFora: 1, atualizadoEm: 1 })
    .sort({ eventId: 1 })
    .lean();
}

// Remove documentos órfãos do scraper antigo:
// o scraper atual usa eventId puramente numérico (ex: "16933952"),
// então qualquer doc com eventId ausente, nulo ou não-numérico é lixo.
async function limparOrfaos() {
  if (!connected) return { ok: false, mensagem: 'MongoDB não conectado' };
  const r = await Jogo.deleteMany({
    $or: [
      { eventId: { $exists: false } },
      { eventId: null },
      { eventId: { $not: /^\d+$/ } },
    ],
  });
  logger.ok(`Limpeza de órfãos: ${r.deletedCount} documentos removidos`);
  return { ok: true, removidos: r.deletedCount };
}

// Apaga TODOS os jogos (o scraper repopula no próximo ciclo)
async function resetJogos() {
  if (!connected) return { ok: false, mensagem: 'MongoDB não conectado' };
  const r = await Jogo.deleteMany({});
  logger.warn(`Reset da collection Jogo: ${r.deletedCount} documentos removidos`);
  return { ok: true, removidos: r.deletedCount };
}

module.exports = {
  conectar, getJogos, upsertJogo, getCursor, setCursor,
  listarJogosDB, limparOrfaos, resetJogos,
};
