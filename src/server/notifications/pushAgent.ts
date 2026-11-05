import "server-only";
import { lookup } from "node:dns/promises";
import { Agent } from "node:https";
import { BlockList, isIP } from "node:net";
import { isWebPushEndpoint } from "@/lib/security/pushEndpoints";

const deniedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) deniedV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const deniedV6 = new BlockList();
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) deniedV6.addSubnet(address, prefix, "ipv6");

export function isPublicPushAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !deniedV4.check(address, "ipv4");
  // This also refuses IPv4-mapped, NAT64, loopback and local IPv6 addresses.
  return family === 6 && globalV6.check(address, "ipv6") && !deniedV6.check(address, "ipv6");
}

/** Validate all DNS answers, then pin the socket lookup to those answers. */
export async function webPushAgent(endpoint: string): Promise<Agent> {
  if (!isWebPushEndpoint(endpoint)) throw new Error("Invalid push endpoint");
  const hostname = new URL(endpoint).hostname;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answers = await Promise.race([
    lookup(hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Push DNS lookup timed out")), 10_000);
      timer.unref();
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  if (!answers.length || answers.some((a) => !isPublicPushAddress(a.address) || isIP(a.address) !== a.family)) throw new Error("Unsafe push DNS answer");
  return new Agent({
    keepAlive: false,
    lookup(host, options, callback) {
      if (host !== hostname) return callback(new Error("Unexpected push host"), "", 0);
      const family = typeof options === "number" ? options : options.family;
      const eligible = answers.filter((a) => !family || a.family === family);
      if (!eligible.length) return callback(new Error("No public push address for requested family"), "", 0);
      // Node uses this callback shape with all:true for automatic family selection.
      if (typeof options === "object" && options.all) callback(null, eligible);
      else callback(null, eligible[0].address, eligible[0].family);
    },
  });
}
