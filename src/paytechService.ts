/**
 * PayTech (paytech.sn) payment gateway client.
 * API reference: https://docs.intech.sn/doc_paytech.php
 */

import crypto from "node:crypto";
import {
  PAYMENT_METHODS,
  type AccountInfoResponse,
  type AutofillParams,
  type Environment,
  type IpnPayload,
  type IpnVerificationResult,
  type PaymentIpnPayload,
  type PaymentRequestParams,
  type PaymentStatusResponse,
  type PaytechConfig,
  type PaytechPaymentResponse,
  type RefundResponse,
  type SmsResponse,
  type TransferFundResponse,
  type TransferHistoryFilters,
  type TransferHistoryResponse,
  type TransferIpnPayload,
  type TransferParams,
  type TransferStatusResponse,
} from "./types.js";

const BASE_URL = "https://paytech.sn/api";

// ---------------------------------------------------------------------------
// Validation guards
// ---------------------------------------------------------------------------

function assertNonEmpty(value: string, field: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`PayTech: "${field}" is required.`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`PayTech: "${field}" must be a positive integer.`);
  }
}

function assertHttpsUrl(value: string, field: string): void {
  if (!/^https:\/\//i.test(value)) {
    throw new Error(`PayTech: "${field}" must be an HTTPS URL.`);
  }
}

function assertValidTargetPayment(value: string): void {
  const known = new Set<string>(PAYMENT_METHODS);
  const invalid = value
    .split(",")
    .map((method) => method.trim())
    .filter((method) => !known.has(method));

  if (invalid.length > 0) {
    throw new Error(
      `PayTech: invalid targetPayment value(s): ${invalid.join(", ")}. ` +
        `Expected one of: ${PAYMENT_METHODS.join(", ")}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Network error";
}

function isTransferIpn(payload: IpnPayload): payload is TransferIpnPayload {
  return (
    payload.type_event === "transfer_success" || payload.type_event === "transfer_failed"
  );
}

function decodeCustomField(
  value: string | undefined,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const decoded = Buffer.from(value, "base64").toString("utf-8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PaytechService {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly env: Environment;
  private readonly timeoutMs: number;

  constructor(config: PaytechConfig) {
    assertNonEmpty(config.apiKey, "apiKey");
    assertNonEmpty(config.apiSecret, "apiSecret");
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.env = config.env ?? "test";
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  // -------------------------------------------------------------------------
  // Payment request
  // -------------------------------------------------------------------------

  async requestPayment(
    params: PaymentRequestParams,
    autofill?: AutofillParams,
  ): Promise<PaytechPaymentResponse> {
    assertNonEmpty(params.itemName, "itemName");
    assertNonEmpty(params.refCommand, "refCommand");
    assertNonEmpty(params.commandName, "commandName");
    assertPositiveInteger(params.itemPrice, "itemPrice");
    assertHttpsUrl(params.ipnUrl, "ipnUrl");
    if (params.refundNotifUrl) assertHttpsUrl(params.refundNotifUrl, "refundNotifUrl");
    if (params.targetPayment) assertValidTargetPayment(params.targetPayment);

    const body: Record<string, unknown> = {
      item_name: params.itemName,
      item_price: params.itemPrice,
      currency: params.currency ?? "XOF",
      ref_command: params.refCommand,
      command_name: params.commandName,
      env: this.env,
      ipn_url: params.ipnUrl,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      ...(params.targetPayment && { target_payment: params.targetPayment }),
      ...(params.refundNotifUrl && { refund_notif_url: params.refundNotifUrl }),
      ...(params.customField && { custom_field: JSON.stringify(params.customField) }),
    };

    try {
      const response = await this.fetchWithTimeout(
        `${BASE_URL}/payment/request-payment`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...this.authHeaders,
          },
          body: JSON.stringify(body),
        },
      );

      const data = (await response.json()) as {
        success?: number;
        redirect_url?: string;
        redirectUrl?: string;
        token?: string;
        message?: string;
      };

      if (!response.ok || data.success !== 1) {
        return {
          success: false,
          error: data.message ?? `HTTP ${response.status}`,
          raw: data,
        };
      }

      let redirectUrl = data.redirect_url ?? data.redirectUrl ?? "";

      if (autofill && params.targetPayment && !params.targetPayment.includes(",")) {
        redirectUrl += `?${this.buildAutofillQuery(params.targetPayment, autofill)}`;
      }

      return {
        success: true,
        redirectUrl,
        ...(data.token && { token: data.token }),
        raw: data,
      };
    } catch (err) {
      return { success: false, error: toErrorMessage(err) };
    }
  }

  private buildAutofillQuery(targetPayment: string, autofill: AutofillParams): string {
    return new URLSearchParams({
      pn: autofill.phoneWithCode,
      // Strips a 3-digit country code (+221, +223, +225, +229, ...).
      nn: autofill.phoneWithCode.replace(/^\+\d{3}/, ""),
      fn: autofill.fullName,
      tp: targetPayment,
      // Carte Bancaire needs manual entry, so it is never auto-submitted.
      nac: targetPayment === "Carte Bancaire" ? "0" : "1",
    }).toString();
  }

  // -------------------------------------------------------------------------
  // IPN verification
  // -------------------------------------------------------------------------

  /**
   * Verifies the authenticity of a PayTech IPN notification.
   *
   * HMAC-SHA256 (recommended, used when `hmac_compute` is present):
   *  - payment/refund events: HMAC-SHA256(`${final_item_price}|${ref_command}|${api_key}`, api_secret)
   *  - transfer events:       HMAC-SHA256(`${amount}|${id_transfer}|${api_key}`, api_secret)
   *
   * SHA256 fallback (used otherwise): compares SHA256(api_key) and
   * SHA256(api_secret) against the payload's hash fields.
   *
   * Both methods use a constant-time comparison to avoid timing side channels.
   */
  verifyIpn(payload: IpnPayload): IpnVerificationResult {
    const transfer = isTransferIpn(payload);

    let valid: boolean;
    const method: "hmac" | "sha256" = payload.hmac_compute ? "hmac" : "sha256";

    if (payload.hmac_compute) {
      const message = transfer
        ? `${payload.amount}|${payload.id_transfer}|${this.apiKey}`
        : `${payload.final_item_price ?? payload.item_price}|${payload.ref_command}|${this.apiKey}`;
      const expected = this.hmacSha256Hex(message);
      valid = this.timingSafeEqualHex(expected, payload.hmac_compute);
    } else {
      valid =
        this.timingSafeEqualHex(this.sha256Hex(this.apiKey), payload.api_key_sha256) &&
        this.timingSafeEqualHex(
          this.sha256Hex(this.apiSecret),
          payload.api_secret_sha256,
        );
    }

    if (transfer) {
      return {
        valid,
        method,
        typeEvent: payload.type_event,
        kind: "transfer",
        idTransfer: payload.id_transfer,
        amount: Number(payload.amount),
        destinationNumber: payload.destination_number,
        serviceName: payload.service_name,
        ...(payload.external_id !== undefined && { externalId: payload.external_id }),
      };
    }

    return this.toPaymentIpnResult(payload, valid, method);
  }

  private toPaymentIpnResult(
    payload: PaymentIpnPayload,
    valid: boolean,
    method: "hmac" | "sha256",
  ): IpnVerificationResult {
    const customField = decodeCustomField(payload.custom_field);
    return {
      valid,
      method,
      typeEvent: payload.type_event,
      kind: "payment",
      refCommand: payload.ref_command,
      itemName: payload.item_name,
      itemPrice: Number(payload.item_price),
      ...(payload.final_item_price !== undefined && {
        finalItemPrice: Number(payload.final_item_price),
      }),
      ...(payload.promo_enabled !== undefined && { promoEnabled: payload.promo_enabled }),
      ...(payload.promo_value_percent !== undefined && {
        promoValuePercent: payload.promo_value_percent,
      }),
      ...(payload.payment_method !== undefined && {
        paymentMethod: payload.payment_method,
      }),
      ...(payload.client_phone !== undefined && { clientPhone: payload.client_phone }),
      ...(customField !== undefined && { customField }),
    };
  }

  // -------------------------------------------------------------------------
  // Payment status
  // -------------------------------------------------------------------------

  async getPaymentStatus(tokenPayment: string): Promise<PaymentStatusResponse> {
    assertNonEmpty(tokenPayment, "tokenPayment");
    return this.get<PaymentStatusResponse>(
      `/payment/get-status?token_payment=${encodeURIComponent(tokenPayment)}`,
    );
  }

  // -------------------------------------------------------------------------
  // Transfers
  // -------------------------------------------------------------------------

  async transferFund(params: TransferParams): Promise<TransferFundResponse> {
    assertPositiveInteger(params.amount, "amount");
    assertNonEmpty(params.destinationNumber, "destinationNumber");
    assertNonEmpty(params.service, "service");

    return this.post<TransferFundResponse>("/transfer/transferFund", {
      amount: params.amount,
      destination_number: params.destinationNumber,
      service: params.service,
      ...(params.callbackUrl && { callback_url: params.callbackUrl }),
      ...(params.externalId && { external_id: params.externalId }),
    });
  }

  async getTransferStatus(idTransfer: string): Promise<TransferStatusResponse> {
    assertNonEmpty(idTransfer, "idTransfer");
    return this.get<TransferStatusResponse>(
      `/transfer/get-status?id_transfer=${encodeURIComponent(idTransfer)}`,
    );
  }

  async getTransferHistory(
    filters: TransferHistoryFilters = {},
  ): Promise<TransferHistoryResponse> {
    const qs = new URLSearchParams();
    if (filters.startDate) qs.set("start_date", filters.startDate);
    if (filters.endDate) qs.set("end_date", filters.endDate);
    if (filters.page) qs.set("page", String(filters.page));
    if (filters.searchPhone) qs.set("search_phone", filters.searchPhone);
    if (filters.statusIn) qs.set("status_in", filters.statusIn);

    const query = qs.toString();
    return this.get<TransferHistoryResponse>(
      `/transfer/get-history${query ? `?${query}` : ""}`,
    );
  }

  async getAccountInfo(): Promise<AccountInfoResponse> {
    return this.get<AccountInfoResponse>("/transfer/get-account-info");
  }

  // -------------------------------------------------------------------------
  // Refund
  // -------------------------------------------------------------------------

  async refundPayment(refCommand: string): Promise<RefundResponse> {
    assertNonEmpty(refCommand, "refCommand");
    return this.post<RefundResponse>("/payment/refund-payment", {
      ref_command: refCommand,
    });
  }

  // -------------------------------------------------------------------------
  // SMS
  // -------------------------------------------------------------------------

  async sendSms(destinationNumber: string, content: string): Promise<SmsResponse> {
    assertNonEmpty(destinationNumber, "destinationNumber");
    assertNonEmpty(content, "content");
    return this.post<SmsResponse>("/sms/sms_api", {
      destination_number: destinationNumber,
      sms_content: content,
    });
  }

  // -------------------------------------------------------------------------
  // HTTP + crypto internals
  // -------------------------------------------------------------------------

  private get authHeaders(): Record<string, string> {
    return { API_KEY: this.apiKey, API_SECRET: this.apiSecret };
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`PayTech: request timed out after ${this.timeoutMs}ms.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    try {
      const response = await this.fetchWithTimeout(`${BASE_URL}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...this.authHeaders,
        },
        body: JSON.stringify(body),
      });
      return (await response.json()) as T;
    } catch (err) {
      return { success: 0, message: toErrorMessage(err) } as T;
    }
  }

  private async get<T>(path: string): Promise<T> {
    try {
      const response = await this.fetchWithTimeout(`${BASE_URL}${path}`, {
        headers: { Accept: "application/json", ...this.authHeaders },
      });
      return (await response.json()) as T;
    } catch (err) {
      return { success: 0, message: toErrorMessage(err) } as T;
    }
  }

  private hmacSha256Hex(message: string): string {
    return crypto.createHmac("sha256", this.apiSecret).update(message).digest("hex");
  }

  private sha256Hex(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
  }

  /**
   * Compares two hex-encoded digests in constant time to avoid timing attacks.
   * Accepts `unknown` because one side always comes from an untrusted IPN
   * payload, which may be missing fields or have the wrong type entirely.
   */
  private timingSafeEqualHex(a: unknown, b: unknown): boolean {
    if (
      typeof a !== "string" ||
      typeof b !== "string" ||
      a.length === 0 ||
      b.length === 0
    ) {
      return false;
    }
    const bufA = Buffer.from(a, "hex");
    const bufB = Buffer.from(b, "hex");
    if (bufA.length === 0 || bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }
}

// ---------------------------------------------------------------------------
// Singleton, convenient for serverless route handlers
// ---------------------------------------------------------------------------

let cachedService: PaytechService | undefined;

/**
 * Returns a process-wide `PaytechService` built from `PAYTECH_API_KEY`,
 * `PAYTECH_API_SECRET`, and `PAYTECH_ENV`. Prefer constructing
 * `PaytechService` directly when you need multiple configurations or
 * explicit dependency injection (e.g. in tests).
 */
export function getPaytechService(): PaytechService {
  if (!cachedService) {
    const apiKey = process.env.PAYTECH_API_KEY;
    const apiSecret = process.env.PAYTECH_API_SECRET;
    const env = (process.env.PAYTECH_ENV as Environment | undefined) ?? "test";

    if (!apiKey || !apiSecret) {
      throw new Error(
        "PayTech: missing PAYTECH_API_KEY or PAYTECH_API_SECRET environment variable.",
      );
    }
    cachedService = new PaytechService({ apiKey, apiSecret, env });
  }
  return cachedService;
}
