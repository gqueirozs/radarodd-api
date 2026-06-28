/**
 * Cache em memória simples com TTL
 * Evita bater no site a cada requisição
 */
class Cache {
  constructor() {
    this.store = new Map();
    this.metadata = {
      ultimaAtualizacao: null,
      totalJogos: 0,
      status: 'idle', // idle | scraping | ok | error
      erro: null,
      historico: [], // últimas 10 atualizações
    };
  }

  set(key, value, ttlMs = 5 * 60 * 1000) {
    this.store.set(key, {
      value,
      expira: Date.now() + ttlMs,
    });
  }

  get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    if (Date.now() > item.expira) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  }

  has(key) {
    return this.get(key) !== null;
  }

  delete(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }

  setStatus(status, erro = null) {
    this.metadata.status = status;
    this.metadata.erro = erro;

    if (status === 'ok') {
      this.metadata.ultimaAtualizacao = new Date().toISOString();
      this.metadata.historico.unshift({
        timestamp: this.metadata.ultimaAtualizacao,
        totalJogos: this.metadata.totalJogos,
        status: 'ok',
      });
      if (this.metadata.historico.length > 10) {
        this.metadata.historico.pop();
      }
    }

    if (status === 'error') {
      this.metadata.historico.unshift({
        timestamp: new Date().toISOString(),
        status: 'error',
        erro,
      });
      if (this.metadata.historico.length > 10) {
        this.metadata.historico.pop();
      }
    }
  }

  setTotalJogos(n) {
    this.metadata.totalJogos = n;
  }

  getMetadata() {
    return { ...this.metadata };
  }
}

module.exports = new Cache();
