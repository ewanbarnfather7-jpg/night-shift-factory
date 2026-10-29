'use strict';
// Trade lifecycle: capture -> allocation -> settlement instruction.
// Every function returns [httpStatus, body].

const config = require('../config');
const { settlementDate } = require('./settlement');
const { isValidIsoDate } = require('./validate');

const trades = new Map();
let sequence = 0;

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const RECEIVED_AT = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/; // London local time

function captureTrade(body) {
  if (!body || typeof body !== 'object') return [400, { error: 'VALIDATION_FAILED', fields: ['body'] }];
  const fields = [];
  if (!ISIN.test(body.isin || '')) fields.push('isin');
  if (!['BUY', 'SELL'].includes(body.side)) fields.push('side');
  if (!Number.isInteger(body.quantity) || body.quantity <= 0) fields.push('quantity');
  if (typeof body.price !== 'number' || !(body.price > 0)) fields.push('price');
  if (!isValidIsoDate(body.tradeDate)) fields.push('tradeDate');
  if (fields.length) return [400, { error: 'VALIDATION_FAILED', fields }];

  sequence += 1;
  const id = `TRD-${String(sequence).padStart(6, '0')}`;
  const derived = settlementDate(body.tradeDate);
  const trade = {
    id,
    isin: body.isin,
    side: body.side,
    quantity: body.quantity,
    price: body.price,
    tradeDate: body.tradeDate,
    settlementDate: derived.settlementDate,
    convention: derived.convention,
    status: 'CAPTURED',
    allocations: [],
    instructions: [],
  };
  trades.set(id, trade);
  return [201, trade];
}

function getTrade(id) {
  const trade = trades.get(id);
  return trade ? [200, trade] : [404, { error: 'TRADE_NOT_FOUND', tradeId: id }];
}

function isLate(trade, receivedAt) {
  const [, , time] = receivedAt.match(RECEIVED_AT);
  return time > config.deadlines.allocationCutoff;
}

function allocate(id, body) {
  const trade = trades.get(id);
  if (!trade) return [404, { error: 'TRADE_NOT_FOUND', tradeId: id }];
  const fields = [];
  if (!body.fund) fields.push('fund');
  if (!Number.isInteger(body.quantity) || body.quantity <= 0) fields.push('quantity');
  if (!body.ssiId) fields.push('ssiId');
  if (!RECEIVED_AT.test(body.receivedAt || '')) fields.push('receivedAt');
  if (fields.length) return [400, { error: 'VALIDATION_FAILED', fields }];

  if (isLate(trade, body.receivedAt)) {
    return [422, {
      error: 'LATE_ALLOCATION',
      status: 'EXCEPTION',
      tradeId: trade.id,
      fund: body.fund,
      deadline: `${trade.tradeDate}T${config.deadlines.allocationCutoff}`,
      escalated: true,
    }];
  }

  const allocated = trade.allocations.reduce((sum, a) => sum + a.quantity, 0);
  if (allocated + body.quantity > trade.quantity) {
    return [422, { error: 'OVER_ALLOCATION', tradeId: trade.id, remaining: trade.quantity - allocated }];
  }

  const allocation = {
    id: `${trade.id}-A${trade.allocations.length + 1}`,
    fund: body.fund,
    quantity: body.quantity,
    ssiId: body.ssiId,
    receivedAt: body.receivedAt,
    status: 'ALLOCATED',
  };
  trade.allocations.push(allocation);
  trade.status = allocated + body.quantity === trade.quantity ? 'ALLOCATED' : 'PARTIALLY_ALLOCATED';
  return [201, allocation];
}

function instruct(id) {
  const trade = trades.get(id);
  if (!trade) return [404, { error: 'TRADE_NOT_FOUND', tradeId: id }];
  if (!trade.allocations.length) return [422, { error: 'NOT_ALLOCATED', tradeId: trade.id }];
  const active = trade.instructions.find((i) => i.status !== 'CANCELLED');
  if (active) return [409, { error: 'DUPLICATE_INSTRUCTION', tradeId: trade.id, existing: active.id }];

  const instruction = {
    id: `${trade.id}-I${trade.instructions.length + 1}`,
    tradeId: trade.id,
    settlementDate: trade.settlementDate,
    matchingDeadline: `${trade.settlementDate}T${config.deadlines.matchingCutoff}`,
    status: 'INSTRUCTED',
  };
  trade.instructions.push(instruction);
  trade.status = 'INSTRUCTED';
  return [201, instruction];
}

module.exports = { captureTrade, getTrade, allocate, instruct };
