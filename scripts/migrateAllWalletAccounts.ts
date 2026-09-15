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

// STATUS.md sectie 144 (multisig-voorstel-voorbereiding, stap 2): voert
// migrate_wallet_account permissionless uit tegen ELK bestaand
// WalletAccount dat nog niet 256 bytes is (dus nog niet gemigreerd),
// onmiddellijk na de upgrade-executie - dit is precies de stap die STATUS.md
// sectie 142 als harde voorwaarde stelde ("niet als losse follow-up die
// 'later wel eens' gebeurt"). Zelfde stijl als scripts/closeExpiredSessions.ts
// (geen Anchor Program/IDL-object nodig, alleen de instructiediscriminator
// handmatig berekend - deze instructie heeft GEEN argumenten).
//
// PERMISSIONLESS, zoals close_expired_session: de payer betaalt uitsluitend
// de kleine, eenmalige rent-toename (oud: 231/239/247 bytes -> nieuw: 256)
// plus de transactiekosten - geen waardeoverdracht, geen autorisatiewijziging.
// Elk account is onafhankelijk; de volgorde hieronder (alfabetisch op pubkey)
// is uitsluitend voor een reproduceerbare log, niet functioneel vereist.
//
// De action_nonce/session_epoch-uitzondering voor 3Ape3ge72... zit AL in de
// on-chain instructie zelf (instructions.rs, WALLET_WITH_STALE_ACTION_NONCE_
// AND_SESSION_EPOCH) - dit script behandelt elk account uniform, geen
// speciale per-adres-logica hier nodig.
//
// NIET DRAAIEN VOORDAT DE UPGRADE LIVE IS: migrate_wallet_account bestaat
// nog niet op het canonieke, momenteel gedeployde devnet-programma - alleen
// in de buffer die klaarstaat voor het voorstel. Draaien vóór de upgrade
// live is faalt gewoon (instructie onbekend), maar is voor de duidelijkheid
// hier expliciet vermeld i.p.v. stilzwijgend aangenomen.
//
// Gebruik (PAS NA bevestigde upgrade-executie):
//   node_modules/.bin/ts-node --transpile-only scripts/migrateAllWalletAccounts.ts

const PROGRAM_ID = new PublicKey("9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9");
const NEW_WALLET_ACCOUNT_LEN = 256;

function accountDisc(name: string): Buffer {
  return createHash("sha256").update("account:" + name).digest().slice(0, 8);
}
function ixDisc(name: string): Buffer {
  return createHash("sha256").update("global:" + name).digest().slice(0, 8);
}

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const bs58 = (await import("bs58")).default;

  const keypairPath = path.join(os.homedir(), ".config/solana/id.json");
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  console.log("payer (fee-payer + rent-topup):", payer.publicKey.toBase58());

  const all = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(accountDisc("WalletAccount")) } }],
  });
  console.log(`Gevonden: ${all.length} WalletAccount-discriminator-account(s) totaal.`);

  const toMigrate = all
    .filter(({ account }) => account.data.length !== NEW_WALLET_ACCOUNT_LEN)
    .sort((a, b) => a.pubkey.toBase58().localeCompare(b.pubkey.toBase58()));
  const alreadyMigrated = all.length - toMigrate.length;
  console.log(`Al op ${NEW_WALLET_ACCOUNT_LEN} bytes (overgeslagen): ${alreadyMigrated}`);
  console.log(`Te migreren: ${toMigrate.length}\n`);

  let ok = 0;
  let failed = 0;

  for (const { pubkey, account } of toMigrate) {
    const before = account.data.length;
    console.log("---");
    console.log("wallet:", pubkey.toBase58(), " dataLen vóór:", before);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: ixDisc("migrate_wallet_account"),
    });

    const tx = new Transaction().add(ix);
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(payer);

    try {
      const sig = await connection.sendRawTransaction(tx.serialize());
      await connection.confirmTransaction(sig, "confirmed");
      const after = await connection.getAccountInfo(pubkey, "confirmed");
      if (!after || after.data.length !== NEW_WALLET_ACCOUNT_LEN) {
        throw new Error(
          `na de transactie is dataLen ${after ? after.data.length : "account bestaat niet meer"}, verwacht ${NEW_WALLET_ACCOUNT_LEN}`
        );
      }
      console.log("  GEMIGREERD. sig:", sig, " dataLen na:", after.data.length);
      ok++;
    } catch (e: any) {
      console.log("  FOUT bij migreren:", e?.message ?? String(e));
      failed++;
    }
  }

  console.log("\n=== Nameting ===");
  const afterAll = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(accountDisc("WalletAccount")) } }],
  });
  const stillNotMigrated = afterAll.filter((a) => a.account.data.length !== NEW_WALLET_ACCOUNT_LEN);
  console.log(`Totaal WalletAccount-accounts: ${afterAll.length}`);
  console.log(`Nog NIET op ${NEW_WALLET_ACCOUNT_LEN} bytes: ${stillNotMigrated.length}`);
  for (const { pubkey, account } of stillNotMigrated) {
    console.log("  nog niet gemigreerd:", pubkey.toBase58(), " dataLen:", account.data.length);
  }
  console.log(`\nDeze run: ${ok} geslaagd, ${failed} gefaald (van ${toMigrate.length} pogingen).`);
  if (failed > 0 || stillNotMigrated.length > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
