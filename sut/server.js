'use strict';
// Mock UK T+1 settlement service. Zero dependencies: node server.js --port 4100

const http = require('http');
const config = require('./config');
const calendar = require('./lib/calendar');
const lifecycle = require('./lib/lifecycle');
const { settlementDate } = require('./lib/settlement');
const { isValidIsoDate } = require('./lib/validate');

const VERSION = '0.9.0';

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const routes = [
  ['GET', /^\/health$/, async () => [200, { status: 'ok', version: VERSION }]],
  ['GET', /^\/settlement-date$/, async (req, match, url) => {
    const tradeDate = url.searchParams.get('tradeDate');
    if (!isValidIsoDate(tradeDate)) return [400, { error: 'INVALID_TRADE_DATE', field: 'tradeDate' }];
    return [200, settlementDate(tradeDate)];
  }],
  ['GET', /^\/calendar\/(\d{4})$/, async (req, match) => {
    const year = Number(match[1]);
    return [200, { year, holidays: calendar.holidaysFor(year) }];
  }],
  ['POST', /^\/trades$/, async (req) => lifecycle.captureTrade(await readBody(req))],
  ['GET', /^\/trades\/([A-Z0-9-]+)$/, async (req, match) => lifecycle.getTrade(match[1])],
  ['POST', /^\/trades\/([A-Z0-9-]+)\/allocations$/, async (req, match) => lifecycle.allocate(match[1], await readBody(req))],
  ['POST', /^\/trades\/([A-Z0-9-]+)\/instructions$/, async (req, match) => lifecycle.instruct(match[1], await readBody(req))],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    for (const [method, pattern, handler] of routes) {
      const match = url.pathname.match(pattern);
      if (match && req.method === method) {
        const [status, body] = await handler(req, match, url);
        return send(res, status, body);
      }
    }
    return send(res, 404, { error: 'NOT_FOUND' });
  } catch (err) {
    return send(res, 500, { error: err.message, stack: err.stack });
  }
});

const portFlag = process.argv.indexOf('--port');
const port = portFlag > -1 ? Number(process.argv[portFlag + 1]) : config.port;
server.listen(port, '127.0.0.1', () => {
  console.log(`T+1 settlement service ${VERSION} listening on http://127.0.0.1:${port}`);
});
