# RadarOdd API 📡

Backend do RadarOdd — scraper automático de odds + API REST.

## Como funciona

```
EsportivaBet (site)
    ↓  Puppeteer coleta odds a cada 5 min
Cache em memória (Node.js)
    ↓  Express serve os dados
API REST  →  RadarOdd Frontend
```

## Instalação local

```bash
# 1. Instalar dependências
npm install

# 2. Configurar variáveis de ambiente
cp .env.example .env
# Edite o .env conforme necessário

# 3. Rodar em desenvolvimento
npm run dev

# 4. Rodar em produção
npm start
```

## Variáveis de ambiente (.env)

```env
PORT=3001
NODE_ENV=development
SCRAPER_BASE_URL=https://esportiva.bet.br
SCRAPER_INTERVAL_MINUTES=5
PUPPETEER_HEADLESS=true
FRONTEND_URL=https://thunderous-dragon-2ddb1d.netlify.app
ADMIN_TOKEN=seu-token-secreto-aqui
```

## Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/status` | Status do scraper e última atualização |
| GET | `/api/jogos` | Lista todos os jogos com odds |
| GET | `/api/jogos/:id` | Odds completas de um jogo |
| GET | `/api/value-bets` | Todos os value bets ordenados por EV |
| POST | `/api/scrape` | Força atualização manual |

### Exemplos

```bash
# Ver status
curl http://localhost:3001/api/status

# Listar jogos
curl http://localhost:3001/api/jogos

# Jogo específico
curl http://localhost:3001/api/jogos/brasil-vs-japao

# Value bets com EV mínimo de 5%
curl "http://localhost:3001/api/value-bets?minEV=5"

# Forçar scrape manual
curl -X POST http://localhost:3001/api/scrape \
  -H "x-admin-token: seu-token-secreto-aqui"
```

## Deploy no Railway (recomendado — grátis)

1. Crie conta em [railway.app](https://railway.app)
2. Clique em **New Project → Deploy from GitHub**
3. Suba este repositório no GitHub
4. O Railway detecta o `Dockerfile` automaticamente
5. Configure as variáveis de ambiente no painel
6. Copie a URL gerada (ex: `https://radarodd-api.up.railway.app`)

## Conectar ao frontend

No arquivo `src/data/mockData.js` do frontend, substitua os dados estáticos
por uma chamada à API:

```js
// Antes (dados estáticos)
export const JOGOS = [ ... ]

// Depois (dados reais da API)
const API_URL = 'https://radarodd-api.up.railway.app'

export async function fetchJogos() {
  const res = await fetch(`${API_URL}/api/jogos`)
  const data = await res.json()
  return data.jogos
}
```

## Estrutura do projeto

```
radarodd-api/
├── src/
│   ├── server.js          # Servidor Express
│   ├── api/
│   │   └── routes.js      # Endpoints REST
│   ├── scraper/
│   │   ├── esportivabet.js # Scraper Puppeteer
│   │   └── agendador.js   # Cron job automático
│   └── utils/
│       ├── cache.js        # Cache em memória
│       ├── logger.js       # Logs coloridos
│       └── parser.js       # Parser + cálculo de EV
├── Dockerfile
├── .env.example
└── package.json
```
