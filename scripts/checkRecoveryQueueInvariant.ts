import { Connection, PublicKey } from "@solana/web3.js";
import {
  findInvariantViolations,
  decodeWalletForInvariant,
  PENDING_ACTION_DISCRIMINATOR,
  WALLET_ACCOUNT_DISCRIMINATOR,
  ProgramAccountBytes,
} from "./lib/recoveryQueueInvariant";

// Leesalleen: getProgramAccounts + getMultipleAccountsInfo, nooit een
// transactie.
//
// STATUS.md sectie 161: harde voorwaarde in het upgradevoorstel van upgrade 1.
// Sectie 160 laat initiate_recovery de wachtrij sluiten; daardoor geldt "zolang
// recovery_state Some is, is de wachtrij leeg" voor elke recovery die NA de
// upgrade start. Toestand die de oude binary heeft achtergelaten, valt daar
// niet onder en wordt hier gecontroleerd. Draaien:
//   (a) direct vóór het uitvoeren van de upgrade - moet groen zijn;
//   (b) direct ná het uitvoeren - moet opnieuw groen zijn. Tot het laatste
//       moment draait de oude binary, en daaronder overleeft een wachtende
//       actie initiate_recovery nog: (a) alleen dekt het venster tussen (a)
//       en de deploy niet af.
//
// Exit-code: 0 = geen treffers; 1 = minstens één treffer (zie
// scripts/lib/recoveryQueueInvariant.ts voor de betekenis, fail-closed bij
// alles wat niet te verifiëren is); anders = de controle zelf faalde.
//
// Bij een treffer (devnet, testwaarde): cancel_action met een passkey van die
// wallet. cancel_action draagt bewust geen recovery- of disarmed-constraint
// en sluit elke PendingAction, ook een van de oude layout.
//
// De twee RPC-rondes zijn niet atomair: een PendingAction die tussen beide
// ontstaat, ziet dit script pas bij de volgende run. Daarom (a) én (b).
//
//   RPC_URL=https://api.devnet.solana.com npx ts-node --transpile-only scripts/checkRecoveryQueueInvariant.ts

const PROGRAM_ID = new PublicKey("9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9");
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const MULTIPLE_ACCOUNTS_BATCH = 100;

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const program = await connection.getAccountInfo(PROGRAM_ID);
  if (!program || !program.executable) {
    throw new Error(`programma ${PROGRAM_ID.toBase58()} niet gevonden of niet executable op ${RPC_URL}`);
  }

  const pendingResult = await connection.getProgramAccounts(PROGRAM_ID, {
    withContext: true,
    filters: [{ memcmp: { offset: 0, encoding: "base64", bytes: PENDING_ACTION_DISCRIMINATOR.toString("base64") } }],
  });
  const pendingActions: ProgramAccountBytes[] = pendingResult.value.map((a) => ({
    address: a.pubkey.toBase58(),
    data: a.account.data,
    owner: a.account.owner,
  }));

  const walletKeys = [
    ...new Set(pendingActions.filter((p) => p.data.length >= 40).map((p) => new PublicKey(p.data.subarray(8, 40)).toBase58())),
  ].map((k) => new PublicKey(k));
  const walletsByAddress = new Map<string, ProgramAccountBytes | null>();
  for (let i = 0; i < walletKeys.length; i += MULTIPLE_ACCOUNTS_BATCH) {
    const batch = walletKeys.slice(i, i + MULTIPLE_ACCOUNTS_BATCH);
    const infos = await connection.getMultipleAccountsInfo(batch);
    batch.forEach((key, j) => {
      const info = infos[j];
      walletsByAddress.set(key.toBase58(), info ? { address: key.toBase58(), data: info.data, owner: info.owner } : null);
    });
  }

  // Ter informatie (geen treffer): wallets met een lopende recovery. Met een
  // lege wachtrij voldoen die al aan de invariant (sectie 161: 5MoXqg…).
  const walletResult = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, encoding: "base64", bytes: WALLET_ACCOUNT_DISCRIMINATOR.toString("base64") } }],
  });
  const inRecovery = walletResult
    .filter((w) => {
      const d = decodeWalletForInvariant(w.account.data);
      return typeof d !== "string" && d.recoverySome;
    })
    .map((w) => w.pubkey.toBase58());

  const violations = findInvariantViolations(PROGRAM_ID, pendingActions, walletsByAddress);

  console.log(`RPC: ${RPC_URL} (PendingAction-lijst op slot ${pendingResult.context.slot})`);
  console.log(`PendingAction-accounts: ${pendingActions.length}`);
  console.log(`WalletAccounts: ${walletResult.length}, waarvan met lopende recovery: ${inRecovery.length}${inRecovery.length ? " - " + inRecovery.join(", ") : ""}`);
  if (violations.length === 0) {
    console.log("GROEN: geen PendingAction bij een wallet met een lopende recovery, geen afwijkende epoch.");
    return 0;
  }
  console.log(`ROOD: ${violations.length} treffer(s):`);
  for (const v of violations) {
    console.log(`  - pending_action ${v.pendingAction}, wallet ${v.wallet ?? "?"}: ${v.reasons.join(" + ")} (${v.detail})`);
  }
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("Controle mislukt:", err);
    process.exit(2);
  }
);
