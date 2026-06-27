import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaytechService } from "../src/paytechService.js";
import type { PaymentIpnPayload, TransferIpnPayload } from "../src/types.js";

const API_KEY = "test-api-key";
const API_SECRET = "test-api-secret";

function hmac(message: string): string {
  return crypto.createHmac("sha256", API_SECRET).update(message).digest("hex");
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function basePaymentIpn(overrides: Partial<PaymentIpnPayload> = {}): PaymentIpnPayload {
  return {
    type_event: "sale_complete",
    ref_command: "CMD-1",
    item_name: "Widget",
    item_price: "1000",
    final_item_price: "950",
    currency: "XOF",
    command_name: "Order #1",
    token: "tok_123",
    env: "test",
    api_key_sha256: sha256(API_KEY),
    api_secret_sha256: sha256(API_SECRET),
    ...overrides,
  };
}

function baseTransferIpn(
  overrides: Partial<TransferIpnPayload> = {},
): TransferIpnPayload {
  return {
    type_event: "transfer_success",
    id_transfer: "TR-1",
    amount: "500",
    destination_number: "772457199",
    service_name: "Wave Senegal",
    token: "tok_456",
    env: "test",
    api_key_sha256: sha256(API_KEY),
    api_secret_sha256: sha256(API_SECRET),
    ...overrides,
  };
}

describe("PaytechService construction", () => {
  it("throws when apiKey is missing", () => {
    expect(() => new PaytechService({ apiKey: "", apiSecret: API_SECRET })).toThrow(
      /apiKey/,
    );
  });

  it("throws when apiSecret is missing", () => {
    expect(() => new PaytechService({ apiKey: API_KEY, apiSecret: "" })).toThrow(
      /apiSecret/,
    );
  });

  it("defaults env to test", () => {
    expect(
      () => new PaytechService({ apiKey: API_KEY, apiSecret: API_SECRET }),
    ).not.toThrow();
  });
});

describe("verifyIpn: payment events", () => {
  let service: PaytechService;

  beforeEach(() => {
    service = new PaytechService({ apiKey: API_KEY, apiSecret: API_SECRET });
  });

  it("validates a correct HMAC payment signature", () => {
    const message = `950|CMD-1|${API_KEY}`;
    const payload = basePaymentIpn({ hmac_compute: hmac(message) });

    const result = service.verifyIpn(payload);

    expect(result.kind).toBe("payment");
    expect(result.valid).toBe(true);
    expect(result.method).toBe("hmac");
    if (result.kind === "payment") {
      expect(result.refCommand).toBe("CMD-1");
      expect(result.itemPrice).toBe(1000);
      expect(result.finalItemPrice).toBe(950);
    }
  });

  it("falls back to item_price when final_item_price is absent", () => {
    const payload = basePaymentIpn();
    delete payload.final_item_price;
    const message = `1000|CMD-1|${API_KEY}`;
    payload.hmac_compute = hmac(message);

    const result = service.verifyIpn(payload);
    expect(result.valid).toBe(true);
  });

  it("rejects a tampered HMAC signature", () => {
    const payload = basePaymentIpn({ hmac_compute: hmac(`950|CMD-1|${API_KEY}`) });
    payload.final_item_price = "1"; // tamper with the amount after signing

    const result = service.verifyIpn(payload);
    expect(result.valid).toBe(false);
  });

  it("validates the SHA256 fallback when hmac_compute is absent", () => {
    const payload = basePaymentIpn();
    const result = service.verifyIpn(payload);

    expect(result.method).toBe("sha256");
    expect(result.valid).toBe(true);
  });

  it("rejects instead of throwing when the SHA256 fields are missing entirely", () => {
    const payload = { type_event: "sale_complete" } as unknown as PaymentIpnPayload;

    expect(() => service.verifyIpn(payload)).not.toThrow();
    expect(service.verifyIpn(payload).valid).toBe(false);
  });

  it("rejects the SHA256 fallback when hashes do not match", () => {
    const payload = basePaymentIpn({ api_secret_sha256: "deadbeef" });
    const result = service.verifyIpn(payload);

    expect(result.valid).toBe(false);
  });

  it("decodes a base64-encoded custom_field", () => {
    const custom = Buffer.from(JSON.stringify({ userId: 42 })).toString("base64");
    const payload = basePaymentIpn({ custom_field: custom });

    const result = service.verifyIpn(payload);
    expect(result.kind).toBe("payment");
    if (result.kind === "payment") {
      expect(result.customField).toEqual({ userId: 42 });
    }
  });

  it("ignores a malformed custom_field instead of throwing", () => {
    const payload = basePaymentIpn({ custom_field: "not-valid-base64-json" });
    const result = service.verifyIpn(payload);

    expect(result.kind).toBe("payment");
    if (result.kind === "payment") {
      expect(result.customField).toBeUndefined();
    }
  });
});

describe("verifyIpn: transfer events", () => {
  let service: PaytechService;

  beforeEach(() => {
    service = new PaytechService({ apiKey: API_KEY, apiSecret: API_SECRET });
  });

  it("validates a correct HMAC transfer signature using amount|id_transfer|api_key", () => {
    const message = `500|TR-1|${API_KEY}`;
    const payload = baseTransferIpn({ hmac_compute: hmac(message) });

    const result = service.verifyIpn(payload);

    expect(result.kind).toBe("transfer");
    expect(result.valid).toBe(true);
    if (result.kind === "transfer") {
      expect(result.idTransfer).toBe("TR-1");
      expect(result.amount).toBe(500);
      expect(result.serviceName).toBe("Wave Senegal");
    }
  });

  it("rejects a transfer signature computed with the payment formula", () => {
    // Using ref_command/item_price style message on a transfer payload must fail.
    const wrongMessage = `500|wrong-ref|${API_KEY}`;
    const payload = baseTransferIpn({ hmac_compute: hmac(wrongMessage) });

    const result = service.verifyIpn(payload);
    expect(result.valid).toBe(false);
  });

  it("validates the SHA256 fallback for transfer_failed", () => {
    const payload = baseTransferIpn({ type_event: "transfer_failed" });
    const result = service.verifyIpn(payload);

    expect(result.method).toBe("sha256");
    expect(result.valid).toBe(true);
  });
});

describe("requestPayment", () => {
  let service: PaytechService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    service = new PaytechService({ apiKey: API_KEY, apiSecret: API_SECRET });
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const validParams = {
    itemName: "Widget",
    itemPrice: 1000,
    refCommand: "CMD-1",
    commandName: "Order #1",
    ipnUrl: "https://example.com/ipn",
    successUrl: "https://example.com/success",
    cancelUrl: "https://example.com/cancel",
  };

  it("rejects a non-HTTPS ipnUrl before calling the network", async () => {
    await expect(
      service.requestPayment({ ...validParams, ipnUrl: "http://example.com/ipn" }),
    ).rejects.toThrow(/HTTPS/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-integer itemPrice", async () => {
    await expect(
      service.requestPayment({ ...validParams, itemPrice: 9.99 }),
    ).rejects.toThrow(/itemPrice/);
  });

  it("rejects an unknown targetPayment value", async () => {
    await expect(
      service.requestPayment({ ...validParams, targetPayment: "Bitcoin" }),
    ).rejects.toThrow(/targetPayment/);
  });

  it("sends the documented request body and auth headers", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: 1,
        token: "tok_1",
        redirect_url: "https://paytech.sn/checkout/1",
      }),
    );

    await service.requestPayment(validParams);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://paytech.sn/api/payment/request-payment");
    expect(init.headers.API_KEY).toBe(API_KEY);
    expect(init.headers.API_SECRET).toBe(API_SECRET);

    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      item_name: "Widget",
      item_price: 1000,
      ref_command: "CMD-1",
      currency: "XOF",
      env: "test",
    });
  });

  it("returns the checkout URL on success", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: 1,
        token: "tok_1",
        redirect_url: "https://paytech.sn/checkout/1",
      }),
    );

    const result = await service.requestPayment(validParams);

    expect(result).toEqual({
      success: true,
      redirectUrl: "https://paytech.sn/checkout/1",
      token: "tok_1",
      raw: { success: 1, token: "tok_1", redirect_url: "https://paytech.sn/checkout/1" },
    });
  });

  it("appends autofill query params for a single target payment", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: 1,
        token: "tok_1",
        redirect_url: "https://paytech.sn/checkout/1",
      }),
    );

    const result = await service.requestPayment(
      { ...validParams, targetPayment: "Orange Money" },
      { phoneWithCode: "+221777777777", fullName: "Jane Doe" },
    );

    const redirectUrl = new URL(result.redirectUrl as string);
    expect(redirectUrl.searchParams.get("pn")).toBe("+221777777777");
    expect(redirectUrl.searchParams.get("nn")).toBe("777777777");
    expect(redirectUrl.searchParams.get("fn")).toBe("Jane Doe");
    expect(redirectUrl.searchParams.get("tp")).toBe("Orange Money");
    expect(redirectUrl.searchParams.get("nac")).toBe("1");
  });

  it("forces nac=0 for Carte Bancaire autofill", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: 1,
        token: "tok_1",
        redirect_url: "https://paytech.sn/checkout/1",
      }),
    );

    const result = await service.requestPayment(
      { ...validParams, targetPayment: "Carte Bancaire" },
      { phoneWithCode: "+221777777777", fullName: "Jane Doe" },
    );

    const redirectUrl = new URL(result.redirectUrl as string);
    expect(redirectUrl.searchParams.get("nac")).toBe("0");
  });

  it("does not autofill when targetPayment lists multiple methods", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: 1,
        token: "tok_1",
        redirect_url: "https://paytech.sn/checkout/1",
      }),
    );

    const result = await service.requestPayment(
      { ...validParams, targetPayment: "Orange Money,Wave" },
      { phoneWithCode: "+221777777777", fullName: "Jane Doe" },
    );

    expect(result.redirectUrl).toBe("https://paytech.sn/checkout/1");
  });

  it("returns success:false when the API reports failure", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: 0, message: "Invalid API key" }, 401),
    );

    const result = await service.requestPayment(validParams);

    expect(result).toMatchObject({ success: false, error: "Invalid API key" });
  });

  it("returns success:false on a network error", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    const result = await service.requestPayment(validParams);

    expect(result).toEqual({ success: false, error: "network down" });
  });
});

describe("HTTP helpers", () => {
  let service: PaytechService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    service = new PaytechService({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      timeoutMs: 50,
    });
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getPaymentStatus issues a GET with the token in the query string", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: 1 }));
    await service.getPaymentStatus("tok_1");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://paytech.sn/api/payment/get-status?token_payment=tok_1");
    expect(init.method).toBeUndefined();
  });

  it("transferFund posts the documented fields", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: 1, transfer: { id_transfer: "TR-1" } }),
    );

    await service.transferFund({
      amount: 500,
      destinationNumber: "772457199",
      service: "Wave Senegal",
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://paytech.sn/api/transfer/transferFund");
    expect(JSON.parse(init.body)).toEqual({
      amount: 500,
      destination_number: "772457199",
      service: "Wave Senegal",
    });
  });

  it("getTransferHistory serializes only the provided filters", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: 1, data: [] }));
    await service.getTransferHistory({ page: 2, statusIn: "success,failed" });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://paytech.sn/api/transfer/get-history?page=2&status_in=success%2Cfailed",
    );
  });

  it("refundPayment posts ref_command", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: 1 }));
    await service.refundPayment("CMD-1");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ ref_command: "CMD-1" });
  });

  it("returns a structured error when the request times out", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    const result = await service.getAccountInfo();
    expect(result).toEqual({
      success: 0,
      message: "PayTech: request timed out after 50ms.",
    });
  });

  it("returns a structured error on network failure instead of throwing", async () => {
    fetchMock.mockRejectedValue(new Error("DNS failure"));

    const result = await service.getAccountInfo();
    expect(result).toEqual({ success: 0, message: "DNS failure" });
  });
});
