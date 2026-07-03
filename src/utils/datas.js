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

// Recalcula data/hora (fuso de Brasília) a partir do startDate ISO.
// Corrige registros antigos gravados com hora UTC.
function normalizarDataHora(jogos) {
  for (const j of jogos) {
    if (!j || !j.startDate) continue;
    const d = new Date(j.startDate);
    if (Number.isNaN(d.getTime())) continue;
    j.data = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    j.hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  }
  return jogos;
}

module.exports = { timestampJogo, ordenarJogosDesc, normalizarDataHora };
