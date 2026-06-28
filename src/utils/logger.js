const cores = {
  reset: '\x1b[0m',
  verde: '\x1b[32m',
  amarelo: '\x1b[33m',
  vermelho: '\x1b[31m',
  azul: '\x1b[34m',
  cinza: '\x1b[90m',
};

function timestamp() {
  return new Date().toLocaleTimeString('pt-BR');
}

const logger = {
  info: (msg, ...args) =>
    console.log(`${cores.azul}[${timestamp()}] ℹ ${cores.reset}${msg}`, ...args),

  ok: (msg, ...args) =>
    console.log(`${cores.verde}[${timestamp()}] ✓ ${cores.reset}${msg}`, ...args),

  warn: (msg, ...args) =>
    console.log(`${cores.amarelo}[${timestamp()}] ⚠ ${cores.reset}${msg}`, ...args),

  error: (msg, ...args) =>
    console.error(`${cores.vermelho}[${timestamp()}] ✗ ${cores.reset}${msg}`, ...args),

  scraper: (msg, ...args) =>
    console.log(`${cores.cinza}[${timestamp()}] 🔍 ${msg}${cores.reset}`, ...args),
};

module.exports = logger;
