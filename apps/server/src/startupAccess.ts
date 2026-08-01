import * as NodeOS from "node:os";

import { QrCode } from "@t3tools/shared/qrCode";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/unstable/http";

import { ServerConfig } from "./config.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";

export interface HeadlessServeAccessInfo {
  readonly connectionString: string;
  readonly token: string;
  readonly pairingUrl: string;
}

type NetworkInterfacesMap = ReturnType<typeof NodeOS.networkInterfaces>;

export const isLoopbackHost = (host: string | undefined): boolean => {
  if (!host || host.length === 0) {
    return true;
  }

  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
};

export const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

export const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

const normalizeHost = (host: string): string =>
  host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

const isIpv4Family = (family: string | number): boolean => family === "IPv4" || family === 4;

const isIpv6Family = (family: string | number): boolean => family === "IPv6" || family === 6;

export const resolveHeadlessConnectionHost = (
  host: string | undefined,
  interfaces: NetworkInterfacesMap = NodeOS.networkInterfaces(),
): string => {
  if (!host) {
    return "localhost";
  }

  if (!isWildcardHost(host)) {
    return normalizeHost(host);
  }

  const interfaceEntries = Object.values(interfaces).flatMap((entries) => entries ?? []);
  const externalIpv4 = interfaceEntries.find(
    (entry) => !entry.internal && isIpv4Family(entry.family),
  );
  if (externalIpv4) {
    return externalIpv4.address;
  }

  const externalIpv6 = interfaceEntries.find(
    (entry) => !entry.internal && isIpv6Family(entry.family),
  );
  return externalIpv6 ? normalizeHost(externalIpv6.address) : "localhost";
};

export const resolveHeadlessConnectionString = (
  host: string | undefined,
  port: number,
  interfaces: NetworkInterfacesMap = NodeOS.networkInterfaces(),
): string => {
  const connectionHost = resolveHeadlessConnectionHost(host, interfaces);
  return `http://${formatHostForUrl(connectionHost)}:${port}`;
};

/**
 * Candidate URLs at which OTHER machines might reach this server —
 * best-effort self-advertisement for the roaming reverse attach half
 * (M5.6). Only URLs the socket actually listens on AND that can mean
 * anything to a peer: a specific non-loopback bind advertises exactly
 * that address; a wildcard bind advertises every external IPv4 interface
 * (LAN and tailnet addresses).
 *
 * Loopback is NEVER advertised. `127.0.0.1` does not name this machine to
 * anyone else — it names the READER's own server, which on a default port
 * is a live T3 backend that answers happily as the wrong environment
 * (2026-07-31 field bug: the peer's client attached to itself and showed
 * a permanent identity-mismatch row). An empty result is the honest
 * answer for a loopback-only server: the caller skips the reverse half
 * rather than advertise a lie.
 */
export const advertisedBaseUrls = (
  host: string | undefined,
  port: number,
  interfaces: NetworkInterfacesMap = NodeOS.networkInterfaces(),
): ReadonlyArray<string> => {
  if (host !== undefined && host.length > 0 && !isWildcardHost(host)) {
    return isLoopbackHost(host) ? [] : [`http://${formatHostForUrl(host)}:${port}`];
  }
  if (!isWildcardHost(host)) {
    return [];
  }
  return [
    ...new Set(
      Object.values(interfaces)
        .flatMap((entries) => entries ?? [])
        .filter((entry) => !entry.internal && isIpv4Family(entry.family))
        .map((entry) => `http://${entry.address}:${port}`),
    ),
  ];
};

export const resolveListeningPort = (address: unknown, fallbackPort: number): number => {
  if (
    typeof address === "object" &&
    address !== null &&
    "port" in address &&
    typeof address.port === "number"
  ) {
    return address.port;
  }
  return fallbackPort;
};

export const buildPairingUrl = (connectionString: string, token: string): string => {
  const url = new URL(connectionString);
  url.pathname = "/pair";
  url.searchParams.delete("token");
  url.hash = new URLSearchParams([["token", token]]).toString();
  return url.toString();
};

export const renderTerminalQrCode = (value: string, margin = 2): string => {
  const qrCode = QrCode.encodeText(value, QrCode.Ecc.MEDIUM);
  const rows: Array<string> = [];
  const isDark = (x: number, y: number): boolean =>
    x >= 0 && x < qrCode.size && y >= 0 && y < qrCode.size && qrCode.getModule(x, y);

  for (let y = -margin; y < qrCode.size + margin; y += 2) {
    let row = "";

    for (let x = -margin; x < qrCode.size + margin; x += 1) {
      const topDark = isDark(x, y);
      const bottomDark = isDark(x, y + 1);

      row += topDark ? (bottomDark ? "█" : "▀") : bottomDark ? "▄" : " ";
    }

    rows.push(row);
  }

  return rows.join("\n");
};

export const formatHeadlessServeOutput = (accessInfo: HeadlessServeAccessInfo): string =>
  [
    "T3 Code server is ready.",
    `Connection string: ${accessInfo.connectionString}`,
    `Token: ${accessInfo.token}`,
    `Pairing URL: ${accessInfo.pairingUrl}`,
    "",
    renderTerminalQrCode(accessInfo.pairingUrl),
    "",
  ].join("\n");

export const issueHeadlessServeAccessInfo = Effect.fn("issueHeadlessServeAccessInfo")(function* () {
  const serverConfig = yield* ServerConfig;
  const httpServer = yield* HttpServer.HttpServer;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const connectionString = resolveHeadlessConnectionString(
    serverConfig.host,
    resolveListeningPort(httpServer.address, serverConfig.port),
  );
  const issued = yield* serverAuth.issueStartupPairingCredential();

  return {
    connectionString,
    token: issued.credential,
    pairingUrl: buildPairingUrl(connectionString, issued.credential),
  } satisfies HeadlessServeAccessInfo;
});
