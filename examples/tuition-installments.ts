/**
 * Example: tracking partial/installment payments against a balance due,
 * e.g. a university tuition invoice paid in several PayTech transactions
 * (student owes 6000, pays 5000, still owes 1000).
 *
 * PayTech has no native concept of an installment plan: every
 * `requestPayment` call is a single, complete checkout. So the "how much
 * is still owed" ledger has to live in your own database, keyed by a
 * unique `refCommand` per installment. This file shows the pattern with
 * an in-memory store; swap `db` for your real database (Prisma, Drizzle,
 * raw SQL, whatever) in a real app.
 *
 * Copy the parts you need into your own backend.
 */

import { getPaytechService, type IpnPayload } from "paytech-sn";

// ---------------------------------------------------------------------------
// Data model (replace with real DB tables)
// ---------------------------------------------------------------------------

interface Invoice {
  id: string;
  studentId: string;
  totalDue: number;
  amountPaid: number;
  status: "unpaid" | "partial" | "paid";
}

interface InstallmentPayment {
  refCommand: string;
  invoiceId: string;
  amount: number;
  status: "pending" | "confirmed" | "canceled";
}

const db = {
  invoices: new Map<string, Invoice>(),
  payments: new Map<string, InstallmentPayment>(), // keyed by refCommand
};

function balanceOf(invoice: Invoice): number {
  return invoice.totalDue - invoice.amountPaid;
}

// ---------------------------------------------------------------------------
// 1. Create the invoice for a term's tuition.
// ---------------------------------------------------------------------------

function createInvoice(studentId: string, totalDue: number): Invoice {
  const invoice: Invoice = {
    id: `INV-${studentId}-${Date.now()}`,
    studentId,
    totalDue,
    amountPaid: 0,
    status: "unpaid",
  };
  db.invoices.set(invoice.id, invoice);
  return invoice;
}

// ---------------------------------------------------------------------------
// 2. Start one installment. Each call gets its own unique refCommand so
//    PayTech, and your ledger, can tell installments apart.
// ---------------------------------------------------------------------------

async function payInstallment(invoiceId: string, amount: number) {
  const invoice = db.invoices.get(invoiceId);
  if (!invoice) throw new Error(`Unknown invoice: ${invoiceId}`);

  const remaining = balanceOf(invoice);
  if (amount > remaining) {
    throw new Error(
      `Installment (${amount}) exceeds remaining balance (${remaining}) for ${invoiceId}.`,
    );
  }

  const refCommand = `${invoiceId}-${db.payments.size + 1}`;
  db.payments.set(refCommand, {
    refCommand,
    invoiceId,
    amount,
    status: "pending",
  });

  const paytech = getPaytechService();
  return paytech.requestPayment({
    itemName: "Tuition installment",
    itemPrice: amount,
    refCommand,
    commandName: `Tuition payment for ${invoice.studentId}`,
    ipnUrl: "https://example.com/api/payments/ipn",
    successUrl: "https://example.com/tuition/success",
    cancelUrl: "https://example.com/tuition/cancel",
    customField: { invoiceId },
  });
}

// ---------------------------------------------------------------------------
// 3. IPN handler: confirm the installment exactly once, then recompute the
//    invoice balance from the ledger.
// ---------------------------------------------------------------------------

async function handleIpn(payload: IpnPayload) {
  const paytech = getPaytechService();
  const result = paytech.verifyIpn(payload);

  if (!result.valid || result.kind !== "payment") {
    return; // reject invalid signatures, ignore transfer events here
  }

  const payment = db.payments.get(result.refCommand);
  if (!payment) return; // unknown refCommand, not ours

  if (result.typeEvent === "sale_complete") {
    // Idempotency: a retried IPN for an already-confirmed payment must not
    // be added to amountPaid twice.
    if (payment.status === "confirmed") return;
    payment.status = "confirmed";

    const invoice = db.invoices.get(payment.invoiceId);
    if (!invoice) return;

    invoice.amountPaid += result.finalItemPrice ?? result.itemPrice;
    invoice.status = balanceOf(invoice) <= 0 ? "paid" : "partial";
  }

  if (result.typeEvent === "sale_canceled") {
    payment.status = "canceled";
  }
}

// ---------------------------------------------------------------------------
// Walkthrough: 6000 XOF tuition, paid as 5000 then 1000.
// ---------------------------------------------------------------------------

async function demo() {
  const invoice = createInvoice("student-42", 6000);

  await payInstallment(invoice.id, 5000);
  // ... payer completes checkout, PayTech POSTs the IPN for the 5000 installment ...
  await handleIpn({} as IpnPayload); // stand-in for the real webhook body

  console.log(`Remaining balance: ${balanceOf(invoice)}`); // 1000, status "partial"

  await payInstallment(invoice.id, 1000);
  // ... second IPN arrives ...
  await handleIpn({} as IpnPayload);

  console.log(`Remaining balance: ${balanceOf(invoice)}`); // 0, status "paid"
}

void demo;
