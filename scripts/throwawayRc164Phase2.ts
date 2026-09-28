// RC-verificatie deel 2, fase 2 (STATUS.md sectie 164): na de echte 24u-timelock
// finalize_advanced_action op wallet A van het WEGWERP-programma.
//   - finalize door P1 (de bevestiger) moet weigeren met 6048
//     SecondPasskeyMustDifferFromInitiator, zonder staatswijziging;
//   - finalize door P2 moet slagen en de CPI (System-assign) uitvoeren.
//
// Zelfde drie grendels als scripts/throwawayRc163Proof.ts, plus:
// 4. de on-chain klok (Clock-sysvar) moet minstens MARGIN_S voorbij
//    timelock_started_at + 86.400 s zijn, anders wordt er niets verstuurd.
//
// MODE=check (standaard) leest alleen. MODE=execute verstuurt de twee transacties.
//   STATE_PATH=.../phase2-state.json IDL_PATH=... OUT_DIR=... MODE=check \
//     node_modules/.bin/ts-node --transpile-only scripts/throwawayRc164Phase2.ts
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import BN from "bn.js";
import {
  buildExpectedChallenge,
  signTestChallenge,
  buildSecp256r1Instruction,
  fetchActionNonce,
  nonceLeBytes,
  TestPasskey,
  SECP256R1_PROGRAM_ID,
} from "../tests/webauthnTestHelper";

const RPC = "https://api.devnet.solana.com";
const THROWAWAY = "FepMCPkvXFMrYnE1cGtb1WXdskoQacw4fdXPihqafbje";
const TIMELOCK_S = 86_400;
const MARGIN_S = 300;

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`WEIGERING: ${name} ontbreekt`);
  return v;
}

function canonicalProgramId(): string {
  const sh = fs.readFileSync(path.join(__dirname, "lib", "devnet-program-id.sh"), "utf8");
  const m = sh.match(/SPANKWALLET_DEVNET_PROGRAM_ID="([^"]+)"/);
  if (!m) throw new Error("WEIGERING: canoniek adres niet uit te lezen uit scripts/lib/devnet-program-id.sh");
  return m[1];
}

function assertTrue(cond: boolean, msg: string) {
  if (!cond) throw new Error(`CONTROLE MISLUKT: ${msg}`);
}

async function main() {
  const mode = process.env.MODE ?? "check";
  if (mode !== "check" && mode !== "execute") throw new Error(`WEIGERING: onbekende MODE ${mode}`);
  const st = JSON.parse(fs.readFileSync(mustEnv("STATE_PATH"), "utf8"));
  const idl = JSON.parse(fs.readFileSync(mustEnv("IDL_PATH"), "utf8"));
  const outDir = mustEnv("OUT_DIR");
  const canonical = canonicalProgramId();

  const connection = new Connection(RPC, "confirmed");
  const operator = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8")))
  );
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(operator), { commitment: "confirmed", preflightCommitment: "confirmed" });
  const program = new Program(idl, provider) as Program<any>;
  const throwaway = program.programId;

  // Grendel 1
  assertTrue(throwaway.toBase58() === THROWAWAY, `IDL-adres ${throwaway.toBase58()} is niet het wegwerpadres`);
  assertTrue(st.throwaway === THROWAWAY, "phase2-state.json hoort bij een ander programma");
  assertTrue(throwaway.toBase58() !== canonical, "programma-ID is het CANONIEKE adres");
  const progInfo = await connection.getAccountInfo(throwaway);
  assertTrue(!!progInfo?.executable, "wegwerpprogramma niet gevonden of niet executable");
  console.log(`Grendel 1 OK: ${throwaway.toBase58()} (canoniek ${canonical} uitgesloten)`);

  const walletPda = new PublicKey(st.wallet);
  const pendingPda = new PublicKey(st.pendingAction);
  const f = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, throwaway)[0];
  const vaultPda = f([Buffer.from("vault"), walletPda.toBuffer()]);
  const passkeysPda = f([Buffer.from("passkeys"), walletPda.toBuffer()]);
  const policyPda = f([Buffer.from("policy"), walletPda.toBuffer()]);
  assertTrue(f([Buffer.from("pending_action"), walletPda.toBuffer()]).equals(pendingPda), "pending_action-PDA klopt niet met de wallet");

  const P1: TestPasskey = { privateKey: Uint8Array.from(Buffer.from(st.p1PrivateKey, "hex")), compressedPublicKey: Buffer.from(st.p1Compressed, "hex") };
  const P2: TestPasskey = { privateKey: Uint8Array.from(Buffer.from(st.p2PrivateKey, "hex")), compressedPublicKey: Buffer.from(st.p2Compressed, "hex") };
  const target = Keypair.fromSecretKey(Uint8Array.from(st.targetSecret));
  const cpiData = Buffer.from(st.cpiDataHex, "hex");
  assertTrue(cpiData.equals(Buffer.from(SystemProgram.assign({ accountPubkey: target.publicKey, programId: throwaway }).data)), "cpi-data is niet de verwachte System-assign naar het wegwerpprogramma");

  // Wachtende actie
  const pending: any = await program.account.pendingAction.fetch(pendingPda, "finalized");
  const walletAcc: any = await program.account.walletAccount.fetch(walletPda, "finalized");
  const passkeys: any = await program.account.passkeysAccount.fetch(passkeysPda, "finalized");
  console.log(`PendingAction ${pendingPda.toBase58()}: wallet=${pending.wallet.toBase58()} kind=${pending.kind} confirmed=${pending.confirmed} epoch=${pending.epoch} timelock_started_at=${pending.timelockStartedAt} initiated_at=${pending.initiatedAt}`);
  console.log(`  initiator_passkey=${Buffer.from(pending.initiatorPasskey).toString("hex")} (P1=${st.p1Compressed})`);
  console.log(`  initiator_session=${pending.initiatorSession?.toBase58?.()}`);
  console.log(`Wallet ${walletPda.toBase58()}: session_epoch=${walletAcc.sessionEpoch} action_nonce=${walletAcc.actionNonce} disarmed=${walletAcc.disarmed} recovery=${walletAcc.recoveryState ? "Some" : "None"}`);
  // P1 is de owner_passkey (niet ingetrokken), P2 een extra passkey.
  const additional: Buffer[] = passkeys.additionalPasskeys.slice(0, passkeys.count).map((p: number[]) => Buffer.from(p));
  console.log(`Passkeys: owner=${Buffer.from(walletAcc.ownerPasskey).toString("hex")} revoked=${passkeys.ownerPasskeyRevoked}; extra (${passkeys.count}): ${additional.map((b) => b.toString("hex")).join(", ")}`);
  assertTrue(Buffer.from(walletAcc.ownerPasskey).equals(P1.compressedPublicKey) && passkeys.ownerPasskeyRevoked === false, "P1 moet de geldige owner_passkey zijn");
  assertTrue(additional.some((b) => b.equals(P2.compressedPublicKey)), "P2 moet als extra passkey geregistreerd zijn");
  assertTrue(pending.wallet.equals(walletPda), "PendingAction hoort niet bij wallet A");
  assertTrue(pending.kind === 2, "kind moet AdvancedAction (2) zijn");
  assertTrue(Buffer.from(pending.initiatorPasskey).equals(P1.compressedPublicKey), "initiator_passkey moet P1 zijn");
  assertTrue(pending.confirmed === false, "confirmed moet false zijn");
  assertTrue(BigInt(pending.timelockStartedAt.toString()) === BigInt(st.timelockStartedAt), "timelock_started_at wijkt af van phase2-state.json");
  assertTrue(BigInt(pending.epoch.toString()) === BigInt(walletAcc.sessionEpoch.toString()), "epoch van de actie != session_epoch van de wallet");
  const targetInfo0 = await connection.getAccountInfo(target.publicKey, "finalized");
  console.log(`Doel-account ${target.publicKey.toBase58()}: ${targetInfo0 ? `bestaat, owner=${targetInfo0.owner.toBase58()}` : "bestaat niet"}`);
  assertTrue(targetInfo0 === null, "doel-account mag nog niet bestaan");

  // Grendel 4: on-chain klok
  const clockInfo = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "finalized");
  const clockTs = Number(clockInfo!.data.readBigInt64LE(32));
  const earliest = st.timelockStartedAt + TIMELOCK_S;
  console.log(`Klok: on-chain ${clockTs} (${new Date(clockTs * 1000).toISOString()}), eindtijd ${earliest} (${new Date(earliest * 1000).toISOString()}), verschil ${clockTs - earliest} s`);
  if (clockTs < earliest + MARGIN_S) {
    console.log(`STOP: timelock nog niet ruim genoeg verstreken (nog ${earliest + MARGIN_S - clockTs} s incl. marge). Niets verstuurd.`);
    return;
  }
  if (mode === "check") {
    console.log("MODE=check: alle controles groen, niets verstuurd.");
    return;
  }

  // ---------- execute ----------
  const errorCodes = new Map<string, number>();
  for (const e of idl.errors) errorCodes.set(e.name, e.code);
  const allowedPrograms = new Set([throwaway.toBase58(), SECP256R1_PROGRAM_ID.toBase58(), SystemProgram.programId.toBase58()]);
  const results: any[] = [];
  const persist = () => fs.writeFileSync(path.join(outDir, "phase2-results.json"), JSON.stringify({ throwaway: throwaway.toBase58(), results }, null, 2));

  async function finalizeIxs(signer: TestPasskey) {
    const nonce = await fetchActionNonce(connection, walletPda);
    const p: any = await program.account.pendingAction.fetch(pendingPda);
    const payload = Buffer.concat([nonceLeBytes(nonce), pendingPda.toBuffer(), Buffer.from(p.actionCommitment)]);
    const signed = signTestChallenge(signer, buildExpectedChallenge(throwaway, walletPda, "finalize_advanced_action", payload));
    const secp = buildSecp256r1Instruction(signer.compressedPublicKey, signed.signedMessage, signed.rawSignature);
    const ix = await program.methods.finalizeAdvancedAction(cpiData, new BN(nonce.toString()), signed.clientDataJSON)
      .accounts({ wallet: walletPda, vault: vaultPda, pendingAction: pendingPda, policy: policyPda, cpiProgram: SystemProgram.programId, passkeys: passkeysPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, closer: operator.publicKey })
      .remainingAccounts([{ pubkey: target.publicKey, isWritable: true, isSigner: true }])
      .instruction();
    return [secp, ix];
  }

  async function sendTx(step: string, ixs: TransactionInstruction[], expectCode: number | null) {
    for (const ix of ixs) {
      const p = ix.programId.toBase58();
      if (p === canonical || !allowedPrograms.has(p)) throw new Error(`WEIGERING (${step}): instructie naar ${p}`);
    }
    const tx = new Transaction().add(...ixs);
    tx.feePayer = operator.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(operator, target);
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: expectCode !== null });
    await connection.confirmTransaction(signature, "confirmed").catch(() => undefined);
    let fetched: anchor.web3.VersionedTransactionResponse | null = null;
    for (let i = 0; i < 40 && !fetched; i++) {
      fetched = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!fetched) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!fetched) throw new Error(`${step}: transactie ${signature} niet terug te vinden`);
    const keys = fetched.transaction.message.staticAccountKeys.map((k) => k.toBase58());
    assertTrue(keys.includes(throwaway.toBase58()) && !keys.includes(canonical), `${step}: accountsleutels kloppen niet`);
    const err = fetched.meta?.err as any;
    const custom = err?.InstructionError?.[1]?.Custom;
    const observed = err == null ? "OK" : custom !== undefined ? `Custom ${custom}` : JSON.stringify(err);
    const pass = expectCode === null ? err == null : custom === expectCode;
    results.push({ step, signature, slot: fetched.slot, expected: expectCode === null ? "OK" : `Custom ${expectCode}`, observed, pass });
    persist();
    console.log(`${pass ? "PASS" : "FAIL"} ${step}\n     sig=${signature}\n     verwacht=${expectCode ?? "OK"} waargenomen=${observed}`);
    if (!pass) throw new Error(`${step}: uitkomst wijkt af - gestopt`);
  }

  const pendingBytesBefore = (await connection.getAccountInfo(pendingPda, "confirmed"))!.data;
  const walletBytesBefore = (await connection.getAccountInfo(walletPda, "confirmed"))!.data;

  // F1: P1 is de bevestiger -> 6048, geen staatswijziging
  const code6048 = errorCodes.get("SecondPasskeyMustDifferFromInitiator");
  assertTrue(code6048 === 6048, `SecondPasskeyMustDifferFromInitiator heeft code ${code6048} in de IDL, verwacht 6048`);
  await sendTx("F1: finalize door P1 (de bevestiger) na 24u weigert", await finalizeIxs(P1), 6048);
  const pendingBytesAfter = (await connection.getAccountInfo(pendingPda, "confirmed"))!.data;
  const walletBytesAfter = (await connection.getAccountInfo(walletPda, "confirmed"))!.data;
  assertTrue(pendingBytesAfter.equals(pendingBytesBefore), "PendingAction-bytes veranderd na F1");
  assertTrue(walletBytesAfter.equals(walletBytesBefore), "WalletAccount-bytes veranderd na F1");
  assertTrue((await connection.getAccountInfo(target.publicKey, "confirmed")) === null, "doel-account bestaat na F1");
  results[results.length - 1].notes = "PendingAction- en WalletAccount-bytes identiek aan vóór F1; doel-account bestaat niet";
  persist();

  // F2: P2 -> OK, CPI uitgevoerd
  const nonceBefore = await fetchActionNonce(connection, walletPda);
  await sendTx("F2: finalize door P2 na 24u slaagt", await finalizeIxs(P2), null);
  assertTrue((await connection.getAccountInfo(pendingPda, "confirmed")) === null, "PendingAction moet gesloten zijn na F2");
  // Het doel-account is in fase 1 nooit gefund: een Assign op een account met
  // 0 lamports slaagt, maar het account wordt na de transactie niet bewaard.
  // Bewijs van de CPI dus uit de transactie zelf: een inner instruction naar
  // het System-programma met exact de vastgelegde cpi-data, en de logregels.
  const f2 = await connection.getTransaction(results[results.length - 1].signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const keys = f2!.transaction.message.staticAccountKeys;
  const inner = (f2!.meta?.innerInstructions ?? []).flatMap((g) => g.instructions);
  const assignCpi = inner.find((ix) => keys[ix.programIdIndex].equals(SystemProgram.programId) && Buffer.from(anchor.utils.bytes.bs58.decode(ix.data)).equals(cpiData));
  assertTrue(!!assignCpi, "geen inner instruction naar System met de vastgelegde cpi-data");
  assertTrue(keys[assignCpi!.accounts[0]].equals(target.publicKey), "inner Assign raakt niet het doel-account");
  const logs = f2!.meta?.logMessages ?? [];
  assertTrue(logs.some((l) => l === `Program ${SystemProgram.programId.toBase58()} invoke [2]`), "geen System-invoke op diepte 2 in de logs");
  const nonceAfter = await fetchActionNonce(connection, walletPda);
  results[results.length - 1].notes = `PendingAction gesloten; inner System-Assign(${target.publicKey.toBase58()} -> ${throwaway.toBase58()}) met de vastgelegde cpi-data uitgevoerd; action_nonce ${nonceBefore} -> ${nonceAfter}`;
  persist();
  console.log(`     ${results[results.length - 1].notes}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
