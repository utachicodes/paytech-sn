# paytech-sn

[![CI](https://github.com/utachicodes/paytech-sn/actions/workflows/ci.yml/badge.svg)](https://github.com/utachicodes/paytech-sn/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/paytech-sn.svg)](https://www.npmjs.com/package/paytech-sn)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.json)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](package.json)

A typed Node.js and TypeScript client for the [PayTech](https://paytech.sn) payment gateway used across Senegal, Cote d'Ivoire, Mali, and Benin. It covers checkout requests, IPN signature verification, transfers, refunds, and SMS, with zero runtime dependencies.

Built around the official PayTech API: https://docs.intech.sn/doc_paytech.php

The SDK itself is framework-agnostic: it is plain TypeScript built on the native `fetch` and `node:crypto` APIs, with no dependency on Next.js or any other framework. It works the same way in a Next.js Route Handler, an Express, Fastify, or NestJS server, a serverless function, or a bare Node.js script. The Next.js example below is one usage pattern, not a requirement.

## Features

- Framework-agnostic: works in Next.js, Express, Fastify, NestJS, or a plain Node.js script
- Checkout requests with optional autofill for a single payment method
- IPN verification for both payment and transfer events, each with its correct HMAC formula
- Constant-time signature comparison to avoid timing attacks
- Strict input validation that fails fast on bad parameters instead of a confusing API error
- Per-request timeout with `AbortController`
- Fully typed requests and responses, published as dual ESM and CommonJS with bundled `.d.ts` files

## Installation

```bash
npm install paytech-sn
```

Requires Node.js 20 or later (the test toolchain requires it; the SDK runtime itself only needs the global `fetch` and `crypto` APIs available since Node 18).

## Quick start

```ts
import { PaytechService } from "paytech-sn";

const paytech = new PaytechService({
  apiKey: process.env.PAYTECH_API_KEY!,
  apiSecret: process.env.PAYTECH_API_SECRET!,
  env: "test", // defaults to "test"; set to "prod" explicitly when you are ready
});

const payment = await paytech.requestPayment({
  itemName: "Premium plan",
  itemPrice: 5000,
  refCommand: "ORDER-1234",
  commandName: "Subscription renewal",
  ipnUrl: "https://example.com/api/payments/ipn",
  successUrl: "https://example.com/payment/success",
  cancelUrl: "https://example.com/payment/cancel",
});

if (payment.success) {
  // redirect the payer to payment.redirectUrl
}
```

A process-wide instance built from `PAYTECH_API_KEY`, `PAYTECH_API_SECRET`, and `PAYTECH_ENV` is also available, which is convenient in serverless route handlers:

```ts
import { getPaytechService } from "paytech-sn";

const paytech = getPaytechService();
```

## Verifying IPN notifications

PayTech posts a webhook for payment, refund, and transfer events. `verifyIpn` checks the signature and returns a typed, discriminated result.

```ts
import { getPaytechService, type IpnPayload } from "paytech-sn";

const paytech = getPaytechService();
const result = paytech.verifyIpn(payload as IpnPayload);

if (!result.valid) {
  // reject the request, do not trust the payload
}

if (result.kind === "payment" && result.typeEvent === "sale_complete") {
  // mark the order identified by result.refCommand as paid
}

if (result.kind === "transfer" && result.typeEvent === "transfer_success") {
  // reconcile the payout identified by result.idTransfer
}
```

A full Next.js App Router route handler is in [examples/nextjs-ipn-route.ts](examples/nextjs-ipn-route.ts). It requires the Node.js runtime, since signature verification uses `node:crypto`.

The same logic works in any Node.js HTTP framework, for example Express:

```ts
import express from "express";
import { getPaytechService } from "paytech-sn";

const app = express();
app.use(express.json());

app.post("/ipn", (req, res) => {
  const result = getPaytechService().verifyIpn(req.body);

  if (!result.valid) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  res.status(200).json({ received: true, kind: result.kind });
});
```

### Tracking partial / installment payments

PayTech has no native installment plan: every `requestPayment` call is one complete checkout. To track a balance paid across several transactions (e.g. a tuition invoice paid 5000 now, 1000 later), keep an `Invoice`/`Payment` ledger in your own database, give each installment its own unique `refCommand`, and update `amountPaid` from `verifyIpn` idempotently per `refCommand`. See [examples/tuition-installments.ts](examples/tuition-installments.ts) for the full pattern.

### Why two HMAC formulas

PayTech signs payment and transfer events differently:

| Event kind                                          | HMAC message                             |
| --------------------------------------------------- | ---------------------------------------- |
| `sale_complete`, `sale_canceled`, `refund_complete` | `final_item_price\|ref_command\|api_key` |
| `transfer_success`, `transfer_failed`               | `amount\|id_transfer\|api_key`           |

`verifyIpn` picks the correct formula from `type_event` automatically.

## Checkout autofill

Pass a single `targetPayment` value plus an `autofill` argument to skip the payment method picker:

```ts
const payment = await paytech.requestPayment(
  {
    itemName: "Premium plan",
    itemPrice: 5000,
    refCommand: "ORDER-1234",
    commandName: "Subscription renewal",
    ipnUrl: "https://example.com/api/payments/ipn",
    successUrl: "https://example.com/payment/success",
    cancelUrl: "https://example.com/payment/cancel",
    targetPayment: "Orange Money",
  },
  { phoneWithCode: "+221777777777", fullName: "Jane Doe" },
);
```

Autofill is skipped when `targetPayment` lists more than one method, since the payer still has to choose.

## API reference

| Method                                | Description                                  |
| ------------------------------------- | -------------------------------------------- |
| `requestPayment(params, autofill?)`   | Create a checkout session                    |
| `verifyIpn(payload)`                  | Verify a webhook notification                |
| `getPaymentStatus(tokenPayment)`      | Look up a payment by token                   |
| `transferFund(params)`                | Send money to a mobile money or bank account |
| `getTransferStatus(idTransfer)`       | Look up a transfer by id                     |
| `getTransferHistory(filters?)`        | List transfers                               |
| `getAccountInfo()`                    | Read the account balance and fees            |
| `refundPayment(refCommand)`           | Refund a completed order                     |
| `sendSms(destinationNumber, content)` | Send a transactional SMS                     |

See [src/types.ts](src/types.ts) for the full request and response shapes.

## Supported payment methods

Orange Money, Orange Money CI, Orange Money ML, Mtn Money CI, Moov Money CI, Moov Money ML, Wave, Wave CI, Wizall, Carte Bancaire, Emoney, Tigo Cash, Free Money, Moov Money BJ, Mtn Money BJ.

## Configuration

| Variable             | Required | Description                          |
| -------------------- | -------- | ------------------------------------ |
| `PAYTECH_API_KEY`    | Yes      | Used by `getPaytechService()`        |
| `PAYTECH_API_SECRET` | Yes      | Used by `getPaytechService()`        |
| `PAYTECH_ENV`        | No       | `test` or `prod`, defaults to `test` |

See [.env.example](.env.example).

## Development

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

`npm run test:coverage` runs the suite with a coverage report. `npm run format` applies Prettier.

## License

MIT, see [LICENSE](LICENSE).
