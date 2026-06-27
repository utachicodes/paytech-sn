/**
 * Example: app/api/payments/ipn/route.ts (Next.js App Router)
 *
 * PayTech POSTs here after every payment, refund, or transfer event.
 * Copy this file into your Next.js app and replace the TODOs with your
 * own persistence logic. Requires the Node.js runtime (uses `node:crypto`
 * through the `paytech-sn` package), so do not set `export const runtime
 * = "edge"` on this route.
 */

import { NextRequest, NextResponse } from "next/server";
import { getPaytechService, type IpnPayload } from "paytech-sn";

export async function POST(req: NextRequest) {
  let payload: IpnPayload;

  try {
    payload = (await req.json()) as IpnPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const paytech = getPaytechService();
  const result = paytech.verifyIpn(payload);

  if (!result.valid) {
    console.warn(
      `[paytech] rejected IPN with invalid signature (method: ${result.method})`,
    );
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (result.kind === "payment") {
    switch (result.typeEvent) {
      case "sale_complete":
        // TODO: mark the order as paid.
        // await db.orders.update({
        //   where: { refCommand: result.refCommand },
        //   data: {
        //     status: "paid",
        //     paidAmount: result.finalItemPrice ?? result.itemPrice,
        //     paymentMethod: result.paymentMethod,
        //   },
        // });
        break;
      case "sale_canceled":
        // TODO: mark the order as canceled.
        // await db.orders.update({
        //   where: { refCommand: result.refCommand },
        //   data: { status: "canceled" },
        // });
        break;
      case "refund_complete":
        // TODO: mark the order as refunded.
        // await db.orders.update({
        //   where: { refCommand: result.refCommand },
        //   data: { status: "refunded" },
        // });
        break;
    }
  } else {
    // result.kind === "transfer"
    // TODO: reconcile the payout with your ledger using result.idTransfer.
  }

  return NextResponse.json({ received: true });
}
