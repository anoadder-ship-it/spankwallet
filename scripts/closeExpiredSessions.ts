import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Sluit de vijf bestaande, al-verlopen SessionKeyAccounts NU, terwijl ze nog
// gewoon decoderen tegen de HUIDIGE gedeployde layout (421 bytes) -
// permissionless, geen kosten voor de wallet-eigenaren, rent terug naar wie
// het aanroept. Doel: een broze timingsvoorwaarde ("op het moment van een
// toekomstig B2/B3-voorstel bestaan toevallig nul actieve sessies") omzetten
// in een BEREIKTE toestand ("er bestaan nu helemaal geen SessionKeyAccounts
// meer") - zie STATUS.md sectie 85/86. Na een B2/B3-deploy kan dit niet meer:
// Anchor's getypeerde Account<SessionKeyAccount> in close_expired_session
// deserialiseert dan vóór de instructielogica draait, en faalt voor elk
// bestaand (te kort) account.
const PROGRAM_ID = new PublicKey("9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9");

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
  const closer = Keypair.fromSecretKey(Uint8Array.from(secret));
  console.log("closer (fee-payer + rent-ontvanger):", closer.publicKey.toBase58());

  const sessions = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(accountDisc("SessionKeyAccount")) } }],
  });
  console.log(`Gevonden: ${sessions.length} SessionKeyAccount(s) vóór opruiming.\n`);

  const currentSlot = await connection.getSlot("confirmed");
  console.log("huidige slot:", currentSlot, "\n");

  for (const { pubkey, account } of sessions) {
    const data = account.data;
    const wallet = new PublicKey(data.slice(8, 40));
    const sessionKey = new PublicKey(data.slice(40, 72));
    const expirySlot = data.readBigUInt64LE(73);

    console.log("---");
    console.log("session PDA:", pubkey.toBase58());
    console.log("  wallet:", wallet.toBase58(), " sessionKey:", sessionKey.toBase58());
    console.log("  expirySlot:", expirySlot.toString(), " (huidige slot:", currentSlot, ")");

    if (BigInt(currentSlot) <= expirySlot) {
      console.log("  OVERGESLAGEN: nog niet verlopen volgens deze meting - niet sluiten.");
      continue;
    }

    const data_ix = Buffer.concat([ixDisc("close_expired_session"), sessionKey.toBuffer()]);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: wallet, isSigner: false, isWritable: false },
        { pubkey, isSigner: false, isWritable: true },
        { pubkey: closer.publicKey, isSigner: true, isWritable: true },
      ],
      data: data_ix,
    });

    const tx = new Transaction().add(ix);
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = closer.publicKey;
    tx.sign(closer);

    try {
      const sig = await connection.sendRawTransaction(tx.serialize());
      await connection.confirmTransaction(sig, "confirmed");
      console.log("  GESLOTEN. sig:", sig);
    } catch (e: any) {
      console.log("  FOUT bij sluiten:", e?.message ?? String(e));
    }
  }

  console.log("\n=== Nameting ===");
  const after = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(accountDisc("SessionKeyAccount")) } }],
  });
  console.log(`Resterende SessionKeyAccount(s) NA opruiming: ${after.length}`);
  for (const { pubkey } of after) {
    console.log("  nog aanwezig:", pubkey.toBase58());
  }
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
