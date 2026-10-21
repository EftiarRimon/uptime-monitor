import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import ipaddr from "ipaddr.js";

type Address = { address: string; family: number };
type Reply = { status: number; ok: boolean; location?: string };
type Options = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};
type OpenRequest = (
  url: URL,
  options: https.RequestOptions & { autoSelectFamily: false },
  response: (reply: IncomingMessage) => void,
) => ClientRequest;
type Dependencies = {
  resolve?: (hostname: string) => Promise<Address[]>;
  open?: OpenRequest;
};

export class OutboundPolicyError extends Error {
  constructor() {
    super(
      "Target is blocked: only public HTTP or HTTPS destinations are allowed",
    );
    this.name = "OutboundPolicyError";
  }
}
export class OutboundRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundRequestError";
  }
}

export function isPublicAddress(value: string) {
  if (!isIP(value) || value.includes("%")) return false;
  const address = ipaddr.parse(value);
  if (address.range() !== "unicast") return false;
  if (address.kind() === "ipv4") return value !== "168.63.129.16";
  // Limit IPv6 to global unicast; transition, mapped, and special-use ranges fail closed.
  return address.match(ipaddr.parse("2000::"), 3);
}

export function publicUrl(value: string) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new OutboundPolicyError();
  }
  if (
    url.href.length > 2048 ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new OutboundPolicyError();
  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new OutboundPolicyError();
  } else {
    const labels = hostname.split(".");
    const reserved = [
      "localhost",
      "local",
      "internal",
      "lan",
      "home",
      "test",
      "invalid",
      "example",
      "onion",
    ];
    if (
      hostname.length > 253 ||
      labels.length < 2 ||
      labels.some(
        (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
      ) ||
      reserved.includes(labels.at(-1)!)
    )
      throw new OutboundPolicyError();
  }
  url.hostname = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  url.hash = "";
  return url;
}

async function bounded<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted)
    throw new OutboundRequestError("Outbound request timed out");
  let onAbort: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(new OutboundRequestError("Outbound request timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort!);
  }
}

const nativeOpen: OpenRequest = (url, options, response) =>
  (url.protocol === "https:" ? https : http).request(url, options, response);
const redirects = new Set([301, 302, 303, 307, 308]);

export function createOutboundClient({
  resolve = (hostname) => lookup(hostname, { all: true, verbatim: true }),
  open = nativeOpen,
}: Dependencies = {}) {
  return async (value: string, options: Options = {}): Promise<Reply> => {
    const method = options.method ?? "GET";
    if (options.body && Buffer.byteLength(options.body) > 65536)
      throw new OutboundRequestError(
        "Outbound request body exceeds the size limit",
      );
    let url = publicUrl(value);
    const controller = new AbortController();
    const signal = controller.signal;
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? 10_000,
    );
    try {
      for (let hop = 0; ; hop += 1) {
        if (signal.aborted)
          throw new OutboundRequestError("Outbound request timed out");
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        let addresses: Address[];
        try {
          addresses = isIP(hostname)
            ? [{ address: hostname, family: isIP(hostname) }]
            : await bounded(resolve(hostname), signal);
        } catch (error) {
          if (signal.aborted)
            throw new OutboundRequestError("Outbound request timed out");
          if (error instanceof OutboundRequestError) throw error;
          throw new OutboundRequestError(
            "Unable to resolve the target hostname",
          );
        }
        if (!addresses.length)
          throw new OutboundRequestError(
            "Unable to resolve the target hostname",
          );
        if (
          addresses.some(
            (item) =>
              !isPublicAddress(item.address) ||
              isIP(item.address) !== item.family,
          )
        )
          throw new OutboundPolicyError();
        const address =
          addresses.find((item) => item.family === 4) ?? addresses[0]!;
        if (signal.aborted)
          throw new OutboundRequestError("Outbound request timed out");
        const reply = await bounded(
          new Promise<Reply>((resolveReply, reject) => {
            const request = open(
              url,
              {
                method,
                agent: false,
                signal,
                family: address.family,
                autoSelectFamily: false,
                maxHeaderSize: 16384,
                rejectUnauthorized: true,
                ...(isIP(hostname) ? {} : { servername: hostname }),
                headers: {
                  "user-agent": "PulseOps/1.0",
                  ...options.headers,
                  host: url.host,
                },
                // Connect to the checked answer without performing a second DNS lookup.
                lookup: (name, _options, callback) =>
                  name === hostname
                    ? callback(null, address.address, address.family)
                    : callback(new OutboundPolicyError(), "", 0),
              },
              (response) => {
                const status = response.statusCode ?? 0;
                const location = response.headers.location;
                // We measure response headers; consuming arbitrary bodies is unnecessary.
                response.destroy();
                resolveReply({
                  status,
                  ok: status >= 200 && status < 300,
                  ...(location ? { location } : {}),
                });
              },
            );
            request.once("error", () =>
              reject(
                new OutboundRequestError(
                  signal.aborted
                    ? "Outbound request timed out"
                    : "Outbound request failed",
                ),
              ),
            );
            request.once("upgrade", (_response, socket) => {
              socket.destroy();
              reject(
                new OutboundRequestError("Protocol upgrades are not supported"),
              );
            });
            request.end(options.body);
          }),
          signal,
        );
        if (
          method === "POST" ||
          !redirects.has(reply.status) ||
          !reply.location
        )
          return reply;
        if (hop >= 5) throw new OutboundRequestError("Too many redirects");
        try {
          url = publicUrl(new URL(reply.location, url).href);
        } catch {
          throw new OutboundPolicyError();
        }
      }
    } catch (error) {
      if (
        error instanceof OutboundPolicyError ||
        error instanceof OutboundRequestError
      )
        throw error;
      throw new OutboundRequestError("Outbound request failed");
    } finally {
      clearTimeout(timer);
    }
  };
}

export const publicRequest = createOutboundClient();
