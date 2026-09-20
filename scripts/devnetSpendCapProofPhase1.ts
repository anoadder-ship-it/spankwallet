import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Spankwallet } from "../target/types/spankwallet";
import {
  generateTestPasskey,
  buildExpectedChallenge,
  signTestChallenge,
  buildSecp256r1Instruction,
  encodeOptionalI64,
  fetchActionNonce,
  nonceLeBytes,
} from "../tests/webauthnTestHelper";

// Live functionele proef van het spend-cap-mechanisme tegen het ECHTE,
// canonieke, nu-geüpgradede devnet-programma (STATUS.md sectie 148's
// vervolgvraag: "structureel live" -> "functioneel bevestigd live").
// Zelfde stijl/discipline als devnetPostUpgradeProof.ts (echte devnet-tx's,
// geen localnet), maar in TWEE fases omdat finalize_threshold_change de
// ECHTE 24u-timelock afdwingt op dit (production-)binary - geen
// test-fast-pending-timelock-feature aanwezig (verified: instructions.rs
// #[cfg(not(feature = "test-fast-pending-timelock"))] const
// PENDING_ACTION_TIMELOCK_SECONDS: i64 = 24*60*60, en dit is exact de
// HEAD-build, STATUS.md sectie 148 punt 1).
//
// Fase 1 (dit bestand): verse wallet aanmaken, drempel-fail-safe-default
// bevestigen, vault klein funden, initiate_threshold_change versturen, en
// alle benodigde geheime testmaterial (passkey privkey, backup-authority
// keypair, PDA's, drempel/cap-waarden, initiatedAt) wegschrijven naar
// ~/.config/spankwallet/ (buiten git, zelfde conventie als
// program-keypairs/ - nooit secrets committen). Fase 2
// (devnetSpendCapProofPhase2.ts) laadt dit bestand terug zodra de 24u
// verstreken zijn en rondt finalize + de instant-threshold/spend-window-
// tests af.
//
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/id.json \
//     node_modules/.bin/ts-node --transpile-only scripts/devnetSpendCapProofPhase1.ts

const STATE_DIR = path.join(os.homedir(), ".config/spankwallet");
const STATE_FILE = path.join(STATE_DIR, "devnet-spend-cap-test-state.json");

const THRESHOLD_LAMPORTS = 5_000_000; // 0.005 SOL - klein, instant-drempel
const WINDOW_CAP_LAMPORTS = 12_000_000; // 0.012 SOL - glijdende-vensterlimiet
const VAULT_FUND_LAMPORTS = 30_000_000; // 0.03 SOL - klein bedrag, ruim genoeg voor alle testtransacties in fase 2

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Spankwallet as Program<Spankwallet>;

  console.log("RPC endpoint:", (provider.connection as any)._rpcEndpoint);
  console.log("program ID (uit IDL):", program.programId.toBase58());
  console.log("fee-payer:", provider.wallet.publicKey.toBase58());

  function derivePdas(compressedPublicKey: Buffer) {
    const seedHash = createHash("sha256").update(compressedPublicKey).digest();
    const [walletPda] = PublicKey.findProgramAddressSync([Buffer.from("wallet"), seedHash], program.programId);
    const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), walletPda.toBuffer()], program.programId);
    const [passkeysPda] = PublicKey.findProgramAddressSync([Buffer.from("passkeys"), walletPda.toBuffer()], program.programId);
    const [policyPda] = PublicKey.findProgramAddressSync([Buffer.from("policy"), walletPda.toBuffer()], program.programId);
    const [pendingActionPda] = PublicKey.findProgramAddressSync([Buffer.from("pending_action"), walletPda.toBuffer()], program.programId);
    const [spendWindowPda] = PublicKey.findProgramAddressSync([Buffer.from("spend_window"), walletPda.toBuffer()], program.programId);
    return { walletPda, vaultPda, passkeysPda, policyPda, pendingActionPda, spendWindowPda, walletSeedHash: Array.from(seedHash) };
  }

  // ---------- 1. init_wallet (verse wallet, canoniek programma) ----------
  console.log("\n=== 1. init_wallet (verse wallet) ===");
  const passkey = generateTestPasskey();
  const backupAuthority = Keypair.generate();
  const pdas = derivePdas(passkey.compressedPublicKey);
  console.log("walletPda:", pdas.walletPda.toBase58());
  console.log("vaultPda:", pdas.vaultPda.toBase58());

  const initPayload = Buffer.concat([backupAuthority.publicKey.toBuffer(), encodeOptionalI64(null)]);
  const initChallenge = buildExpectedChallenge(program.programId, pdas.walletPda, "init_wallet", initPayload);
  const initSigned = signTestChallenge(passkey, initChallenge);
  const initSecpIx = buildSecp256r1Instruction(passkey.compressedPublicKey, initSigned.signedMessage, initSigned.rawSignature);

  const initSig = await program.methods
    .initWallet(Array.from(passkey.compressedPublicKey), pdas.walletSeedHash, backupAuthority.publicKey, null, initSigned.clientDataJSON)
    .accounts({
      wallet: pdas.walletPda,
      vault: pdas.vaultPda,
      payer: provider.wallet.publicKey,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([initSecpIx])
    .rpc();
  console.log("init_wallet OK, sig:", initSig);

  // ---------- Testpunt 1 (gebruikersvraag): 256-byte-laag + fail-safe default, DIRECT na aanmaak ----------
  console.log("\n=== Testpunt 1: 256-byte-laag + spend_threshold_lamports=0 fail-safe default ===");
  const walletAccountInfo = await provider.connection.getAccountInfo(pdas.walletPda, "confirmed");
  const decoded = await program.account.walletAccount.fetch(pdas.walletPda);
  console.log("dataLen:", walletAccountInfo!.data.length, "(verwacht 256)");
  console.log("spend_threshold_lamports:", decoded.spendThresholdLamports.toString(), "(verwacht 0)");
  console.log("disarmed:", decoded.disarmed, "(verwacht false)");
  const testpunt1Ok =
    walletAccountInfo!.data.length === 256 &&
    decoded.spendThresholdLamports.toString() === "0" &&
    decoded.disarmed === false;
  console.log("Testpunt 1 GESLAAGD:", testpunt1Ok);
  if (!testpunt1Ok) {
    throw new Error("Testpunt 1 (fail-safe default direct na aanmaak) FAALDE - stoppen, niet verder gaan met echte fondsen.");
  }

  // ---------- Vault klein funden ----------
  console.log("\n=== Vault funden ===");
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: pdas.vaultPda,
        lamports: VAULT_FUND_LAMPORTS,
      })
    )
  );
  const vaultBalanceAfterFund = await provider.connection.getBalance(pdas.vaultPda);
  console.log(`vault gefund met ${VAULT_FUND_LAMPORTS} lamports - balans nu: ${vaultBalanceAfterFund}`);

  // ---------- 2 (initiate-helft): initiate_threshold_change ----------
  console.log("\n=== 2. initiate_threshold_change (drempel=" + THRESHOLD_LAMPORTS + ", windowCap=" + WINDOW_CAP_LAMPORTS + ") ===");
  const nonceForThreshold = await fetchActionNonce(provider.connection, pdas.walletPda);
  const thresholdPayload = Buffer.concat([
    nonceLeBytes(nonceForThreshold),
    new BN(THRESHOLD_LAMPORTS).toArrayLike(Buffer, "le", 8),
    new BN(WINDOW_CAP_LAMPORTS).toArrayLike(Buffer, "le", 8),
  ]);
  const thresholdChallenge = buildExpectedChallenge(program.programId, pdas.walletPda, "initiate_threshold_change", thresholdPayload);
  const thresholdSigned = signTestChallenge(passkey, thresholdChallenge);
  const thresholdSecpIx = buildSecp256r1Instruction(passkey.compressedPublicKey, thresholdSigned.signedMessage, thresholdSigned.rawSignature);

  const initiateSig = await program.methods
    .initiateThresholdChange(new BN(THRESHOLD_LAMPORTS), new BN(WINDOW_CAP_LAMPORTS), new BN(nonceForThreshold.toString()), thresholdSigned.clientDataJSON)
    .accounts({
      wallet: pdas.walletPda,
      pendingAction: pdas.pendingActionPda,
      passkeys: pdas.passkeysPda,
      payer: provider.wallet.publicKey,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([thresholdSecpIx])
    .rpc();
  console.log("initiate_threshold_change OK, sig:", initiateSig);

  const pendingAction = await program.account.pendingAction.fetch(pdas.pendingActionPda);
  console.log("pendingAction.kind:", pendingAction.kind, "(verwacht 3 = ThresholdChange)");
  console.log("pendingAction.initiatedAt:", pendingAction.initiatedAt.toString());
  const initiatedAt = pendingAction.initiatedAt.toNumber();
  const earliestFinalizeUnix = initiatedAt + 24 * 60 * 60;
  console.log("vroegst finaliseerbaar (unix):", earliestFinalizeUnix, "=", new Date(earliestFinalizeUnix * 1000).toISOString());

  // ---------- Testmateriaal wegschrijven (buiten git, zelfde conventie als program-keypairs/) ----------
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  const state = {
    createdAtUtc: new Date().toISOString(),
    programId: program.programId.toBase58(),
    rpcEndpoint: (provider.connection as any)._rpcEndpoint,
    passkeyPrivateKeyHex: Buffer.from(passkey.privateKey).toString("hex"),
    backupAuthoritySecretKey: Array.from(backupAuthority.secretKey),
    walletPda: pdas.walletPda.toBase58(),
    vaultPda: pdas.vaultPda.toBase58(),
    passkeysPda: pdas.passkeysPda.toBase58(),
    policyPda: pdas.policyPda.toBase58(),
    pendingActionPda: pdas.pendingActionPda.toBase58(),
    spendWindowPda: pdas.spendWindowPda.toBase58(),
    walletSeedHash: pdas.walletSeedHash,
    thresholdLamports: THRESHOLD_LAMPORTS,
    windowCapLamports: WINDOW_CAP_LAMPORTS,
    initiateSig,
    initiatedAt,
    earliestFinalizeUnix,
    initWalletSig: initSig,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log("\nTestmateriaal weggeschreven naar:", STATE_FILE);
  console.log("\n=== FASE 1 KLAAR ===");
  console.log(`Fase 2 (finalize_threshold_change + de instant-drempel/spend-window-tests) kan pas na ${new Date(earliestFinalizeUnix * 1000).toISOString()} (echte 24u-timelock, niet te versnellen tegen dit binary).`);
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
