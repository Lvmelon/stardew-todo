import { generateVapidKeys, uint8ArrayToUrlBase64 } from "@mmmike/web-push/vapid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendWebPush } from "../src/push.js";

async function subscriptionFixture() {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    endpoint: "https://fcm.googleapis.com/fcm/send/test-subscription",
    expiration_time: null,
    p256dh: uint8ArrayToUrlBase64(publicKey),
    auth: uint8ArrayToUrlBase64(auth),
  };
}

describe("standards-based Web Push transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds an RFC 8291 aes128gcm request without Node crypto shims", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const vapid = await generateVapidKeys();

    const result = await sendWebPush(
      await subscriptionFixture(),
      { title: "今日任务", body: "提醒：记得完成「取快递」", taskId: "task-1" },
      {
        VAPID_SUBJECT: "mailto:hello@example.com",
        VAPID_PUBLIC_KEY: vapid.publicKey,
        VAPID_PRIVATE_KEY: vapid.privateKey,
      },
    );

    expect(result.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [endpoint, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(endpoint).toBe("https://fcm.googleapis.com/fcm/send/test-subscription");
    expect(init.method).toBe("POST");
    expect(headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(headers.get("Authorization")).toMatch(/^vapid t=.+, k=.+$/);
    expect(headers.get("Content-Type")).toBe("application/octet-stream");
    expect(Number(headers.get("TTL"))).toBe(86_400);
    expect(init.body.byteLength).toBeGreaterThan(100);
  });

  it("maps an expired subscription to a removable response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 410 })));
    const vapid = await generateVapidKeys();
    const result = await sendWebPush(await subscriptionFixture(), { title: "今日任务" }, {
      VAPID_SUBJECT: "mailto:hello@example.com",
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
    });
    expect(result.status).toBe(410);
  });
});
