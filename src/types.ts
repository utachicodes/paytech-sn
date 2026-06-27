// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const PAYMENT_METHODS = [
  "Orange Money",
  "Orange Money CI",
  "Orange Money ML",
  "Mtn Money CI",
  "Moov Money CI",
  "Moov Money ML",
  "Wave",
  "Wave CI",
  "Wizall",
  "Carte Bancaire",
  "Emoney",
  "Tigo Cash",
  "Free Money",
  "Moov Money BJ",
  "Mtn Money BJ",
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const CURRENCIES = ["XOF", "EUR", "USD", "CAD", "GBP", "MAD"] as const;

export type Currency = (typeof CURRENCIES)[number];

export type Environment = "test" | "prod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PaytechConfig {
  apiKey: string;
  apiSecret: string;
  /** Defaults to "test" so integrations never charge real money by accident. */
  env?: Environment;
  /** Aborts any request that takes longer than this. Defaults to 15000. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Payment request
// ---------------------------------------------------------------------------

export interface PaymentRequestParams {
  /** Name of the product or service being sold. */
  itemName: string;
  /** Order amount as a positive integer (e.g. 5000 for 5000 XOF). */
  itemPrice: number;
  /** Unique order reference that you generate. */
  refCommand: string;
  /** Human-readable order description. */
  commandName: string;
  /** Defaults to XOF. */
  currency?: Currency;
  /** HTTPS endpoint PayTech calls with payment events. */
  ipnUrl: string;
  /** Redirect target after a successful payment. */
  successUrl: string;
  /** Redirect target after a cancelled payment. */
  cancelUrl: string;
  /**
   * One or more payment methods, comma-separated.
   * A single method enables checkout autofill (see `requestPayment`'s
   * `autofill` argument); multiple methods leave the choice to the payer.
   */
  targetPayment?: PaymentMethod | (string & Record<never, never>);
  /** HTTPS endpoint PayTech calls with refund events. */
  refundNotifUrl?: string;
  /** Arbitrary metadata, JSON-serialized and round-tripped Base64 in the IPN. */
  customField?: Record<string, unknown>;
}

export interface PaytechPaymentResponse {
  success: boolean;
  /** Checkout URL to redirect the payer to. */
  redirectUrl?: string;
  token?: string;
  error?: string;
  raw?: unknown;
}

export interface AutofillParams {
  /** Phone number with country code, e.g. "+221777777777". */
  phoneWithCode: string;
  /** Payer's full name. */
  fullName: string;
}

// ---------------------------------------------------------------------------
// IPN payloads
//
// PayTech posts a different field set, and a different HMAC message format,
// depending on the event:
//  - payment events (sale_complete, sale_canceled, refund_complete) key off
//    `final_item_price|ref_command|api_key`
//  - transfer events (transfer_success, transfer_failed) key off
//    `amount|id_transfer|api_key`
// ---------------------------------------------------------------------------

export type PaymentIpnEvent = "sale_complete" | "sale_canceled" | "refund_complete";

export type TransferIpnEvent = "transfer_success" | "transfer_failed";

interface IpnSignatureFields {
  api_key_sha256: string;
  api_secret_sha256: string;
  /** Present when the merchant has HMAC verification enabled (recommended). */
  hmac_compute?: string;
  env: string;
  token: string;
}

export interface PaymentIpnPayload extends IpnSignatureFields {
  type_event: PaymentIpnEvent;
  ref_command: string;
  item_name: string;
  item_price: string;
  final_item_price?: string;
  initial_item_price?: string;
  promo_enabled?: boolean;
  promo_value_percent?: number;
  currency: string;
  command_name: string;
  payment_method?: string;
  client_phone?: string;
  /** Base64-encoded JSON, mirrors `PaymentRequestParams.customField`. */
  custom_field?: string;
}

export interface TransferIpnPayload extends IpnSignatureFields {
  type_event: TransferIpnEvent;
  id_transfer: string;
  amount: string;
  destination_number: string;
  service_name: string;
  external_id?: string;
}

export type IpnPayload = PaymentIpnPayload | TransferIpnPayload;

interface IpnVerificationBase {
  valid: boolean;
  method: "hmac" | "sha256";
  typeEvent: string;
}

export interface PaymentIpnResult extends IpnVerificationBase {
  kind: "payment";
  refCommand: string;
  itemName: string;
  itemPrice: number;
  finalItemPrice?: number;
  promoEnabled?: boolean;
  promoValuePercent?: number;
  paymentMethod?: string;
  clientPhone?: string;
  customField?: Record<string, unknown>;
}

export interface TransferIpnResult extends IpnVerificationBase {
  kind: "transfer";
  idTransfer: string;
  amount: number;
  destinationNumber: string;
  serviceName: string;
  externalId?: string;
}

export type IpnVerificationResult = PaymentIpnResult | TransferIpnResult;

// ---------------------------------------------------------------------------
// Transfers, refunds, SMS, account info
// ---------------------------------------------------------------------------

export interface TransferParams {
  amount: number;
  destinationNumber: string;
  /** e.g. "Orange Money Senegal", "Wave Senegal". */
  service: string;
  callbackUrl?: string;
  externalId?: string;
}

export interface TransferRecord {
  id_transfer: string;
  token_transfer?: string;
  state: string;
  amount: number;
  destination_number: string;
  service: string;
  external_id?: string;
  created_at?: string;
}

export interface TransferFundResponse {
  success: number;
  message?: string;
  transfer?: TransferRecord;
}

export interface TransferHistoryFilters {
  /** ISO date, YYYY-MM-DD. */
  startDate?: string;
  /** ISO date, YYYY-MM-DD. */
  endDate?: string;
  page?: number;
  searchPhone?: string;
  /** Comma-separated statuses, e.g. "pending,failed,success". */
  statusIn?: string;
}

export interface TransferHistoryResponse {
  success: number;
  message?: string;
  data?: TransferRecord[];
}

export interface TransferStatusResponse {
  success: number;
  message?: string;
  transfer?: TransferRecord;
}

export interface AccountInfoResponse {
  success: number;
  message?: string;
  solde?: number;
  hold_amount?: number;
  fee?: number;
  totalTransferable?: number;
  transferableDispo?: number;
}

export interface RefundResponse {
  success: number;
  message?: string;
}

export interface SmsResponse {
  success: boolean | number;
  message?: string;
}

export interface PaymentStatusResponse {
  success: number;
  message?: string;
  [key: string]: unknown;
}
