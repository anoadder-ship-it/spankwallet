import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  Transaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Spankwallet } from "../target/types/spankwallet";
import {
  buildExpectedChallenge,
  signTestChallenge,
  buildSecp256r1Instruction,
  fetchActionNonce,
  nonceLeBytes,
  TestPasskey,
} from "../tests/webauthnTestHelper";

// Fase 2 van de live spend-cap-functionele-proef (zie
// devnetSpendCapProofPhase1.ts voor de volledige achtergrond/motivatie).
// Laadt het testmateriaal dat fase 1 wegschreef, wacht NIET zelf (roept
// gewoon finalize pas aan als de 24u-timelock daadwerkelijk verstreken is -
// anders on-chain geweigerd, en dat is hier bewust geen doel van de test),
// en voert dan de vier resterende testpunten uit:
//   3. execute ONDER de drempel - moet instant slagen.
//   4. execute BOVEN de drempel - moet AmountExceedsInstantThreshold geven.
//   5. een reeks kleinere, onder-de-drempel executes die samen de
//      glijdende-vensterlimiet (window cap) overschrijden - de laatste moet
//      SpendWindowExceeded geven, ook al is elk individueel bedrag onder de
//      per-transactie-drempel.
//
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/id.json \
//     node_modules/.bin/ts-node --transpile-only scripts/devnetSpendCapProofPhase2.ts

const STATE_FILE = path.join(os.homedir(), ".config/spankwallet", "devnet-spend-cap-test-state.json");

async function main() {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error(`Geen testmateriaal gevonden op ${STATE_FILE} - draai eerst devnetSpendCapProofPhase1.ts.`);
  }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

  const nowUnix = Math.floor(Date.now() / 1000);
  if (nowUnix < state.earliestFinalizeUnix) {
    const remaining = state.earliestFinalizeUnix - nowUnix;
    console.log(`Nog niet zo ver: 24u-timelock verstrijkt pas om ${new Date(state.earliestFinalizeUnix * 1000).toISOString()}.`);
    console.log(`Resterend: ${Math.floor(remaining / 3600)}u ${Math.floor((remaining % 3600) / 60)}m.`);
    console.log("Geen transactie verstuurd - opnieuw draaien zodra de tijd verstreken is.");
    process.exit(2);
  }

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Spankwallet as Program<Spankwallet>;

  console.log("RPC endpoint:", (provider.connection as any)._rpcEndpoint);
  console.log("program ID (uit IDL):", program.programId.toBase58());

  // compressedPublicKey wordt uit de privateKey afgeleid (consistent met generateTestPasskey()),
  // niet los opgeslagen in het statebestand.
  const { p256 } = await import("@noble/curves/p256");
  const privateKey = Uint8Array.from(Buffer.from(state.passkeyPrivateKeyHex, "hex"));
  const passkey: TestPasskey = {
    privateKey,
    compressedPublicKey: Buffer.from(p256.getPublicKey(privateKey, true)),
  };

  const backupAuthority = Keypair.fromSecretKey(Uint8Array.from(state.backupAuthoritySecretKey));
  const walletPda = new PublicKey(state.walletPda);
  const vaultPda = new PublicKey(state.vaultPda);
  const passkeysPda = new PublicKey(state.passkeysPda);
  const pendingActionPda = new PublicKey(state.pendingActionPda);
  const spendWindowPda = new PublicKey(state.spendWindowPda);
  const THRESHOLD = new BN(state.thresholdLamports);
  const WINDOW_CAP = new BN(state.windowCapLamports);

  console.log("walletPda:", walletPda.toBase58());
  console.log("threshold:", THRESHOLD.toString(), " windowCap:", WINDOW_CAP.toString());

  async function callExecute(recipient: PublicKey, amount: BN) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const payload = Buffer.concat([nonceLeBytes(nonce), recipient.toBuffer(), amount.toArrayLike(Buffer, "le", 8)]);
    const challenge = buildExpectedChallenge(program.programId, walletPda, "execute", payload);
    const signed = signTestChallenge(passkey, challenge);
    const secpIx = buildSecp256r1Instruction(passkey.compressedPublicKey, signed.signedMessage, signed.rawSignature);
    return program.methods
      .execute(amount, new BN(nonce.toString()), signed.clientDataJSON)
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        spendWindow: spendWindowPda,
        recipient,
        passkeys: passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([secpIx])
      .rpc();
  }

  const results: Record<string, unknown> = {};

  // ---------- finalize_threshold_change (ECHTE 24u-timelock nu verstreken) ----------
  console.log("\n=== finalize_threshold_change ===");
  const nonceForFinalize = await fetchActionNonce(provider.connection, walletPda);
  const pendingActionBefore = await program.account.pendingAction.fetch(pendingActionPda);
  const commitment = Buffer.from(pendingActionBefore.actionCommitment);
  const finalizePayload = Buffer.concat([nonceLeBytes(nonceForFinalize), pendingActionPda.toBuffer(), commitment]);
  const finalizeChallenge = buildExpectedChallenge(program.programId, walletPda, "finalize_threshold_change", finalizePayload);
  const finalizeSigned = signTestChallenge(passkey, finalizeChallenge);
  const finalizeSecpIx = buildSecp256r1Instruction(passkey.compressedPublicKey, finalizeSigned.signedMessage, finalizeSigned.rawSignature);

  const finalizeSig = await program.methods
    .finalizeThresholdChange(THRESHOLD, WINDOW_CAP, new BN(nonceForFinalize.toString()), finalizeSigned.clientDataJSON)
    .accounts({
      wallet: walletPda,
      spendWindow: spendWindowPda,
      pendingAction: pendingActionPda,
      passkeys: passkeysPda,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      closer: provider.wallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .preInstructions([finalizeSecpIx])
    .rpc();
  console.log("finalize_threshold_change OK, sig:", finalizeSig);
  results.finalize_sig = finalizeSig;

  const walletAfterFinalize = await program.account.walletAccount.fetch(walletPda);
  console.log("wallet.spend_threshold_lamports nu:", walletAfterFinalize.spendThresholdLamports.toString(), "(verwacht", THRESHOLD.toString() + ")");
  results.threshold_set_correctly = walletAfterFinalize.spendThresholdLamports.toString() === THRESHOLD.toString();

  const spendWindowAfterFinalize = await program.account.spendWindow.fetch(spendWindowPda);
  console.log("spendWindow.window_total_cap_lamports:", spendWindowAfterFinalize.windowTotalCapLamports.toString(), "(verwacht", WINDOW_CAP.toString() + ")");
  console.log("spendWindow.spent_lamports_this_window:", spendWindowAfterFinalize.spentLamportsThisWindow.toString(), "(verwacht 0)");
  results.window_cap_set_correctly = spendWindowAfterFinalize.windowTotalCapLamports.toString() === WINDOW_CAP.toString();
  results.window_starts_at_zero = spendWindowAfterFinalize.spentLamportsThisWindow.toString() === "0";

  const pendingActionClosed = await provider.connection.getAccountInfo(pendingActionPda);
  console.log("pendingAction account gesloten na finalize:", pendingActionClosed === null);
  results.pending_action_closed = pendingActionClosed === null;

  // ---------- Testpunt 3: execute ONDER de drempel ----------
  console.log("\n=== Testpunt 3: execute ONDER de drempel (moet instant slagen) ===");
  const underAmount = new BN(3_000_000); // < 5_000_000 drempel
  const recipient3 = Keypair.generate().publicKey;
  const vaultBefore3 = await provider.connection.getBalance(vaultPda);
  const sig3 = await callExecute(recipient3, underAmount);
  const vaultAfter3 = await provider.connection.getBalance(vaultPda);
  console.log("execute OK, sig:", sig3, " vault-delta:", vaultBefore3 - vaultAfter3, "(verwacht", underAmount.toString() + ")");
  results.testpunt3_under_threshold_ok = vaultBefore3 - vaultAfter3 === underAmount.toNumber();

  // ---------- Testpunt 4: execute BOVEN de drempel ----------
  console.log("\n=== Testpunt 4: execute BOVEN de drempel (moet AmountExceedsInstantThreshold geven) ===");
  const overAmount = THRESHOLD.add(new BN(1)); // 5_000_001
  const recipient4 = Keypair.generate().publicKey;
  const vaultBefore4 = await provider.connection.getBalance(vaultPda);
  let over4Ok = false, over4Err = "";
  try {
    await callExecute(recipient4, overAmount);
    over4Ok = true;
  } catch (e: any) {
    over4Err = e?.message ?? String(e);
  }
  const vaultAfter4 = await provider.connection.getBalance(vaultPda);
  console.log("execute boven drempel geslaagd (had NIET gemogen):", over4Ok);
  console.log("bevat AmountExceedsInstantThreshold:", over4Err.includes("AmountExceedsInstantThreshold"));
  console.log("vault ongewijzigd:", vaultBefore4 === vaultAfter4);
  results.testpunt4_over_threshold_correctly_rejected =
    !over4Ok && over4Err.includes("AmountExceedsInstantThreshold") && vaultBefore4 === vaultAfter4;

  // ---------- Testpunt 5: som van onder-de-drempel executes raakt de window cap ----------
  console.log("\n=== Testpunt 5: glijdende-vensterlimiet (window cap) ===");
  // Na testpunt 3 staat de teller al op 3_000_000 (van underAmount hierboven).
  // windowCap = 12_000_000. Nog 3 keer 3_000_000 erbij: 6M, 9M, 12M (exact op de cap, moet nog slagen).
  const step = new BN(3_000_000);
  for (let i = 0; i < 3; i++) {
    const recipient = Keypair.generate().publicKey;
    await callExecute(recipient, step);
    const sw = await program.account.spendWindow.fetch(spendWindowPda);
    console.log(`  exec ${i + 2}/4 (onder drempel, ${step.toString()} lamports): spent_lamports_this_window nu ${sw.spentLamportsThisWindow.toString()}`);
  }
  const spendWindowBeforeOverflow = await program.account.spendWindow.fetch(spendWindowPda);
  console.log("teller vlak vóór de overschrijdende poging:", spendWindowBeforeOverflow.spentLamportsThisWindow.toString(), "(verwacht", WINDOW_CAP.toString(), "= exact op de cap)");
  results.window_cap_reached_exactly = spendWindowBeforeOverflow.spentLamportsThisWindow.toString() === WINDOW_CAP.toString();

  // Nu nog 1 lamport erbij (ruim onder de per-tx-drempel van 5_000_000) - moet SpendWindowExceeded geven.
  const overflowRecipient = Keypair.generate().publicKey;
  const vaultBeforeOverflow = await provider.connection.getBalance(vaultPda);
  let overflowOk = false, overflowErr = "";
  try {
    await callExecute(overflowRecipient, new BN(1));
    overflowOk = true;
  } catch (e: any) {
    overflowErr = e?.message ?? String(e);
  }
  const vaultAfterOverflow = await provider.connection.getBalance(vaultPda);
  const spendWindowAfterOverflow = await program.account.spendWindow.fetch(spendWindowPda);
  console.log("1-lamport-poging boven de cap geslaagd (had NIET gemogen):", overflowOk);
  console.log("bevat SpendWindowExceeded:", overflowErr.includes("SpendWindowExceeded"));
  console.log("vault ongewijzigd:", vaultBeforeOverflow === vaultAfterOverflow);
  console.log("teller ongewijzigd door de weigering:", spendWindowAfterOverflow.spentLamportsThisWindow.toString() === WINDOW_CAP.toString());
  results.testpunt5_window_exceeded_correctly_rejected =
    !overflowOk &&
    overflowErr.includes("SpendWindowExceeded") &&
    vaultBeforeOverflow === vaultAfterOverflow &&
    spendWindowAfterOverflow.spentLamportsThisWindow.toString() === WINDOW_CAP.toString();

  console.log("\n=== SAMENVATTING ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
