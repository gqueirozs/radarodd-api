const puppeteer = require('puppeteer');
const logger = require('../utils/logger');
const { parseJogo } = require('../utils/parser');

const BASE_URL = process.env.SCRAPER_BASE_URL || 'https://esportiva.bet.br';
const COPA_URL = `${BASE_URL}/sports/futebol/mundo/copa-do-mundo-2026`;

// Aguarda elemento aparecer na página
async function waitAndGet(page, selector, timeout = 8000) {
  await page.waitForSelector(selector, { timeout });
  return page.$(selector);
}

// Extrai texto limpo de um elemento
async function getText(el, selector) {
  try {
    const child = await el.$(selector);
    if (!child) return null;
    return (await child.evaluate(n => n.textContent.trim())) || null;
  } catch {
    return null;
  }
}

// Extrai odd numérica de um elemento
async function getOdd(el, selector) {
  const text = await getText(el, selector);
  if (!text) return null;
  const n = parseFloat(text.replace(',', '.'));
  return isNaN(n) ? null : n;
}

// Inicializa o browser Puppeteer
async function criarBrowser() {
  return puppeteer.launch({
    headless: process.env.PUPPETEER_HEADLESS !== 'false',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1366,768',
    ],
  });
}

// Coleta a lista de eventos da Copa do Mundo
async function coletarListaJogos(page) {
  logger.scraper('Acessando lista de jogos da Copa...');
  await page.goto(COPA_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  // Aguarda os cards de eventos carregarem
  await page.waitForSelector('[class*="event"]', { timeout: 15000 }).catch(() => {
    logger.warn('Seletor de eventos não encontrado, tentando alternativo...');
  });

  await page.waitForTimeout(2000);

  // Extrai links dos eventos
  const eventos = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/ev-"]'));
    return links
      .map(a => ({
        href: a.href,
        texto: a.textContent.trim(),
      }))
      .filter(e => e.href.includes('futebol') || e.href.includes('copa'))
      .slice(0, 20); // máximo 20 jogos por rodada
  });

  logger.scraper(`Encontrados ${eventos.length} eventos`);
  return eventos;
}

// Coleta as odds de um evento específico
async function coletarOddsEvento(page, url) {
  logger.scraper(`Coletando: ${url.split('/').slice(-2).join('/')}`);

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(3000);

  const dados = await page.evaluate(() => {
    const getText = (el, sel) => el?.querySelector(sel)?.textContent?.trim() || null;
    const getOdd = (el, sel) => {
      const t = getText(el, sel);
      if (!t) return null;
      const n = parseFloat(t.replace(',', '.'));
      return isNaN(n) ? null : n;
    };

    // Tentar extrair nomes dos times do header
    const nomes = Array.from(document.querySelectorAll('[class*="participant"], [class*="team-name"], h1, h2'))
      .map(el => el.textContent.trim())
      .filter(t => t.length > 2 && t.length < 40);

    // Extrair odds dos mercados visíveis
    const mercados = {};

    // 1x2 resultado
    const oddEls = Array.from(document.querySelectorAll('[class*="odd"], [class*="price"], [data-odd]'));
    const oddValues = oddEls
      .map(el => {
        const t = el.textContent.trim();
        const n = parseFloat(t.replace(',', '.'));
        return isNaN(n) || n < 1.01 || n > 500 ? null : n;
      })
      .filter(Boolean);

    // Extrair texto dos labels dos mercados
    const labels = Array.from(document.querySelectorAll('[class*="label"], [class*="market-name"], [class*="outcome"]'))
      .map(el => el.textContent.trim())
      .filter(t => t.length > 0 && t.length < 60);

    return {
      url: window.location.href,
      titulo: document.title,
      nomes,
      oddValues,
      labels,
      // Raw HTML de mercados para debug
      rawMercados: Array.from(document.querySelectorAll('[class*="market"]')).slice(0, 5)
        .map(el => ({ classe: el.className, texto: el.textContent.slice(0, 200) })),
    };
  });

  return dados;
}

// Coleta odds de um evento usando seletores específicos da EsportivaBet
async function coletarOddsEsportivaBet(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Expandir todos os mercados clicando neles
  await page.evaluate(() => {
    const headers = document.querySelectorAll('[class*="market-header"], [class*="section-header"]');
    headers.forEach(h => h.click());
  });

  await page.waitForTimeout(1500);

  const resultado = await page.evaluate(() => {
    function getOddDeTexto(texto) {
      if (!texto) return null;
      const match = texto.match(/\b(\d+[.,]\d{2})\b/);
      if (!match) return null;
      const n = parseFloat(match[1].replace(',', '.'));
      return (n >= 1.01 && n <= 500) ? n : null;
    }

    const dados = {
      resultado: {},
      totalGols: { linha: 2.5 },
      ambasMarcam: {},
      primeiroGol: {},
      chanceDupla: {},
      qualificar: {},
      escanteios: { linha: 9.5 },
      handicap: [],
      placares: [],
    };

    // Buscar todos os blocos de mercado
    const blocos = document.querySelectorAll('[class*="event-section"], [class*="market"], [class*="betting-market"]');

    blocos.forEach(bloco => {
      const titulo = bloco.querySelector('[class*="title"], [class*="header"], h3, h4')?.textContent?.trim()?.toLowerCase() || '';
      const botoes = Array.from(bloco.querySelectorAll('button, [class*="outcome"], [class*="selection"]'));

      if (titulo.includes('vencedor') || titulo.includes('resultado') || titulo.includes('1x2')) {
        botoes.forEach(btn => {
          const texto = btn.textContent.trim();
          const odd = getOddDeTexto(texto);
          if (!odd) return;
          if (texto.toLowerCase().includes('empate') || texto === 'x') {
            dados.resultado.empate = odd;
          } else if (botoes.indexOf(btn) === 0) {
            dados.resultado.casa = odd;
          } else {
            dados.resultado.fora = odd;
          }
        });
      }

      if (titulo.includes('total de gols') && !titulo.includes('brasil') && !titulo.includes('jap')) {
        botoes.forEach(btn => {
          const texto = btn.textContent.trim().toLowerCase();
          const odd = getOddDeTexto(texto);
          if (!odd) return;
          if (texto.includes('mais')) dados.totalGols.mais = odd;
          if (texto.includes('menos')) dados.totalGols.menos = odd;
          const linhaMatch = texto.match(/(\d+[.,]\d)/);
          if (linhaMatch) dados.totalGols.linha = parseFloat(linhaMatch[1].replace(',', '.'));
        });
      }

      if (titulo.includes('ambas')) {
        botoes.forEach(btn => {
          const texto = btn.textContent.trim().toLowerCase();
          const odd = getOddDeTexto(texto);
          if (!odd) return;
          if (texto.includes('sim')) dados.ambasMarcam.sim = odd;
          if (texto.includes('não') || texto.includes('nao')) dados.ambasMarcam.nao = odd;
        });
      }

      if (titulo.includes('primeiro gol')) {
        botoes.forEach((btn, i) => {
          const texto = btn.textContent.trim().toLowerCase();
          const odd = getOddDeTexto(texto);
          if (!odd) return;
          if (texto.includes('nenhum') || texto.includes('sem gol')) dados.primeiroGol.nenhum = odd;
          else if (i === 0) dados.primeiroGol.casa = odd;
          else dados.primeiroGol.fora = odd;
        });
      }

      if (titulo.includes('chance dupla')) {
        botoes.forEach((btn, i) => {
          const odd = getOddDeTexto(btn.textContent);
          if (!odd) return;
          if (i === 0) dados.chanceDupla.casaEmpate = odd;
          else if (i === 1) dados.chanceDupla.casaFora = odd;
          else dados.chanceDupla.empataFora = odd;
        });
      }

      if (titulo.includes('qualificar') || titulo.includes('classificar') || titulo.includes('passar')) {
        botoes.forEach((btn, i) => {
          const odd = getOddDeTexto(btn.textContent);
          if (!odd) return;
          if (i === 0) dados.qualificar.casa = odd;
          else dados.qualificar.fora = odd;
        });
      }

      if (titulo.includes('escanteio')) {
        botoes.forEach(btn => {
          const texto = btn.textContent.trim().toLowerCase();
          const odd = getOddDeTexto(texto);
          if (!odd) return;
          if (texto.includes('mais')) dados.escanteios.mais = odd;
          if (texto.includes('menos')) dados.escanteios.menos = odd;
          const linhaMatch = texto.match(/(\d+[.,]\d)/);
          if (linhaMatch) dados.escanteios.linha = parseFloat(linhaMatch[1].replace(',', '.'));
        });
      }

      if (titulo.includes('handicap')) {
        botoes.forEach(btn => {
          const texto = btn.textContent.trim();
          const odd = getOddDeTexto(texto);
          const linhaMatch = texto.match(/([+-]?\d+[.,]?\d*)/);
          if (odd && linhaMatch) {
            dados.handicap.push({ linha: linhaMatch[1], odd });
          }
        });
      }

      if (titulo.includes('resultado correto') || titulo.includes('placar')) {
        botoes.forEach(btn => {
          const texto = btn.textContent.trim();
          const odd = getOddDeTexto(texto);
          const placarMatch = texto.match(/(\d+)[:\-x](\d+)/i);
          if (odd && placarMatch) {
            const g1 = parseInt(placarMatch[1]);
            const g2 = parseInt(placarMatch[2]);
            dados.placares.push({
              placar: `${g1}-${g2}`,
              odd,
              time: g1 > g2 ? 'casa' : g1 < g2 ? 'fora' : 'empate',
            });
          }
        });
      }
    });

    return dados;
  });

  return resultado;
}

// Extrai informações do header do evento (times, data, hora)
async function extrairInfoEvento(page, url) {
  const info = await page.evaluate((baseUrl) => {
    const getText = sel => document.querySelector(sel)?.textContent?.trim() || '';

    // Tentar extrair nomes dos times
    const participantes = Array.from(
      document.querySelectorAll('[class*="participant-name"], [class*="team-name"], [class*="competitor"]')
    ).map(el => el.textContent.trim()).filter(t => t.length > 1 && t.length < 50);

    // Data e hora
    const dataHora = getText('[class*="date"], [class*="time"], [class*="event-date"]');

    return { participantes, dataHora };
  }, BASE_URL);

  // Gerar ID a partir da URL
  const urlParts = url.split('/');
  const eventId = urlParts[urlParts.length - 1]; // ev-XXXXXXX
  const nomeEvento = urlParts.slice(-2, -1)[0]; // brasil-vs-japao

  const [nomeCasa, nomeFora] = nomeEvento
    ? nomeEvento.split('-vs-').map(n => n.charAt(0).toUpperCase() + n.slice(1))
    : (info.participantes.length >= 2 ? [info.participantes[0], info.participantes[1]] : ['Casa', 'Fora']);

  return {
    id: nomeEvento || eventId,
    eventId,
    nomeCasa,
    nomeFora,
    dataHora: info.dataHora,
  };
}

// Função principal: scrape completo de um evento
async function scrapeEvento(browser, url) {
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1366, height: 768 });

    // Bloquear recursos desnecessários para economizar tempo
    await page.setRequestInterception(true);
    page.on('request', req => {
      const tipo = req.resourceType();
      if (['image', 'font', 'media'].includes(tipo)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const info = await extrairInfoEvento(page, url);
    const odds = await coletarOddsEsportivaBet(page, url);

    return {
      url,
      info,
      odds,
      coletadoEm: new Date().toISOString(),
    };
  } catch (err) {
    logger.error(`Erro ao scrape ${url}: ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

// Função principal exportada: roda o scrape completo
async function executarScrape(urlsEventos) {
  const browser = await criarBrowser();
  const resultados = [];

  try {
    for (const url of urlsEventos) {
      const resultado = await scrapeEvento(browser, url);
      if (resultado) resultados.push(resultado);
      // Pausa entre requests para não sobrecarregar o servidor
      await new Promise(r => setTimeout(r, 1500));
    }
  } finally {
    await browser.close();
  }

  return resultados;
}

// Scrape da lista de jogos disponíveis na Copa
async function scrapeListaJogos() {
  const browser = await criarBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    const eventos = await coletarListaJogos(page);
    return eventos;
  } finally {
    await page.close();
    await browser.close();
  }
}

module.exports = { executarScrape, scrapeListaJogos, scrapeEvento };
