import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Egress guard: the one gate for every outbound request whose destination a
 * user chose (monitor targets and webhook receivers).
 *
 * Those requests leave from inside the server's own network. Unguarded, anyone
 * who can register can aim a monitor at http://169.254.169.254/ (the cloud
 * metadata service), at localhost, or at a private range, and read the status
 * and timings back from the dashboard: server-side request forgery.
 *
 * Two layers, because neither is enough on its own:
 *
 *  1. checkUrl(): synchronous, before any request. It checks the scheme, and
 *     the host when that is an IP literal or a localhost name. Literals must be
 *     judged here because net.connect never calls `lookup` for them.
 *  2. guardedLookup(): the `lookup` of the agent that opens the socket. It
 *     resolves the name, rejects the target if ANY address is internal, and
 *     hands net.connect exactly the addresses it checked. Validating first and
 *     letting the HTTP client resolve again would leave a gap that DNS
 *     rebinding walks straight through: public to the check, private to the
 *     connect.
 *
 * assertPublicUrl() runs both ahead of time so the API can answer 400 when a
 * monitor or webhook is saved. That is for the user's benefit. The connect-time
 * lookup is what enforces the policy, on every attempt and every redirect hop.
 *
 * ALLOW_PRIVATE_TARGETS=true turns the address checks off, for self-hosted
 * instances that monitor internal services. The scheme check always applies.
 */

export const HTTP_PROTOCOLS = Object.freeze(['http:', 'https:']);

/** Read on every call rather than at import, so tests can flip it. */
export const privateTargetsAllowed = () =>
  String(process.env.ALLOW_PRIVATE_TARGETS ?? '')
    .trim()
    .toLowerCase() === 'true';

export class EgressError extends Error {
  constructor(message, code = 'ERR_EGRESS_BLOCKED') {
    super(message);
    this.name = 'EgressError';
    this.code = code;
  }
}

// --- address classification -------------------------------------------------

const ipv4ToNumber = (address) =>
  address.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);

function ipv6ToBigInt(address) {
  let text = address.split('%')[0]; // drop a zone id (fe80::1%eth0)

  // A trailing dotted quad (::ffff:127.0.0.1) is the last two hextets.
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number);
    text = `${text.slice(0, quad.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];

  return groups.reduce(
    (n, group) => (n << 16n) | BigInt(parseInt(group, 16)),
    0n
  );
}

const v4 = (cidr, label) => {
  const [base, bits] = cidr.split('/');
  return { base: ipv4ToNumber(base), size: 2 ** (32 - Number(bits)), label };
};

const v6 = (cidr, label) => {
  const [base, bits] = cidr.split('/');
  const shift = BigInt(128 - Number(bits));
  return { prefix: ipv6ToBigInt(base) >> shift, shift, label };
};

const inV6 = (n, range) => n >> range.shift === range.prefix;

// The IANA special-purpose ranges that are not globally reachable.
const IPV4_BLOCKED = [
  v4('0.0.0.0/8', 'unspecified'),
  v4('10.0.0.0/8', 'private'),
  v4('100.64.0.0/10', 'carrier-grade NAT'),
  v4('127.0.0.0/8', 'loopback'),
  v4('169.254.0.0/16', 'link-local'), // includes cloud metadata, 169.254.169.254
  v4('172.16.0.0/12', 'private'),
  v4('192.0.0.0/24', 'reserved'), // IETF protocol assignments
  v4('192.0.2.0/24', 'reserved'), // TEST-NET-1
  v4('192.88.99.0/24', 'reserved'), // 6to4 relay anycast
  v4('192.168.0.0/16', 'private'),
  v4('198.18.0.0/15', 'reserved'), // benchmarking
  v4('198.51.100.0/24', 'reserved'), // TEST-NET-2
  v4('203.0.113.0/24', 'reserved'), // TEST-NET-3
  v4('224.0.0.0/4', 'multicast'),
  v4('240.0.0.0/4', 'reserved'), // includes broadcast, 255.255.255.255
];

// The low 32 bits carry an IPv4 address, which is what actually gets reached.
const IPV6_EMBEDDING_V4 = [
  v6('::ffff:0:0/96', 'IPv4-mapped'),
  v6('64:ff9b::/96', 'NAT64'),
];

const IPV6_BLOCKED = [
  v6('::/128', 'unspecified'),
  v6('::1/128', 'loopback'),
  v6('fc00::/7', 'unique-local'),
  v6('fe80::/10', 'link-local'),
  v6('ff00::/8', 'multicast'),
  // Inside 2000::/3 but not globally routable.
  v6('2001::/23', 'reserved'), // IETF protocol assignments, including Teredo
  v6('2001:db8::/32', 'reserved'), // documentation
  v6('2002::/16', 'reserved'), // 6to4, which tunnels to any IPv4 address
  v6('3fff::/20', 'reserved'), // documentation
];

// Only 2000::/3 is allocated as global unicast; anything outside it is reserved.
const IPV6_GLOBAL_UNICAST = v6('2000::/3', 'global unicast');

const ipv4Range = (n) =>
  IPV4_BLOCKED.find(
    (range) =>
      Math.floor(n / range.size) === Math.floor(range.base / range.size)
  )?.label ?? null;

/**
 * Why `address` must not be connected to, or null when it is public.
 * @param {string} address an IPv4 or IPv6 address, without brackets
 */
export function blockedRange(address) {
  const family = net.isIP(address);
  if (family === 4) return ipv4Range(ipv4ToNumber(address));
  if (family !== 6) return null;

  const n = ipv6ToBigInt(address);
  const wrapper = IPV6_EMBEDDING_V4.find((range) => inV6(n, range));
  if (wrapper) {
    const inner = ipv4Range(Number(n & 0xffffffffn));
    return inner && `${wrapper.label} ${inner}`;
  }

  const range = IPV6_BLOCKED.find((r) => inV6(n, r));
  if (range) return range.label;
  return inV6(n, IPV6_GLOBAL_UNICAST) ? null : 'reserved';
}

const REACH = 'Monitors and webhooks can only reach public hosts.';

const notPublic = (what, range) =>
  `${what} is not a public address (${range}). ${REACH}`;

const resolvesTo = (host, address, range) =>
  `${host} resolves to ${address}, which is not a public address (${range}). ${REACH}`;

const bareHost = (url) => url.hostname.replace(/^\[|\]$/g, '');

// --- the checks -------------------------------------------------------------

/**
 * Synchronous pre-flight for one URL: the scheme, plus the host when it can be
 * judged without DNS. Returns the parsed URL and throws EgressError otherwise.
 *
 * The WHATWG URL parser has already rewritten decimal (2130706433), octal
 * (0177.0.0.1), hex (0x7f000001) and shortened (127.1) IPv4 hosts as dotted
 * quads, and IPv6 hosts in compressed form, so every spelling of an address
 * arrives here as the same string.
 */
export function checkUrl(target, { protocols = HTTP_PROTOCOLS } = {}) {
  let url;
  try {
    url = target instanceof URL ? target : new URL(target);
  } catch {
    throw new EgressError(`Not a valid URL: ${target}`, 'ERR_INVALID_URL');
  }

  if (!protocols.includes(url.protocol)) {
    const allowed = protocols.map((p) => p.replace(/:$/, '')).join(' or ');
    throw new EgressError(
      `Unsupported protocol ${url.protocol} (only ${allowed} URLs are allowed)`,
      'ERR_UNSUPPORTED_PROTOCOL'
    );
  }

  if (privateTargetsAllowed()) return url;

  const host = bareHost(url);
  const name = host.replace(/\.$/, '').toLowerCase();
  // RFC 6761: every name under .localhost is loopback, whatever DNS says.
  if (name === 'localhost' || name.endsWith('.localhost')) {
    throw new EgressError(notPublic(url.hostname, 'loopback'));
  }

  if (net.isIP(host)) {
    const range = blockedRange(host);
    if (range) throw new EgressError(notPublic(host, range));
  }

  return url;
}

/**
 * A `lookup` for http.Agent and net.connect that only ever yields addresses it
 * has checked.
 *
 * The whole target is rejected if ANY resolved address is internal. Keeping
 * just the public ones would still let a mixed answer through on whichever
 * address the client falls back to.
 *
 * @param {Function} [dnsLookup] dns.lookup-compatible resolver. Injectable so
 *   tests can simulate rebinding without a DNS server.
 */
export function guardedLookup(dnsLookup = dns.lookup) {
  return function lookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (privateTargetsAllowed()) return dnsLookup(hostname, options, callback);

    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);

      const list = Array.isArray(addresses)
        ? addresses
        : [{ address: addresses, family: net.isIP(addresses) }];

      for (const { address } of list) {
        const range = blockedRange(address);
        if (range) {
          return callback(
            new EgressError(resolvesTo(hostname, address, range))
          );
        }
      }

      if (list.length === 0) {
        const empty = new Error(`${hostname} did not resolve to any address`);
        empty.code = 'ENOTFOUND';
        return callback(empty);
      }

      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

/**
 * A fresh agent whose sockets can only reach addresses guardedLookup approved.
 * One per request, like `agent: false`, so nothing is pooled or reused.
 */
export function egressAgent(protocol, { dnsLookup, ...options } = {}) {
  const Agent = protocol === 'https:' ? https.Agent : http.Agent;
  return new Agent({ ...options, lookup: guardedLookup(dnsLookup) });
}

/**
 * Everything the connect-time guard checks, run ahead of time so the API can
 * refuse an internal target with a 400 when it is saved.
 *
 * A name that does not resolve (or resolves too slowly) is let through: it may
 * be a monitor for a host that is down right now, which is exactly what
 * WatchTower is for. The connect-time guard still judges whatever it resolves
 * to later.
 */
export async function assertPublicUrl(
  target,
  { protocols = HTTP_PROTOCOLS, dnsLookup = dns.lookup, timeoutMs = 3_000 } = {}
) {
  const url = checkUrl(target, { protocols });
  const host = bareHost(url);
  if (privateTargetsAllowed() || net.isIP(host)) return url;

  const lookup = guardedLookup(dnsLookup);
  const err = await new Promise((done) => {
    const timer = setTimeout(() => done(null), timeoutMs);
    lookup(host, { all: true }, (lookupErr) => {
      clearTimeout(timer);
      done(lookupErr);
    });
  });

  if (err instanceof EgressError) throw err;
  return url;
}

export default {
  HTTP_PROTOCOLS,
  EgressError,
  blockedRange,
  checkUrl,
  guardedLookup,
  egressAgent,
  assertPublicUrl,
  privateTargetsAllowed,
};
