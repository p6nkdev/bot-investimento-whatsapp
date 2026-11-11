# BOT-Moedas

Bot de WhatsApp que monitora preços de criptomoedas e ações da B3, envia alertas para um grupo quando o preço varia além de um limite e responde a comandos. Vem com um painel web com login para cadastrar os ativos, gerenciar usuários, conectar o WhatsApp por QR Code e escolher a conversa que recebe os alertas. Os dados ficam em MySQL.

## Visão geral

```
index.js
 ├─ db            (src/db/mysql.js)             → pool MySQL + criação das tabelas
 ├─ coinsStore    (src/db/coinsStore.js)        → leitura/gravação de ativos, histórico e chatId
 ├─ usersStore    (src/db/usersStore.js)        → usuários do painel (senha com scrypt) e sessões
 ├─ priceMonitor  (src/monitor/priceMonitor.js) → cron a cada 1 min, envia alertas
 ├─ panelServer   (src/server/panelServer.js)   → painel web + API REST com login por sessão (porta 4738)
 └─ whatsapp      (src/bot/whatsapp.js)         → conexão Baileys, QR Code, grupos + comandos (src/bot/commands.js)

src/services/prices.js → busca preços (Binance para cripto, Investidor10 para ações)
src/utils/format.js    → formatação de valores em R$
public/                → front-end do painel (HTML/CSS/JS puro)
test/                  → testes (node --test)
```

Fluxo:
1. Ao iniciar, conecta no MySQL e cria as tabelas se não existirem. Se o banco não responder, o processo encerra com erro.
2. Se não houver nenhum usuário no banco, cria o primeiro com `PANEL_USER`/`PANEL_PASSWORD`. Sem essas variáveis e sem usuários, o processo encerra com erro.
3. Se `PANEL_ONLY` não for `true`, o bot conecta no WhatsApp. Sem sessão salva, o QR Code aparece no painel (e no terminal) para parear.
4. O painel sobe na porta `PORT` (padrão `4738`).
5. Quando a conexão abre, o monitor roda um ciclo imediato e depois checa todos os ativos ativos a cada minuto.

O banco começa vazio: entre com o usuário inicial, conecte o WhatsApp, escolha a conversa e cadastre os ativos pelo painel.

## Como rodar

Copie `.env.example` para `.env` e preencha as senhas.

### Docker (recomendado)

```bash
docker compose up -d --build
docker logs -f bot-moedas   # acompanhar os logs
```

Sobe dois containers: `bot-moedas-mysql` (MySQL 8.4, dados no volume `mysql-data`) e `bot-moedas`, que só inicia quando o MySQL está saudável. A pasta `./botData` guarda a sessão do WhatsApp (continua em arquivos, é o formato do Baileys).

Painel: http://localhost:4738 (entre com `PANEL_USER`/`PANEL_PASSWORD` na primeira vez).

### Local

Requer Node 22.9+ e um MySQL acessível (ajuste `DB_HOST`/`DB_PORT` no `.env`).

```bash
npm install
npm start      # lê o .env automaticamente
```

### Variáveis de ambiente

| Variável           | Padrão      | Descrição |
|--------------------|-------------|-----------|
| `PANEL_USER`       | —           | Primeiro usuário do painel. Só é usado enquanto o banco não tem usuários |
| `PANEL_PASSWORD`   | —           | Senha desse primeiro usuário (mínimo 8 caracteres; a senha de exemplo do `.env.example` é recusada) |
| `PORT`             | `4738`      | Porta do painel web |
| `PANEL_ONLY`       | —           | `true` sobe só o painel, sem conectar no WhatsApp |
| `DB_HOST`          | `localhost` | Host do MySQL (no Docker é forçado para `mysql`) |
| `DB_PORT`          | `3306`      | Porta do MySQL |
| `DB_NAME`          | `botmoedas` | Nome do banco |
| `DB_USER`          | `botmoedas` | Usuário do banco |
| `DB_PASSWORD`      | —           | Senha do banco |
| `DB_ROOT_PASSWORD` | —           | Senha root do container MySQL (só no Docker) |

## Banco de dados

As tabelas são criadas automaticamente na inicialização.

| Tabela         | Conteúdo |
|----------------|----------|
| `settings`     | Pares `name`/`value`. Hoje só `chatId` |
| `users`        | Usuários do painel. Senha guardada como hash `scrypt` com salt |
| `sessions`     | Sessões abertas (só o hash SHA-256 do token), expiram em 7 dias; apagadas junto com o usuário |
| `coins`        | Um registro por ativo (`symbol` é a chave) |
| `coin_history` | Preços lidos com data/hora. Mantém os 20 últimos distintos por ativo; apagado junto com o ativo |

Campos de um ativo (como aparecem na API):

| Campo       | Coluna       | Descrição |
|-------------|--------------|-----------|
| `type`      | `type`       | `crypto` (Binance) ou `acao` (Investidor10) |
| `symbol`    | `symbol`     | Ticker. É normalizado para maiúsculas, só `A-Z0-9` |
| `name`      | `name`       | Nome exibido nas mensagens |
| `quote`     | `quote`      | Moeda de cotação. Para cripto forma o par na Binance (`BTC` + `BRL` = `BTCBRL`) |
| `alertUp`   | `alert_up`   | Alta mínima (em valor absoluto, não %) para disparar alerta. `0` desliga |
| `alertDown` | `alert_down` | Queda mínima para disparar alerta. `0` desliga |
| `enabled`   | `enabled`    | `false` pausa o monitoramento do ativo |
| `lastValue` | `ref_value`  | Preço de referência para o próximo alerta (gerenciado pelo bot) |
| `history`   | `coin_history` | Últimos 20 preços distintos lidos (gerenciado pelo bot) |

## Como funcionam os alertas

A cada minuto (se o ciclo anterior ainda estiver rodando, o novo é pulado):

1. Busca em paralelo o preço atual de todos os ativos com `enabled`.
2. Se mudou em relação ao último do histórico, grava em `coin_history` (mantém 20).
3. Calcula `diferença = atual - lastValue`.
4. Se `|diferença| >= alertUp` (subida) ou `>= alertDown` (queda), envia mensagem ao `chatId` e, **só se o envio der certo**, atualiza `lastValue` para o preço atual. Falhou o envio, tenta de novo no próximo ciclo.

Erro em um ativo (API, banco ou envio) é registrado no log e não interrompe os demais. Sem `chatId` configurado, o alerta é ignorado com aviso no log.

`lastValue` só muda quando um alerta é enviado. A variação é **acumulada** desde o último alerta, não minuto a minuto. Exemplo com `alertUp: 5000`: BTC em 330.000 → alerta só quando chegar a 335.000, mesmo que leve horas.

Mensagem enviada:
```
Bitcoin (BTC/BRL) subiu R$ 5.120,00.
> Valor atual: R$ 335.120,00
```

## WhatsApp pelo painel

- **Conectar:** sem sessão salva, o painel mostra o QR Code (atualiza sozinho). No celular: Configurações → Aparelhos conectados → Conectar aparelho.
- **Desconectar:** encerra a sessão no WhatsApp e apaga os arquivos de `botData/`. Para voltar, clique em Conectar WhatsApp e escaneie de novo.
- **Conversa dos alertas:** com o WhatsApp conectado, escolha um dos grupos do número na lista. A opção "Outra conversa" aceita qualquer ID (ex.: conversa privada `5511...@s.whatsapp.net`).

## Comandos do WhatsApp

Funcionam em qualquer conversa em que o bot receba a mensagem.

| Comando              | Descrição |
|----------------------|-----------|
| `!preco <ATIVO>`     | Preço atual (também aceita `!preço`). Sem ativo, usa BTC |
| `!historico <ATIVO>` | Últimos 20 valores registrados (só ativos cadastrados) |
| `!moedas`            | Lista os ativos cadastrados e se estão ativos ou pausados |
| `!btc`               | Atalho para `!preco BTC` |
| `!help`              | Lista os comandos |

Ativos não cadastrados em `!preco` são tratados como cripto (Binance).

## API do painel

Fora `POST /api/login` e a própria tela de login, tudo exige o cookie de sessão `sid` (`HttpOnly`, `SameSite=Strict`, e `Secure` quando a requisição chega com `X-Forwarded-Proto: https`). Sem sessão, a API responde `401` e as páginas redirecionam para `/login.html`. `POST` e `PUT` exigem `Content-Type: application/json` (bloqueia CSRF por formulário de outro site). Respostas em JSON; erros retornam `{ "error": "mensagem" }`.

| Método   | Rota                   | Corpo | Retorno |
|----------|------------------------|-------|---------|
| `GET`    | `/api/config`          | —     | `{ chatId, coins }` |
| `PUT`    | `/api/config`          | `{ "chatId": "..." }` | Configuração atualizada |
| `POST`   | `/api/coins`           | Objeto do ativo | Ativo criado/atualizado (201) |
| `PUT`    | `/api/coins/:symbol`   | Campos a alterar | Ativo atualizado (404 se não existir) |
| `DELETE` | `/api/coins/:symbol`   | —     | Configuração atualizada |
| `GET`    | `/api/prices`          | —     | `[{ symbol, quote, price }]` com preço ao vivo de cada ativo |
| `POST`   | `/api/login`           | `{ "username", "password" }` | Cria a sessão (cookie). `401` se errar; 10 erros seguidos bloqueiam o usuário por 15 min |
| `POST`   | `/api/logout`          | —     | Encerra a sessão |
| `GET`    | `/api/me`              | —     | `{ id, username }` do usuário logado |
| `GET`    | `/api/users`           | —     | Lista de usuários |
| `POST`   | `/api/users`           | `{ "username", "password" }` | Usuário criado (201). Usuário: 3–32 de `a-z0-9._-`; senha: 8+ caracteres |
| `DELETE` | `/api/users/:id`       | —     | Exclui. Não permite excluir a si mesmo nem o último usuário |
| `GET`    | `/api/whatsapp`        | —     | `{ status, qrSvg, account }`. `status`: `connecting`, `qr`, `connected`, `disconnected` ou `disabled` |
| `POST`   | `/api/whatsapp/connect`| —     | Inicia a conexão quando está `disconnected` |
| `POST`   | `/api/whatsapp/logout` | —     | Desconecta o número e apaga a sessão salva em `botData/` |
| `GET`    | `/api/whatsapp/groups` | —     | `[{ id, name, size }]` dos grupos do número conectado |

`POST` e `PUT` em um ativo existente preservam `history` e `lastValue`.

Exemplo:
```bash
curl -c cookies.txt -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"SENHA"}' http://localhost:4738/api/login
curl -b cookies.txt -X POST http://localhost:4738/api/coins \
  -H "Content-Type: application/json" \
  -d '{"type":"acao","symbol":"PETR4","name":"Petrobras","alertUp":2,"alertDown":2}'
```

## Fontes de preço

| Tipo     | Fonte | Endpoint |
|----------|-------|----------|
| `crypto` | Binance | `https://api.binance.com/api/v3/ticker/price?symbol=<SYMBOL><QUOTE>` |
| `acao`   | Investidor10 | `https://investidor10.com.br/api/quotations/one-day/<SYMBOL>/` (último ponto da série `real`) |

Timeout de 10 s. Em erro, o preço vem `null` e o ativo é ignorado naquele ciclo.

## Testes

```bash
npm test
```

O teste do banco (`test/coinsStore.test.js`) só roda com `DB_PASSWORD` definido e usa o MySQL configurado nas variáveis `DB_*`. Ele cria e apaga um ativo `TSTX`. Exemplo com um MySQL descartável:

```bash
docker run -d --rm --name bm-test-mysql -e MYSQL_DATABASE=botmoedas -e MYSQL_USER=botmoedas \
  -e MYSQL_PASSWORD=testpw -e MYSQL_ROOT_PASSWORD=rootpw -p 127.0.0.1:33306:3306 mysql:8.4
DB_HOST=127.0.0.1 DB_PORT=33306 DB_PASSWORD=testpw npm test
```

## Pontos de atenção

- Exponha o painel só via HTTPS (atrás de um proxy reverso com TLS); em HTTP puro a senha e o cookie trafegam abertos.
- Todo usuário logado tem o mesmo poder: gerencia ativos, WhatsApp e outros usuários.
- O bloqueio após 10 senhas erradas é por usuário e fica em memória: some ao reiniciar, e alguém que saiba um nome de usuário pode bloqueá-lo por 15 minutos.
- Não há tela para trocar a senha: crie um usuário novo e exclua o antigo.
- A sessão do WhatsApp continua em arquivos em `botData/`. Faça backup dessa pasta e do volume `mysql-data`.
