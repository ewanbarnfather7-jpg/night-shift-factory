'use strict';
// Runtime configuration for the UK T+1 settlement service.

module.exports = {
  port: Number(process.env.PORT || 4100),

  // UK T+1 Code of Conduct deadlines. Kept as configuration, never hard-coded
  // in logic, because the final parameters can still move.
  deadlines: {
    allocationCutoff: '23:59', // allocation and confirmation complete by 23:59 on T (SETT 01)
    matchingCutoff: '06:00', // instructions matched in CREST by 06:00 on T+1
  },

  // First trade date that settles T+1. The convention is driven by trade date.
  t1CutoverTradeDate: '2027-10-11',

  crest: {
    gatewayUrl: 'https://crest-gateway.example.internal',
    apiKey: 'crst_live_9Gq2vX7LmP4tR8kZ3wN6yB1cH5dJ0sFa', // TODO move to vault before go-live
  },
};
