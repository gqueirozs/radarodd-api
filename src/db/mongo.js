const mongoose = require('mongoose');
const logger   = require('../utils/logger');
const { confrontoId } = require('../utils/slug');

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
  confrontoId:{ type: String, index: true }, // slug normalizado "australia-vs-egito"
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
    { ...info, confrontoId: confrontoId(info.nomeCasa, info.nomeFora), odds, atualizadoEm: new Date() },
    { upsert: true }
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

  // 1) Docs claramente inválidos: sem eventId numérico ou sem nomes
  const r1 = await Jogo.deleteMany({
    $or: [
      { eventId: { $exists: false } },
      { eventId: null },
      { eventId: { $not: /^\d+$/ } },
      { nomeCasa: { $in: [null, ''] } },
      { nomeFora: { $in: [null, ''] } },
    ],
  });

  // 2) Duplicatas do MESMO confronto sob eventIds diferentes (resíduo do
  //    scraper antigo por varredura). Agrupa pelo slug normalizado e mantém
  //    apenas o documento mais recente de cada confronto.
  const docs = await Jogo.find({}, { eventId: 1, nomeCasa: 1, nomeFora: 1, atualizadoEm: 1, updatedAt: 1 }).lean();
  const porConfronto = new Map();
  for (const d of docs) {
    const key = confrontoId(d.nomeCasa, d.nomeFora);
    if (!porConfronto.has(key)) porConfronto.set(key, []);
    porConfronto.get(key).push(d);
  }
  const idsParaRemover = [];
  for (const grupo of porConfronto.values()) {
    if (grupo.length < 2) continue;
    grupo.sort((a, b) => new Date(b.atualizadoEm || b.updatedAt || 0) - new Date(a.atualizadoEm || a.updatedAt || 0));
    for (const dup of grupo.slice(1)) idsParaRemover.push(dup._id);
  }
  let r2 = { deletedCount: 0 };
  if (idsParaRemover.length) {
    r2 = await Jogo.deleteMany({ _id: { $in: idsParaRemover } });
  }

  const total = r1.deletedCount + r2.deletedCount;
  if (total > 0) {
    logger.ok(`Limpeza: ${r1.deletedCount} órfãos + ${r2.deletedCount} duplicatas removidos`);
  }
  return { ok: true, removidos: total, orfaos: r1.deletedCount, duplicatas: r2.deletedCount };
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
