import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// STATUS.md sectie 145 (multisig-voorstel: structurele fix van het
// tussenvenster). Empirisch vastgesteld, tegen een lokale validator met
// devnet's eigen, gekloonde feature-set (niet aangenomen):
//
// 1. Eén transactie met [Upgrade-instructie, invoke-op-net-geupgraded-
//    programma] FAALT ALTIJD - de invoke wordt op loader-niveau geweigerd
//    ("Program is not deployed"/UnsupportedProgramId), voordat het
//    programma's eigen code draait. Omdat Solana-transacties atomisch zijn
//    rolt dat de HELE transactie terug, inclusief de Upgrade zelf - een
//    voorstel dat de upgrade en migrate_wallet_account in EEN
//    Squads-transactie zou bundelen, zou dus de upgrade LATEN MISLUKKEN,
//    niet alleen de migratie.
// 2. Een APARTE, opvolgende transactie werkt wel, en snel: met een reeds
//    actieve `onAccountChange`-subscriptie op de ProgramData-account (dus
//    VOORDAT de upgrade landt), vuurt de subscription binnen enkele ms na
//    bevestiging van de upgrade-transactie, en is een opvolgende aanroep
//    op het nieuwe programma zelf al binnen ~1 slot (~400-500ms) bevestigd.
//
// Dit script MOET dus al draaien VOORDAT de upgrade-transactie wordt
// uitgevoerd (niet erna gestart worden) - het is de vervanging van "een
// mens die na bevestiging handmatig een script start" uit het oorspronkelijke
// voorstel. Het dekt UITSLUITEND de twee al bekende, corrupte wallets
// (3Ape3ge72.../FSGNLavhz...) - de reden om precies deze twee met voorrang
// te behandelen, i.p.v. alle 17, is dat dit de enige twee zijn waarvan al
// vaststaat dat elke instructie erop faalt zolang ze niet gemigreerd zijn
// (sectie 141). De volledige batch voor alle 17 (inclusief deze twee,
// onschadelijk dubbel dankzij de dubbele-migratie-guard) blijft
// scripts/migrateAllWalletAccounts.ts, niet urgent, geen watcher nodig.
//
// TERUGVALPLAN als dit script om wat voor reden dan ook niet draait op het
// moment van uitvoering (proces gecrasht, laptop offline, netwerk weg):
// geen enkele verslechtering t.o.v. de bestaande situatie - de twee wallets
// falen dan gewoon door op exact dezelfde manier als nu (AccountDidNot
// Deserialize), totdat iemand scripts/migrateAllWalletAccounts.ts handmatig
// draait, zoals in het oorspronkelijke voorstel. Dit script is dus een
// STRIKTE verbetering (kleiner venster als het draait), geen nieuwe
// afhankelijkheid die het zonder erger maakt als het faalt.
//
// Gebruik: start dit script RUIM voordat de multisig-uitvoerder op
// "Execute" klikt, en laat het draaien totdat de logs een resultaat voor
// beide wallets tonen (of totdat de upgrade-approve-fase is afgebroken).
//   node_modules/.bin/ts-node --transpile-only scripts/watchUpgradeAndMigrateCriticalWallets.ts

const PROGRAM_ID = new PublicKey("9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9");
const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const DEVNET_URL = "https://api.devnet.solana.com";

// Sectie 141/143: de twee bekende wallets die falen te deserialiseren zolang
// ze niet gemigreerd zijn. Zelfde adressen als in STATUS.md, nogmaals hier
// als losse constanten (geen import vanuit een ander script) zodat dit
// bestand op zichzelf leesbaar/verifieerbaar blijft voor wie het voorstel
// beoordeelt.
const CRITICAL_WALLETS = [
  new PublicKey("3Ape3ge72RkvvnNAfGSww4TwUs8PYfhfxUSU2Bk55pRQ"),
  new PublicKey("FSGNLavhzEvCtk948Y3jEFw2hEgV7GvPQnutp5ZnKs2R"),
];

const MAX_ATTEMPTS_PER_WALLET = 8;
const RETRY_DELAY_MS = 750;

function ixDisc(name: string): Buffer {
  return createHash("sha256").update("global:" + name).digest().slice(0, 8);
}

async function migrateOne(
  connection: Connection,
  payer: Keypair,
  wallet: PublicKey,
  label: string
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_WALLET; attempt++) {
    try {
      const before = await connection.getAccountInfo(wallet, "confirmed");
      if (before && before.data.length === 256) {
        console.log(`  [${label}] al gemigreerd (256 bytes) - niets te doen.`);
        return;
      }

      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: wallet, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: ixDisc("migrate_wallet_account"),
      });
      const tx = new Transaction().add(ix);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = payer.publicKey;
      tx.sign(payer);

      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      const after = await connection.getAccountInfo(wallet, "confirmed");
      if (!after || after.data.length !== 256) {
        throw new Error(`na de transactie is dataLen ${after ? after.data.length : "account bestaat niet meer"}, verwacht 256`);
      }
      console.log(`  [${label}] GEMIGREERD op poging ${attempt}. sig: ${sig}`);
      return;
    } catch (e: any) {
      console.log(`  [${label}] poging ${attempt}/${MAX_ATTEMPTS_PER_WALLET} faalde: ${e?.message ?? String(e)}`);
      if (attempt < MAX_ATTEMPTS_PER_WALLET) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
  console.log(`  [${label}] NIET gelukt binnen ${MAX_ATTEMPTS_PER_WALLET} pogingen - handmatige interventie nodig (scripts/migrateAllWalletAccounts.ts).`);
}

async function main() {
  const connection = new Connection(DEVNET_URL, "confirmed");
  const wsConnection = new Connection(DEVNET_URL, "confirmed");

  const keypairPath = path.join(os.homedir(), ".config/solana/id.json");
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  console.log("payer (fee-payer + rent-topup):", payer.publicKey.toBase58());

  const [programDataAddress] = PublicKey.findProgramAddressSync(
    [PROGRAM_ID.toBuffer()],
    BPF_LOADER_UPGRADEABLE
  );
  console.log("bewaakt ProgramData-account:", programDataAddress.toBase58());

  const before = await connection.getAccountInfo(programDataAddress);
  console.log("ProgramData huidige lengte (referentiepunt vóór upgrade):", before?.data.length);

  let fired = false;

  console.log("\n=== GEARMD - wacht op de upgrade-bevestiging. Laat dit proces draaien tot de multisig-uitvoerder op Execute heeft geklikt. ===\n");

  const subId = wsConnection.onAccountChange(
    programDataAddress,
    async (_info, ctx) => {
      if (fired) return; // slot-updates kunnen meerdere keren vuren; alleen de eerste triggert
      fired = true;
      console.log(`\n[TRIGGER] ProgramData gewijzigd in slot ${ctx.slot} om ${new Date().toISOString()} - upgrade is live. Migratie van de twee kritieke wallets start nu.`);

      await Promise.all(
        CRITICAL_WALLETS.map((w, i) => migrateOne(connection, payer, w, `wallet ${i + 1}/${CRITICAL_WALLETS.length} ${w.toBase58()}`))
      );

      console.log("\n=== Klaar. Dit dekt uitsluitend de twee kritieke wallets - draai scripts/migrateAllWalletAccounts.ts voor de resterende 15, niet urgent. ===");
      wsConnection.removeAccountChangeListener(subId);
      (wsConnection as any)?._rpcWebSocket?.close();
      process.exit(0);
    },
    "confirmed"
  );

  // Heartbeat, zodat de operator visueel kan bevestigen dat dit proces nog
  // leeft en niet stil is gecrasht terwijl er op de multisig-uitvoering
  // gewacht wordt.
  setInterval(() => {
    if (!fired) console.log(`[heartbeat ${new Date().toISOString()}] nog gearmd, nog geen upgrade gedetecteerd.`);
  }, 60000);
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
