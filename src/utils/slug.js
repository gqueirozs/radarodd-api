// Normalização ÚNICA de nomes → slug, usada por scraper, agendador e db.
// "Austrália" → "australia" | "Costa do Marfim" → "costa-do-marfim"
// IMPORTANTE: qualquer lugar do código que precise gerar id de time ou
// confronto DEVE usar estas funções — nunca reimplementar o replace local,
// senão o mesmo jogo gera slugs diferentes e fura a deduplicação.

function nomeParaId(nome) {
  return (nome || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function confrontoId(nomeCasa, nomeFora) {
  return `${nomeParaId(nomeCasa)}-vs-${nomeParaId(nomeFora)}`;
}

module.exports = { nomeParaId, confrontoId };
