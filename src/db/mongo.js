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

const Jogo   = mongoose.models.Jogo   || mongoose.model('Jogo', JogoSchema);

const CursorSchema = new mongoose.Schema({
  _id:     { type: String, default: 'varredura' },
  proximo: { type: Number, default: 16880000 },
  fim:     { type: Number, default: 16990000 },
});
const Cursor = mongoose.models.Cursor || mongoose.model('Cursor', CursorSchema);

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

async function getCursor() {
  if (!connected) return null;
  let c = await Cursor.findById('varredura').lean();
  if (!c) { await Cursor.create({ _id: 'varredura' }); c = { proximo: 16880000 }; }
  return c;
}

async function setCursor(proximo) {
  if (!connected) return;
  await Cursor.findByIdAndUpdate('varredura', { proximo }, { upsert: true });
}

module.exports = { conectar, getJogos, upsertJogo, getCursor, setCursor };
