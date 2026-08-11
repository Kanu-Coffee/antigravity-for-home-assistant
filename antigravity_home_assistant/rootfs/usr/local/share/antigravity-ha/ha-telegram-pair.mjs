import {
  createPairing,
  listPairings,
  revokePairing,
} from "/usr/local/share/antigravity-ha/telegram-pairing.mjs";

function usage() {
  console.error("Usage: ha-telegram-pair create [--ttl 5m] | list | revoke AUTHORIZATION_ID");
}

function parseTtl(value) {
  const match = /^(\d+)(s|m)$/.exec(value ?? "");
  if (!match) throw new Error("TTL must use seconds or minutes, for example 30s or 5m");
  const multiplier = match[2] === "m" ? 60_000 : 1_000;
  return Number.parseInt(match[1], 10) * multiplier;
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === "create") {
    let ttlMs = 5 * 60 * 1000;
    if (args.length > 0) {
      if (args.length !== 2 || args[0] !== "--ttl") throw new Error("invalid create arguments");
      ttlMs = parseTtl(args[1]);
    }
    const pairing = createPairing({ ttlMs });
    console.log(pairing.token);
    console.error(
      `Pairing token expires at ${new Date(pairing.expiresAt).toISOString()} and is shown only once.`,
    );
    return;
  }
  if (command === "list" && args.length === 0) {
    console.log(JSON.stringify(listPairings(), null, 2));
    return;
  }
  if (command === "revoke" && args.length === 1) {
    if (!revokePairing(args[0])) {
      console.error("Authorization was not found.");
      process.exitCode = 1;
    }
    return;
  }
  usage();
  process.exitCode = 64;
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
