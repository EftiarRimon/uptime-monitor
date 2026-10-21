/* global queueMicrotask */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  createOutboundClient,
  isPublicAddress,
  publicUrl,
  OutboundPolicyError,
  OutboundRequestError,
} from "../src/outbound.ts";
import { checkMonitor } from "../src/monitor.ts";
import { notifyIncident } from "../src/notifications.ts";
import { pool } from "../src/db.ts";

const publicV4 = { address: "93.184.216.34", family: 4 };
const publicV6 = { address: "2606:4700:4700::1111", family: 6 };
function scriptedOpen(steps, seen = []) {
  return (url, options, response) => {
    const request = new EventEmitter();
    request.end = (body) =>
      queueMicrotask(() => {
        options.lookup(
          url.hostname.replace(/^\[|\]$/g, ""),
          { family: options.family },
          (error, address, family) => {
            if (error) {
              request.emit("error", error);
              return;
            }
            const step = steps.shift();
            if (!step) {
              request.emit(
                "error",
                new Error("Unexpected outbound connection"),
              );
              return;
            }
            const record = {
              url: url.href,
              options,
              address,
              family,
              body,
              destroyed: false,
            };
            seen.push(record);
            if (step.error) {
              request.emit("error", step.error);
              return;
            }
            const reply = {
              statusCode: step.status ?? 200,
              headers: step.location ? { location: step.location } : {},
              destroy: () => {
                record.destroyed = true;
              },
            };
            response(reply);
          },
        );
      });
    return request;
  };
}

test("local, special-use, metadata, and encoded private destinations are blocked", () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "127.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.200",
    "168.63.129.16",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fec0::1",
    "fc00::1",
    "fd00:ec2::254",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "64:ff9b::a00:1",
    "2002:7f00:1::",
    "2001::1",
    "2001:db8::1",
    "3fff::1",
    "fe80::1%eth0",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const target of [
    "http://localhost",
    "http://LOCALHOST.",
    "http://service.localhost",
    "http://postgres:5432",
    "http://service.internal",
    "http://printer.local",
    "http://127.1",
    "http://2130706433",
    "http://0177.0.0.1",
    "http://0x7f000001",
    "http://[::ffff:7f00:1]",
    "http://[::1]",
    "http://169.254.169.254/latest/meta-data",
    "http://168.63.129.16",
    "file:///etc/passwd",
    "gopher://example.com",
    "https://user:secret@example.com",
  ]) {
    assert.throws(() => publicUrl(target), OutboundPolicyError, target);
  }
  assert.equal(isPublicAddress(publicV4.address), true);
  assert.equal(isPublicAddress(publicV6.address), true);
  assert.equal(
    publicUrl("https://Example.com./health#fragment").href,
    "https://example.com/health",
  );
});

test("private or mixed DNS answers cause no outbound connections", async () => {
  for (const answers of [
    [{ address: "10.0.0.1", family: 4 }],
    [publicV4, { address: "127.0.0.1", family: 4 }],
    [publicV4, { address: "fd00::1", family: 6 }],
    [{ address: publicV4.address, family: 6 }],
  ]) {
    let connections = 0;
    const client = createOutboundClient({
      resolve: async () => answers,
      open: () => {
        connections++;
        throw new Error("Must not connect");
      },
    });
    await assert.rejects(
      client("https://service.example.com"),
      OutboundPolicyError,
    );
    assert.equal(connections, 0);
  }
});

test("connections use only the checked address and preserve the TLS hostname", async () => {
  let lookups = 0;
  const seen = [];
  const client = createOutboundClient({
    resolve: async () => {
      lookups++;
      return lookups === 1
        ? [publicV6, publicV4]
        : [{ address: "127.0.0.1", family: 4 }];
    },
    open: scriptedOpen([{ status: 200 }], seen),
  });
  assert.equal(
    (
      await client("https://service.example.com/health", {
        headers: { host: "internal.invalid" },
      })
    ).status,
    200,
  );
  assert.equal(lookups, 1);
  assert.equal(seen[0].address, publicV4.address);
  assert.equal(seen[0].family, 4);
  assert.equal(seen[0].url, "https://service.example.com/health");
  assert.equal(seen[0].options.servername, "service.example.com");
  assert.equal(seen[0].options.headers.host, "service.example.com");
  assert.equal(seen[0].options.rejectUnauthorized, true);
  assert.equal(seen[0].options.autoSelectFamily, false);
  assert.equal(seen[0].options.agent, false);
  assert.equal(seen[0].destroyed, true);
});

test("public IPv6 literals are validated and do not require DNS", async () => {
  const seen = [];
  const client = createOutboundClient({
    resolve: async () => {
      throw new Error("Literal IP should not resolve");
    },
    open: scriptedOpen([{ status: 204 }], seen),
  });
  assert.equal((await client(`https://[${publicV6.address}]/`)).ok, true);
  assert.equal(seen[0].address, publicV6.address);
  assert.equal(seen[0].family, 6);
});

test("redirects to private destinations are rejected before the second connection", async () => {
  for (const location of [
    "http://127.0.0.1/admin",
    "http://[::ffff:127.0.0.1]/",
    "http://169.254.169.254/secret",
    "//localhost/admin",
    "file:///etc/passwd",
    "https://user:secret@example.com/",
  ]) {
    const seen = [];
    const client = createOutboundClient({
      resolve: async () => [publicV4],
      open: scriptedOpen([{ status: 302, location }], seen),
    });
    await assert.rejects(
      client("https://service.example.com"),
      OutboundPolicyError,
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].destroyed, true);
  }
});

test("DNS is revalidated on same-host redirects and every new request", async () => {
  let lookups = 0;
  const seen = [];
  const client = createOutboundClient({
    resolve: async () =>
      ++lookups === 1 ? [publicV4] : [{ address: "10.0.0.1", family: 4 }],
    open: scriptedOpen([{ status: 302, location: "/next" }], seen),
  });
  await assert.rejects(
    client("https://service.example.com"),
    OutboundPolicyError,
  );
  await assert.rejects(
    client("https://service.example.com"),
    OutboundPolicyError,
  );
  assert.equal(lookups, 3);
  assert.equal(seen.length, 1);
});

test("public relative redirects work and loops stop at five redirects", async () => {
  const seen = [];
  const client = createOutboundClient({
    resolve: async () => [publicV4],
    open: scriptedOpen(
      [{ status: 301, location: "/health" }, { status: 200 }],
      seen,
    ),
  });
  assert.equal((await client("https://service.example.com/start")).ok, true);
  assert.equal(seen[1].url, "https://service.example.com/health");
  const loop = [];
  const cycling = createOutboundClient({
    resolve: async () => [publicV4],
    open: scriptedOpen(
      Array.from({ length: 6 }, () => ({ status: 302, location: "/again" })),
      loop,
    ),
  });
  await assert.rejects(cycling("https://service.example.com"), {
    message: "Too many redirects",
  });
  assert.equal(loop.length, 6);
});

test("webhook payloads are never forwarded through redirects", async () => {
  const seen = [];
  const client = createOutboundClient({
    resolve: async () => [publicV4],
    open: scriptedOpen(
      [{ status: 307, location: "https://other.example.com/" }],
      seen,
    ),
  });
  const response = await client("https://hooks.example.com/private-token", {
    method: "POST",
    body: '{"incident":"private"}',
    headers: { "content-type": "application/json" },
  });
  assert.equal(response.status, 307);
  assert.equal(response.ok, false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body, '{"incident":"private"}');
});

test("DNS and redirect chains share one deadline and errors hide target secrets", async () => {
  const hanging = createOutboundClient({
    resolve: () => new Promise(() => {}),
  });
  await assert.rejects(
    hanging("https://hooks.example.com/private-token", { timeoutMs: 20 }),
    { message: "Outbound request timed out" },
  );
  const broken = createOutboundClient({
    resolve: async () => {
      throw new Error("DNS server 10.0.0.1 secret-token");
    },
  });
  await assert.rejects(broken("https://hooks.example.com/private-token"), {
    message: "Unable to resolve the target hostname",
  });
  const seen = [];
  const scripted = scriptedOpen([{ status: 302, location: "/next" }], seen);
  let count = 0;
  const timed = createOutboundClient({
    resolve: async () => {
      if (++count === 2) await delay(100);
      return [publicV4];
    },
    open: scripted,
  });
  await assert.rejects(
    timed("https://service.example.com", { timeoutMs: 30 }),
    { message: "Outbound request timed out" },
  );
  assert.equal(seen.length, 1);
  const failed = createOutboundClient({
    resolve: async () => [publicV4],
    open: scriptedOpen([
      {
        error: new Error(
          "TLS error at https://hooks.example.com/private-token",
        ),
      },
    ]),
  });
  await assert.rejects(failed("https://hooks.example.com/private-token"), {
    message: "Outbound request failed",
  });
  await assert.rejects(
    failed("https://hooks.example.com", {
      method: "POST",
      body: "x".repeat(65537),
    }),
    OutboundRequestError,
  );
});

test("stored private targets produce failed check and delivery history without fetching", async () => {
  const original = pool.query;
  const statements = [];
  pool.query = async (sql, values) => {
    statements.push({ sql, values });
    if (sql.startsWith("SELECT id, url FROM monitors"))
      return {
        rowCount: 1,
        rows: [{ id: 7, url: "http://169.254.169.254/secret" }],
      };
    if (sql.startsWith("SELECT id, type, target"))
      return {
        rowCount: 1,
        rows: [
          { id: 9, type: "webhook", target: "http://127.0.0.1/internal-token" },
        ],
      };
    if (sql.includes("INSERT INTO monitor_checks"))
      return {
        rowCount: 1,
        rows: [{ id: 10, status: values[1], error_message: values[4] }],
      };
    return { rowCount: 1, rows: [] };
  };
  try {
    const result = await checkMonitor(7, 42);
    assert.equal(result.status, "down");
    assert.match(result.error_message, /Target is blocked/);
    assert.equal(result.error_message.includes("secret"), false);
    await notifyIncident(42, 10, "opened", { title: "API down" });
    const deliveries = statements.filter((statement) =>
      statement.sql.includes("INSERT INTO notification_deliveries"),
    );
    assert.equal(deliveries.length, 1);
    assert.match(deliveries[0].values[2], /Target is blocked/);
    assert.equal(deliveries[0].values[3], 1);
    assert.equal(deliveries[0].values[2].includes("internal-token"), false);
  } finally {
    pool.query = original;
    await pool.end();
  }
});
