require('dotenv').config();
const express = require('express');
const cors = require('cors');
const logger = require('./utils/logger');
const routes = require('./api/routes');
const contaRoutes = require('./api/contaRoutes');
const { iniciarAgendador } = require('./scraper/agendador');
const { conectar } = require('./db/mongo');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middlewares ───────────────────────────────────────────────────
app.use(express.json());

// CORS: permite o frontend acessar a API
const origens = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5173',
  'https://radarodd.netlify.app',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Permite requests sem origin (Postman, curl, etc.)
    if (!origin) return callback(null, true);
    // Permite todos os subdomínios netlify.app e localhost
    if (
      origin.endsWith('.netlify.app') ||
      origin.startsWith('http://localhost') ||
      origens.some(o => o && origin.startsWith(o))
    ) {
      return callback(null, true);
    }
    callback(new Error(`CORS bloqueado para: ${origin}`));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-admin-token'],
}));

// Log de requisições
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// ─── Rotas ────────────────────────────────────────────────────────
app.use('/api', contaRoutes);
app.use('/api', routes);

// Rota raiz
app.get('/', (req, res) => {
  res.json({
    nome: 'RadarOdd API',
    versao: '1.0.0',
    endpoints: [
      'GET  /api/status',
      'GET  /api/jogos',
      'GET  /api/jogos/:id',
      'GET  /api/value-bets',
      'POST /api/scrape',
    ],
    documentacao: 'https://github.com/seu-usuario/radarodd-api',
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ ok: false, mensagem: 'Rota não encontrada' });
});

// Erro global
app.use((err, req, res, next) => {
  logger.error(`Erro não tratado: ${err.message}`);
  res.status(500).json({ ok: false, mensagem: 'Erro interno do servidor' });
});

// ─── Inicialização ────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.ok(`RadarOdd API rodando em http://localhost:${PORT}`);
  logger.info(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`Frontend autorizado: ${origens.join(', ')}`);

  // Iniciar agendador do scraper
  conectar().then(() => iniciarAgendador());
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.warn('SIGTERM recebido, encerrando servidor...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.warn('Encerrando servidor...');
  process.exit(0);
});

module.exports = app;
