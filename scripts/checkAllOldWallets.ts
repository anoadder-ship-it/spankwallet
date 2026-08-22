import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import type { Spankwallet } from "../target/types/spankwallet";

// Leesalleen: haalt elk bestaand WalletAccount op devnet op en probeert het
// te decoderen tegen de HUIDIGE (net gebouwde) IDL - bedoeld om vóór elke
// toekomstige upgrade opnieuw te controleren of oudere-layout-accounts
// daadwerkelijk schoon falen, in plaats van de native cargo-unittests
// (die een niet-representatief Some/Some-synthetisch geval testen, zie
// STATUS.md sectie 80) blind te vertrouwen. Stuurt geen transacties, geen
// fee-payer-kosten. Draaien:
//
//   ANCHOR_PROVIDER_URL=<devnet-rpc-url> ANCHOR_WALLET=~/.config/solana/id.json \
//     node_modules/.bin/ts-node --transpile-only scripts/checkAllOldWallets.ts
async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Spankwallet as Program<Spankwallet>;

  const disc = Buffer.from([158, 98, 171, 153, 212, 64, 242, 213]);
  const bs58mod = await import("bs58");
  const bs58 = (bs58mod as any).default ?? bs58mod;
  const existing = await provider.connection.getProgramAccounts(program.programId, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
  });
  console.log("totaal bestaande WalletAccount-accounts:", existing.length);

  for (const { pubkey, account } of existing) {
    const data = account.data;
    // ruwe bytes op de plek waar action_nonce nu gelezen zou worden, zelf
    // berekend (zelfde offset-logica als webauthnTestHelper.ts::actionNonceOffset),
    // los van de Anchor-decode, om te zien wat er ECHT in die bytes staat.
    let offset = 148;
    const recoveryTag = data[offset];
    offset += 1;
    if (recoveryTag === 1) offset += 41;
    offset += 8; // recovery_timelock_seconds
    const depositTag = data[offset];
    offset += 1;
    if (depositTag === 1) offset += 32;
    const actionNonceBytesOffset = offset;
    const rawTailFromMinimal = data.slice(actionNonceBytesOffset); // alles na het "oude" minimale einde

    let decodeOk = true;
    let decoded: any = null;
    let decodeErr = "";
    try {
      decoded = await program.account.walletAccount.fetch(pubkey);
    } catch (e: any) {
      decodeOk = false;
      decodeErr = e?.message ?? String(e);
    }

    console.log("---");
    console.log("pubkey:", pubkey.toBase58(), "dataLen:", data.length);
    console.log("  recovery_state tag:", recoveryTag, "deposit_authority tag:", depositTag);
    console.log("  bytes vanaf minimaal-oude-einde (offset", actionNonceBytesOffset, "), eerste 16 hex:", rawTailFromMinimal.slice(0, 16).toString("hex"));
    console.log("  totale resterende bytes na dat punt:", rawTailFromMinimal.length);
    if (decodeOk) {
      console.log("  Anchor-decode: GESLAAGD (geen fout) - actionNonce:", decoded.actionNonce.toString());
    } else {
      console.log("  Anchor-decode: GEWEIGERD -", decodeErr.slice(0, 200));
    }
  }
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
