# Dormant outbound Worker compatibility

Draft claim for four existing dormant readers: `follow-archive-reader.js`, `topup-payment-evidence.js`, `topup-reversal-evidence.js`, and `topup-stripe.js`. Replace unsupported native Worker redirect mode with manual rejection, preserve existing bounded reads and credential/origin rules, update exact synthetic mocks and add native local regression evidence.

No employer/social handler, retention schema/writers, route, provider operation, workflow or live binding changes. No activation, deployment, actual email or payment.
