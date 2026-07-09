/**
 * Persistência e resolução automática de sinais para track record honesto.
 *
 * A cada ciclo do agendador, snapshotamos os sinais VALOR FORTE / VALOR
 * emitidos para jogos pré-jogo. Quando o jogo encerra, resolvemos
 * automaticamente (acertou/errou) e o histórico fica auditável.
 */
const mongoose = require('mongoose');
const logger = require('../utils/logger');

const SinalHistoricoSchema = new mongoose.Schema({
  jogoId:      { type: String, required: true, index: true },
  eventId:     { type: String, index: true },
  competicao:  String,
  nomeCasa:    String, nomeFora: String,
  data:        String, hora: String,

  mercadoId:   { type: String, required: true }, // 'casa' | 'fora' | 'over' | 'under' | 'btts' | 'bttsNao'
  mercado:     String,   // texto humano ("Marrocos vence")
  odd:         Number,
  probFinal:   Number,   // nossa estimativa (0-100)
  ev:          Number,   // %
  nivel:       String,   // 'forte' | 'valor'

  status:      { type: String, default: 'aberto' }, // aberto | acertou | errou | anulado
  placarCasa:  Number,
  placarFora:  Number,
  resolvidoEm: Date,
}, { timestamps: true });

// Não recriar índice se já existe
SinalHistoricoSchema.index({ jogoId: 1, mercadoId: 1 }, { unique: true });

const SinalHistorico = mongoose.models.SinalHistorico
  || mongoose.model('SinalHistorico', SinalHistoricoSchema);

/* Snapshot: registra os sinais emitidos pro jogo (idempotente por jogoId+mercadoId).
 * Só grava sinais VALOR FORTE ou VALOR pré-jogo — os únicos que "contam". */
async function snapshotSinais(jogo, analise) {
  if (!jogo?.id || !analise?.mercados) return 0;
  if (jogo.statusReal === 'ao-vivo' || jogo.statusReal === 'encerrado') return 0;

  const paraGravar = analise.mercados.filter(m => m.nivel === 'forte' || m.nivel === 'valor');
  let novos = 0;
  for (const m of paraGravar) {
    try {
      const r = await SinalHistorico.updateOne(
        { jogoId: String(jogo.id), mercadoId: m.id },
        {
          $setOnInsert: {
            jogoId: String(jogo.id),
            eventId: jogo.eventId || null,
            competicao: jogo.competicao || null,
            nomeCasa: jogo.casa?.nome, nomeFora: jogo.fora?.nome,
            data: jogo.data, hora: jogo.hora,
            mercadoId: m.id, mercado: m.mercado,
            odd: m.odd, probFinal: m.probFinal, ev: m.ev, nivel: m.nivel,
            status: 'aberto',
          },
        },
        { upsert: true }
      );
      if (r.upsertedCount) novos++;
    } catch (e) {
      // duplicate key esperada quando já existe — ignorar
      if (!/duplicate/i.test(e.message)) logger.warn(`snapshotSinais: ${e.message}`);
    }
  }
  return novos;
}

/* Resolve sinais em aberto usando o placar final do jogo. */
function determinarResultado(mercadoId, placarCasa, placarFora) {
  const total = placarCasa + placarFora;
  const bttsFoi = placarCasa > 0 && placarFora > 0;
  switch (mercadoId) {
    case 'casa':    return placarCasa >  placarFora ? 'acertou' : 'errou';
    case 'fora':    return placarFora >  placarCasa ? 'acertou' : 'errou';
    case 'over':    return total >= 3 ? 'acertou' : 'errou'; // linha 2.5
    case 'under':   return total <  3 ? 'acertou' : 'errou';
    case 'btts':    return bttsFoi ? 'acertou' : 'errou';
    case 'bttsNao': return bttsFoi ? 'errou' : 'acertou';
    default:        return null;
  }
}

/* Resolve todos os sinais em aberto de um jogo encerrado. */
async function resolverSinaisDoJogo(jogo) {
  if (!jogo?.placar || jogo.statusReal !== 'encerrado') return 0;
  const abertos = await SinalHistorico.find({ jogoId: String(jogo.id), status: 'aberto' });
  let resolvidos = 0;
  for (const s of abertos) {
    const resultado = determinarResultado(s.mercadoId, jogo.placar.casa, jogo.placar.fora);
    if (!resultado) continue;
    s.status = resultado;
    s.placarCasa = jogo.placar.casa;
    s.placarFora = jogo.placar.fora;
    s.resolvidoEm = new Date();
    await s.save();
    resolvidos++;
  }
  if (resolvidos > 0) logger.ok(`Track record: ${resolvidos} sinais resolvidos (${jogo.casa?.nome} x ${jogo.fora?.nome})`);
  return resolvidos;
}

/* Estatísticas agregadas do track record. */
async function estatisticasTrackRecord() {
  const [resolvidos, abertos] = await Promise.all([
    SinalHistorico.find({ status: { $in: ['acertou', 'errou'] } }).lean(),
    SinalHistorico.countDocuments({ status: 'aberto' }),
  ]);

  if (resolvidos.length === 0) {
    return { totalResolvidos: 0, totalAbertos: abertos };
  }

  const acertos = resolvidos.filter(s => s.status === 'acertou');
  // ROI: quanto o unit stake teria rendido apostando 1 em cada sinal
  const investimento = resolvidos.length; // 1 unit por sinal
  const retorno = acertos.reduce((acc, s) => acc + s.odd, 0);
  const lucro = retorno - investimento;
  const roi = investimento > 0 ? (lucro / investimento) * 100 : 0;

  // Por nível
  const porNivel = {};
  for (const nv of ['forte', 'valor']) {
    const arr = resolvidos.filter(s => s.nivel === nv);
    const ac = arr.filter(s => s.status === 'acertou');
    const inv = arr.length;
    const ret = ac.reduce((a, s) => a + s.odd, 0);
    porNivel[nv] = {
      total: inv, acertos: ac.length,
      taxaAcerto: inv > 0 ? +(ac.length / inv * 100).toFixed(1) : 0,
      roi: inv > 0 ? +((ret - inv) / inv * 100).toFixed(1) : 0,
    };
  }

  // Últimos sinais resolvidos (mais recentes primeiro)
  const recentes = resolvidos
    .sort((a, b) => new Date(b.resolvidoEm) - new Date(a.resolvidoEm))
    .slice(0, 20)
    .map(s => ({
      jogo: `${s.nomeCasa} × ${s.nomeFora}`,
      mercado: s.mercado, odd: s.odd, nivel: s.nivel,
      status: s.status,
      placar: `${s.placarCasa}-${s.placarFora}`,
      data: s.data,
    }));

  return {
    totalResolvidos: resolvidos.length,
    totalAbertos: abertos,
    acertos: acertos.length,
    erros: resolvidos.length - acertos.length,
    taxaAcerto: +(acertos.length / resolvidos.length * 100).toFixed(1),
    roi: +roi.toFixed(1),
    lucroUnidades: +lucro.toFixed(2), // "se apostasse 1 unit por sinal"
    porNivel,
    recentes,
  };
}

module.exports = {
  SinalHistorico,
  snapshotSinais,
  resolverSinaisDoJogo,
  estatisticasTrackRecord,
};
