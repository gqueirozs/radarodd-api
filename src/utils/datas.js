// Conversão de jogo → timestamp para ordenação confiável.
// Prioriza startDate (ISO vindo da API Altenar); senão monta a partir de
// data "dd/mm/yyyy" (ou "dd/mm") + hora "hh:mm".
// NUNCA ordenar jogos por string de data brasileira com localeCompare —
// "30/06" > "03/07" lexicograficamente e a lista sai embaralhada.

function timestampJogo(j) {
  if (j && j.startDate) {
    const t = Date.parse(j.startDate);
    if (!Number.isNaN(t)) return t;
  }
  const data = (j && j.data) || '';
  const hora = (j && j.hora) || '00:00';
  const m = data.match(/^(\d{2})\/(\d{2})(?:\/(\d{4}))?$/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    const ano = yyyy || '2026';
    const t = Date.parse(`${ano}-${mm}-${dd}T${hora.match(/^\d{2}:\d{2}$/) ? hora : '00:00'}:00-03:00`);
    if (!Number.isNaN(t)) return t;
  }
  return 0; // sem data válida → vai pro fim da lista
}

// Mais recente primeiro (desc). Jogos sem data válida ficam por último.
function ordenarJogosDesc(jogos) {
  return jogos.sort((a, b) => timestampJogo(b) - timestampJogo(a));
}

module.exports = { timestampJogo, ordenarJogosDesc };
