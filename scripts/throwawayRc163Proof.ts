// RC-verificatie deel 2 voor upgrade 1 (STATUS.md sectie 163/164): live bewijs
// van de sectie-153-160-wijzigingen tegen een WEGWERP-programma op devnet.
//
// Drie grendels, alle drie hard (throw vóór er iets verstuurd wordt):
// 1. program.programId (uit de expliciet opgegeven IDL, NIET anchor.workspace -
//    zie het incident van sectie 140) moet gelijk zijn aan THROWAWAY_PROGRAM_ID
//    en mag niet het canonieke adres uit scripts/lib/devnet-program-id.sh zijn.
// 2. Elke instructie in elke transactie gaat naar het wegwerpprogramma, de
//    secp256r1-precompile of het System-programma - anders weigert sendTx.
// 3. Elke transactie wordt na bevestiging opgehaald (getTransaction) en de
//    uitkomst (meta.err) moet exact de verwachte zijn: null, of precies de
//    verwachte Custom-foutcode. Ook de accountsleutels van de transactie
//    worden gecontroleerd: wegwerpadres aanwezig, canoniek adres afwezig.
//
// Gebruik (in de wegwerp-worktree):
//   THROWAWAY_PROGRAM_ID=... IDL_PATH=... OUT_DIR=... \
//     node_modules/.bin/ts-node --transpile-only scripts/throwawayRc163Proof.ts
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import BN from "bn.js";
import {
  generateTestPasskey,
  buildExpectedChallenge,
  signTestChallenge,
  buildSecp256r1Instruction,
  encodeOptionalI64,
  fetchActionNonce,
  actionNonceOffset,
  nonceLeBytes,
  TestPasskey,
  SECP256R1_PROGRAM_ID,
} from "../tests/webauthnTestHelper";

const RPC = "https://api.devnet.solana.com";
const MAX_U64 = new BN("18446744073709551615");

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

type Expect = { ok: true } | { ok: false; code: number; name: string };
interface Result {
  step: string;
  signature: string;
  slot: number | null;
  expected: string;
  observed: string;
  pass: boolean;
  notes?: string;
}

async function main() {
  const throwaway = new PublicKey(mustEnv("THROWAWAY_PROGRAM_ID"));
  const idl = JSON.parse(fs.readFileSync(mustEnv("IDL_PATH"), "utf8"));
  const outDir = mustEnv("OUT_DIR");
  const canonical = canonicalProgramId();

  const connection = new Connection(RPC, "confirmed");
  const operator = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8")))
  );
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(operator), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idl, provider) as Program<any>;

  // Grendel 1
  if (program.programId.toBase58() !== throwaway.toBase58()) {
    throw new Error(`WEIGERING: IDL-adres ${program.programId.toBase58()} != THROWAWAY_PROGRAM_ID ${throwaway.toBase58()}`);
  }
  if (program.programId.toBase58() === canonical) {
    throw new Error("WEIGERING: programma-ID is het CANONIEKE adres");
  }
  const progInfo = await connection.getAccountInfo(throwaway);
  if (!progInfo?.executable) throw new Error("WEIGERING: wegwerpprogramma niet gevonden of niet executable");
  console.log(`Grendel 1 OK: programma ${throwaway.toBase58()} (canoniek ${canonical} uitgesloten)`);
  console.log(`fee-payer: ${operator.publicKey.toBase58()}`);

  const errorCodes = new Map<string, number>();
  for (const e of idl.errors) errorCodes.set(e.name, e.code);
  const customErr = (name: string): Expect => {
    const code = errorCodes.get(name) ?? (name === "ConstraintSeeds" ? 2006 : name === "AccountNotEnoughKeys" ? 3005 : undefined);
    if (code === undefined) throw new Error(`onbekende foutnaam ${name}`);
    return { ok: false, code, name };
  };
  const codeToName = (code: number): string => {
    for (const [n, c] of errorCodes) if (c === code) return n;
    if (code === 2006) return "ConstraintSeeds";
    if (code === 3005) return "AccountNotEnoughKeys";
    return `?${code}`;
  };

  const results: Result[] = [];
  const allowedPrograms = new Set([throwaway.toBase58(), SECP256R1_PROGRAM_ID.toBase58(), SystemProgram.programId.toBase58()]);

  async function sendTx(step: string, ixs: TransactionInstruction[], signers: Keypair[], expect: Expect, notes?: string) {
    // Grendel 2
    for (const ix of ixs) {
      const p = ix.programId.toBase58();
      if (p === canonical || !allowedPrograms.has(p)) {
        throw new Error(`WEIGERING (${step}): instructie naar ${p} - niet toegestaan`);
      }
    }
    const tx = new Transaction().add(...ixs);
    tx.feePayer = operator.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(operator, ...signers);
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: !expect.ok });
    await connection.confirmTransaction(signature, "confirmed").catch(() => undefined);

    // Grendel 3
    let fetched: anchor.web3.VersionedTransactionResponse | null = null;
    for (let i = 0; i < 40 && !fetched; i++) {
      fetched = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!fetched) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!fetched) throw new Error(`${step}: transactie ${signature} niet terug te vinden`);
    const keys = fetched.transaction.message.staticAccountKeys.map((k) => k.toBase58());
    if (!keys.includes(throwaway.toBase58()) || keys.includes(canonical)) {
      throw new Error(`${step}: accountsleutels kloppen niet (wegwerp aanwezig: ${keys.includes(throwaway.toBase58())}, canoniek aanwezig: ${keys.includes(canonical)})`);
    }
    const err = fetched.meta?.err as any;
    let observed: string;
    let pass: boolean;
    if (err === null || err === undefined) {
      observed = "OK";
      pass = expect.ok;
    } else {
      const custom = err?.InstructionError?.[1]?.Custom;
      observed = custom !== undefined ? `Custom ${custom} (${codeToName(custom)}) in instructie ${err.InstructionError[0]}` : JSON.stringify(err);
      pass = !expect.ok && custom === expect.code;
    }
    const expected = expect.ok ? "OK" : `Custom ${expect.code} (${expect.name})`;
    results.push({ step, signature, slot: fetched.slot, expected, observed, pass, notes });
    console.log(`${pass ? "PASS" : "FAIL"} ${step}\n     sig=${signature}\n     verwacht=${expected} waargenomen=${observed}${notes ? "\n     " + notes : ""}`);
    persist();
    if (!pass) throw new Error(`${step}: uitkomst wijkt af - gestopt`);
    return signature;
  }

  function persist() {
    fs.writeFileSync(path.join(outDir, "proof-results.json"), JSON.stringify({ throwaway: throwaway.toBase58(), results }, null, 2));
  }
  function note(step: string, text: string) {
    console.log(`     [${step}] ${text}`);
    const r = results[results.length - 1];
    r.notes = (r.notes ? r.notes + " | " : "") + text;
    persist();
  }
  function assertTrue(cond: boolean, msg: string) {
    if (!cond) throw new Error(`CONTROLE MISLUKT: ${msg}`);
  }

  // ---------- helpers (zelfde opbouw als tests/pendingAction.ts) ----------
  const ixDisc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
  const vecU8 = (b: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32LE(b.length, 0); return Buffer.concat([l, b]); };

  function pdas(compressed: Buffer) {
    const seedHash = createHash("sha256").update(compressed).digest();
    const f = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, throwaway)[0];
    const walletPda = f([Buffer.from("wallet"), seedHash]);
    return {
      walletPda,
      vaultPda: f([Buffer.from("vault"), walletPda.toBuffer()]),
      passkeysPda: f([Buffer.from("passkeys"), walletPda.toBuffer()]),
      policyPda: f([Buffer.from("policy"), walletPda.toBuffer()]),
      pendingPda: f([Buffer.from("pending_action"), walletPda.toBuffer()]),
      walletSeedHash: Array.from(seedHash),
    };
  }
  const sessionPda = (walletPda: PublicKey, key: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("session"), walletPda.toBuffer(), key.toBuffer()], throwaway)[0];

  function passkeyIxFor(pk: TestPasskey, walletPda: PublicKey, domain: string, payload: Buffer) {
    const signed = signTestChallenge(pk, buildExpectedChallenge(throwaway, walletPda, domain, payload));
    return { secp: buildSecp256r1Instruction(pk.compressedPublicKey, signed.signedMessage, signed.rawSignature), clientDataJSON: signed.clientDataJSON };
  }

  async function walletRaw(walletPda: PublicKey) {
    const info = await connection.getAccountInfo(walletPda, "confirmed");
    const d = info!.data;
    const off = actionNonceOffset(d);
    return {
      recoverySome: d[148] === 1,
      actionNonce: d.readBigUInt64LE(off),
      sessionEpoch: d.readBigUInt64LE(off + 8),
      disarmed: d[off + 24] === 1,
      snapshot: d.readBigUInt64LE(off + 25),
      len: d.length,
    };
  }

  async function createWallet(label: string) {
    const passkey = generateTestPasskey();
    const backup = Keypair.generate();
    const p = pdas(passkey.compressedPublicKey);
    const payload = Buffer.concat([backup.publicKey.toBuffer(), encodeOptionalI64(null)]); // vaste 9 bytes, zie encode_optional_i64
    const { secp, clientDataJSON } = passkeyIxFor(passkey, p.walletPda, "init_wallet", payload);
    const ix = await program.methods
      .initWallet(Array.from(passkey.compressedPublicKey), p.walletSeedHash, backup.publicKey, null, clientDataJSON)
      .accounts({ wallet: p.walletPda, vault: p.vaultPda, payer: operator.publicKey, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, systemProgram: SystemProgram.programId })
      .instruction();
    await sendTx(`${label}: init_wallet`, [secp, ix], [], { ok: true });
    note(`${label}`, `wallet=${p.walletPda.toBase58()} backup=${backup.publicKey.toBase58()} accountlengte=${(await walletRaw(p.walletPda)).len}`);
    return { passkey, backup, ...p };
  }

  async function addPasskeyIxs(signer: TestPasskey, w: ReturnType<typeof pdas>, newPk: Buffer) {
    const nonce = await fetchActionNonce(connection, w.walletPda);
    const { secp, clientDataJSON } = passkeyIxFor(signer, w.walletPda, "add_passkey", Buffer.concat([nonceLeBytes(nonce), newPk]));
    const ix = await program.methods.addPasskey(Array.from(newPk), new BN(nonce.toString()), clientDataJSON)
      .accounts({ wallet: w.walletPda, passkeys: w.passkeysPda, payer: operator.publicKey, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, systemProgram: SystemProgram.programId })
      .instruction();
    return [secp, ix];
  }

  async function addAllowedProgramIxs(signer: TestPasskey, w: ReturnType<typeof pdas>, target: PublicKey) {
    const nonce = await fetchActionNonce(connection, w.walletPda);
    const { secp, clientDataJSON } = passkeyIxFor(signer, w.walletPda, "add_allowed_program", Buffer.concat([nonceLeBytes(nonce), target.toBuffer()]));
    const ix = await program.methods.addAllowedProgram(target, new BN(nonce.toString()), clientDataJSON)
      .accounts({ wallet: w.walletPda, policy: w.policyPda, payer: operator.publicKey, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, systemProgram: SystemProgram.programId })
      .instruction();
    return [secp, ix];
  }

  async function addAdvancedSessionIxs(signer: TestPasskey, w: ReturnType<typeof pdas>, sessionKey: PublicKey, cpiProgram: PublicKey) {
    const expirySlot = (await connection.getSlot("confirmed")) + 100_000;
    const nonce = await fetchActionNonce(connection, w.walletPda);
    const exp = Buffer.alloc(8); exp.writeBigUInt64LE(BigInt(expirySlot), 0);
    const cnt = Buffer.alloc(4); cnt.writeUInt32LE(1, 0);
    const zero = new BN(0);
    const payload = Buffer.concat([
      nonceLeBytes(nonce), sessionKey.toBuffer(), exp, Buffer.from([0, 0, 1]), cnt, cpiProgram.toBuffer(),
      MAX_U64.toArrayLike(Buffer, "le", 8), MAX_U64.toArrayLike(Buffer, "le", 8), PublicKey.default.toBuffer(),
      zero.toArrayLike(Buffer, "le", 8), zero.toArrayLike(Buffer, "le", 8),
    ]);
    const { secp, clientDataJSON } = passkeyIxFor(signer, w.walletPda, "add_session_key", payload);
    const ix = await program.methods
      .addSessionKey(sessionKey, new BN(expirySlot), false, false, true, [cpiProgram], MAX_U64, MAX_U64, PublicKey.default, zero, zero, new BN(nonce.toString()), clientDataJSON)
      .accounts({ wallet: w.walletPda, session: sessionPda(w.walletPda, sessionKey), payer: operator.publicKey, policy: w.policyPda, passkeys: w.passkeysPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, systemProgram: SystemProgram.programId })
      .instruction();
    return { ixs: [secp, ix], expirySlot };
  }

  async function finalizeAdvancedIxs(signer: TestPasskey, w: ReturnType<typeof pdas>, cpiData: Buffer, target: Keypair) {
    const nonce = await fetchActionNonce(connection, w.walletPda);
    const pending: any = await program.account.pendingAction.fetch(w.pendingPda);
    const payload = Buffer.concat([nonceLeBytes(nonce), w.pendingPda.toBuffer(), Buffer.from(pending.actionCommitment)]);
    const { secp, clientDataJSON } = passkeyIxFor(signer, w.walletPda, "finalize_advanced_action", payload);
    const ix = await program.methods.finalizeAdvancedAction(cpiData, new BN(nonce.toString()), clientDataJSON)
      .accounts({ wallet: w.walletPda, vault: w.vaultPda, pendingAction: w.pendingPda, policy: w.policyPda, cpiProgram: SystemProgram.programId, passkeys: w.passkeysPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, closer: operator.publicKey })
      .remainingAccounts([{ pubkey: target.publicKey, isWritable: true, isSigner: true }])
      .instruction();
    return [secp, ix];
  }

  async function confirmIxs(signer: TestPasskey, w: ReturnType<typeof pdas>) {
    const nonce = await fetchActionNonce(connection, w.walletPda);
    const pending: any = await program.account.pendingAction.fetch(w.pendingPda);
    const payload = Buffer.concat([nonceLeBytes(nonce), w.pendingPda.toBuffer(), Buffer.from(pending.actionCommitment)]);
    const { secp, clientDataJSON } = passkeyIxFor(signer, w.walletPda, "confirm_pending_action", payload);
    const ix = new TransactionInstruction({
      programId: throwaway,
      keys: [
        { pubkey: w.walletPda, isSigner: false, isWritable: true },
        { pubkey: w.pendingPda, isSigner: false, isWritable: true },
        { pubkey: w.passkeysPda, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: sessionPda(w.walletPda, pending.initiatorSession), isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([ixDisc("confirm_pending_action"), nonceLeBytes(nonce), vecU8(Buffer.from(clientDataJSON))]),
    });
    return [secp, ix];
  }

  async function freezeViaPasskeyIxs(signer: TestPasskey, w: ReturnType<typeof pdas>) {
    const nonce = await fetchActionNonce(connection, w.walletPda);
    const { secp, clientDataJSON } = passkeyIxFor(signer, w.walletPda, "freeze", nonceLeBytes(nonce));
    const ix = await program.methods.freezeViaPasskey(new BN(nonce.toString()), clientDataJSON)
      .accounts({ wallet: w.walletPda, passkeys: w.passkeysPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();
    return [secp, ix];
  }

  async function freezeViaBackupIx(backup: Keypair, w: ReturnType<typeof pdas>) {
    return program.methods.freezeViaBackupAuthority().accounts({ wallet: w.walletPda, backupAuthority: backup.publicKey }).instruction();
  }

  function unfreezeViaBackupIx(backup: Keypair, w: ReturnType<typeof pdas>) {
    const count = Buffer.alloc(4); // lege passkeys_to_remove
    return new TransactionInstruction({
      programId: throwaway,
      keys: [
        { pubkey: w.walletPda, isSigner: false, isWritable: true },
        { pubkey: w.pendingPda, isSigner: false, isWritable: true },
        { pubkey: backup.publicKey, isSigner: true, isWritable: true },
        { pubkey: w.passkeysPda, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([ixDisc("unfreeze_via_backup_authority"), count]),
    });
  }

  async function initiateRecoveryIx(backup: Keypair, w: ReturnType<typeof pdas>, newOwner: Buffer) {
    return program.methods.initiateRecovery(Array.from(newOwner))
      .accounts({ wallet: w.walletPda, backupAuthority: backup.publicKey, pendingAction: w.pendingPda })
      .instruction();
  }

  async function fundBackup(backup: Keypair) {
    // backup_authority is mut (ontvangt rent) - geef hem een rent-vrij saldo
    // zodat het account bestaat; geen transactie via het wegwerpprogramma,
    // daarom rechtstreeks via connection (valt buiten sendTx).
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: backup.publicKey, lamports: 1_000_000 }));
    await anchor.web3.sendAndConfirmTransaction(connection, tx, [operator], { commitment: "confirmed" });
  }

  // =====================================================================
  // A. Sessie-route: initiate_advanced_action_via_session + confirm (2-van-2)
  // =====================================================================
  const A = await createWallet("A");
  const A_P2 = generateTestPasskey();
  await sendTx("A: add_passkey (P2, door P1)", await addPasskeyIxs(A.passkey, A, A_P2.compressedPublicKey), [], { ok: true });
  await sendTx("A: add_allowed_program (System)", await addAllowedProgramIxs(A.passkey, A, SystemProgram.programId), [], { ok: true });
  const A_session = Keypair.generate();
  const sess = await addAdvancedSessionIxs(A.passkey, A, A_session.publicKey, SystemProgram.programId);
  await sendTx("A: add_session_key (alleen can_execute_advanced, scope [System])", sess.ixs, [], { ok: true });
  note("A", `sessie=${A_session.publicKey.toBase58()} expiry_slot=${sess.expirySlot}`);

  const A_target = Keypair.generate();
  const cpiData = SystemProgram.assign({ accountPubkey: A_target.publicKey, programId: throwaway }).data;
  const remaining = [{ pubkey: A_target.publicKey, isWritable: true, isSigner: true }];

  // A1: het oude directe pad is dicht.
  const execViaSession = await program.methods.executeAdvancedViaSession(cpiData)
    .accounts({ wallet: A.walletPda, vault: A.vaultPda, policy: A.policyPda, cpiProgram: SystemProgram.programId, session: sessionPda(A.walletPda, A_session.publicKey), sessionKey: A_session.publicKey })
    .remainingAccounts(remaining).instruction();
  await sendTx("A1: execute_advanced_via_session (instant-CPI) weigert", [execViaSession], [A_session, A_target], customErr("SessionAdvancedMustUseQueue"));
  assertTrue((await connection.getAccountInfo(A_target.publicKey, "confirmed")) === null, "doel-account mag niet bestaan");
  note("A1", "doel-account bestaat niet: geen CPI uitgevoerd");

  // A2: sessie zet de CPI in de wachtrij.
  const nonceBeforeInit = await fetchActionNonce(connection, A.walletPda);
  const initViaSession = await program.methods.initiateAdvancedActionViaSession(cpiData)
    .accounts({ wallet: A.walletPda, vault: A.vaultPda, pendingAction: A.pendingPda, policy: A.policyPda, cpiProgram: SystemProgram.programId, session: sessionPda(A.walletPda, A_session.publicKey), sessionKey: A_session.publicKey, passkeys: A.passkeysPda, payer: operator.publicKey, systemProgram: SystemProgram.programId })
    .remainingAccounts(remaining).instruction();
  await sendTx("A2: initiate_advanced_action_via_session (wachtrij)", [initViaSession], [A_session, A_target], { ok: true });
  let pending: any = await program.account.pendingAction.fetch(A.pendingPda);
  assertTrue(pending.kind === 2, "kind moet AdvancedAction (2) zijn");
  assertTrue(Buffer.from(pending.initiatorPasskey).equals(Buffer.alloc(33)), "initiator_passkey moet de sessie-sentinel (nullen) zijn");
  assertTrue(pending.initiatorSession.equals(A_session.publicKey), "initiator_session moet de sessiesleutel zijn");
  assertTrue(pending.confirmed === false, "confirmed moet false zijn (2 passkeys)");
  assertTrue((await connection.getAccountInfo(A_target.publicKey, "confirmed")) === null, "doel-account mag niet bestaan");
  assertTrue((await fetchActionNonce(connection, A.walletPda)) === nonceBeforeInit, "sessie mag action_nonce niet raken");
  note("A2", `pending_action=${A.pendingPda.toBase58()} kind=2 initiator_passkey=sentinel initiator_session=sessie confirmed=false; geen CPI; action_nonce ongewijzigd (${nonceBeforeInit})`);

  // A3: finalize vóór confirm weigert.
  await sendTx("A3: finalize_advanced_action vóór confirm weigert", await finalizeAdvancedIxs(A_P2, A, cpiData, A_target), [A_target], customErr("SessionInitiatedActionNeedsConfirmation"));

  // A4: passkey P1 bevestigt.
  await sendTx("A4: confirm_pending_action door P1", await confirmIxs(A.passkey, A), [], { ok: true });
  pending = await program.account.pendingAction.fetch(A.pendingPda);
  assertTrue(Buffer.from(pending.initiatorPasskey).equals(A.passkey.compressedPublicKey), "initiator_passkey moet P1 zijn");
  assertTrue(pending.confirmed === false, "confirmed blijft false: finalize vereist een andere passkey");
  const timelockStart = BigInt(pending.timelockStartedAt.toString());
  note("A4", `initiator_passkey=P1, confirmed=false, timelock_started_at=${timelockStart} (initiated_at=${pending.initiatedAt.toString()})`);

  // A5: tweede confirm weigert.
  await sendTx("A5: tweede confirm (P2) weigert", await confirmIxs(A_P2, A), [], customErr("PendingActionAlreadyConfirmed"));

  // A6/A7: finalize vóór de 24u - timelock-check komt vóór de tweede-passkey-check.
  await sendTx("A6: finalize door P1 (bevestiger) vóór 24u weigert", await finalizeAdvancedIxs(A.passkey, A, cpiData, A_target), [A_target], customErr("PendingActionTimelockNotElapsed"));
  await sendTx("A7: finalize door P2 vóór 24u weigert", await finalizeAdvancedIxs(A_P2, A, cpiData, A_target), [A_target], customErr("PendingActionTimelockNotElapsed"));

  // Bewaar alles voor fase 2 (na de echte 24u: P1 weigert met
  // SecondPasskeyMustDifferFromInitiator, P2 slaagt).
  const earliest = Number(timelockStart) + 86_400;
  fs.writeFileSync(
    path.join(outDir, "phase2-state.json"),
    JSON.stringify({
      throwaway: throwaway.toBase58(),
      wallet: A.walletPda.toBase58(),
      pendingAction: A.pendingPda.toBase58(),
      p1PrivateKey: Buffer.from(A.passkey.privateKey).toString("hex"),
      p1Compressed: A.passkey.compressedPublicKey.toString("hex"),
      p2PrivateKey: Buffer.from(A_P2.privateKey).toString("hex"),
      p2Compressed: A_P2.compressedPublicKey.toString("hex"),
      targetSecret: Array.from(A_target.secretKey),
      cpiDataHex: Buffer.from(cpiData).toString("hex"),
      timelockStartedAt: Number(timelockStart),
      earliestFinalizeUtc: new Date(earliest * 1000).toISOString(),
    }, null, 2),
    { mode: 0o600 }
  );
  console.log(`     fase-2-toestand bewaard; vroegste finalize: ${new Date(earliest * 1000).toISOString()}`);

  // =====================================================================
  // B. Kern-M-1: initiate_recovery sluit een wachtende actie; pending_action verplicht
  // =====================================================================
  const B = await createWallet("B");
  await fundBackup(B.backup);
  await sendTx("B1: freeze_via_backup_authority", [await freezeViaBackupIx(B.backup, B)], [B.backup], { ok: true });
  assertTrue((await walletRaw(B.walletPda)).disarmed, "B moet bevroren zijn");
  const nb = await fetchActionNonce(connection, B.walletPda);
  const { secp: iuSecp, clientDataJSON: iuCdj } = passkeyIxFor(B.passkey, B.walletPda, "initiate_unfreeze", nonceLeBytes(nb));
  const iuIx = await program.methods.initiateUnfreeze(new BN(nb.toString()), iuCdj)
    .accounts({ wallet: B.walletPda, pendingAction: B.pendingPda, passkeys: B.passkeysPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, payer: operator.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  await sendTx("B2: initiate_unfreeze door de passkey (de 'dief' zet een Unfreeze klaar)", [iuSecp, iuIx], [], { ok: true });
  const pB: any = await program.account.pendingAction.fetch(B.pendingPda);
  assertTrue(pB.kind === 4, "kind moet Unfreeze (4) zijn");
  const pendingRent = (await connection.getAccountInfo(B.pendingPda, "confirmed"))!.lamports;
  note("B2", `wachtende PendingAction ${B.pendingPda.toBase58()} kind=4 (Unfreeze), rent=${pendingRent}`);

  const newOwnerB = generateTestPasskey().compressedPublicKey;
  // B3: zonder pending_action-account.
  const fullIx = await initiateRecoveryIx(B.backup, B, newOwnerB);
  const missing = new TransactionInstruction({ programId: fullIx.programId, keys: fullIx.keys.filter((k) => !k.pubkey.equals(B.pendingPda)), data: fullIx.data });
  assertTrue(missing.keys.length === fullIx.keys.length - 1, "precies één account weggelaten");
  await sendTx("B3: initiate_recovery ZONDER pending_action-account weigert", [missing], [B.backup], customErr("AccountNotEnoughKeys"));
  // B4: met een verkeerd adres op de plek van pending_action.
  const wrong = new TransactionInstruction({ programId: fullIx.programId, keys: fullIx.keys.map((k) => (k.pubkey.equals(B.pendingPda) ? { ...k, pubkey: Keypair.generate().publicKey } : k)), data: fullIx.data });
  await sendTx("B4: initiate_recovery met een ANDER adres als pending_action weigert", [wrong], [B.backup], customErr("ConstraintSeeds"));
  assertTrue((await connection.getAccountInfo(B.pendingPda, "confirmed")) !== null, "PendingAction moet na B3/B4 nog bestaan");
  // B5: correct - de wachtende actie wordt gesloten.
  const backupBefore = await connection.getBalance(B.backup.publicKey, "confirmed");
  const nonceB = await fetchActionNonce(connection, B.walletPda);
  await sendTx("B5: initiate_recovery sluit de wachtende Unfreeze (kern-M-1)", [fullIx], [B.backup], { ok: true });
  const pendingAfter = await connection.getAccountInfo(B.pendingPda, "confirmed");
  const backupAfter = await connection.getBalance(B.backup.publicKey, "confirmed");
  const wB = await walletRaw(B.walletPda);
  assertTrue(pendingAfter === null, "PendingAction moet gesloten zijn");
  assertTrue(backupAfter - backupBefore === pendingRent, "rent moet naar de backup authority");
  assertTrue(wB.recoverySome && wB.snapshot === nonceB, "recovery_state Some, momentopname = nonce");
  note("B5", `PendingAction gesloten (account bestaat niet meer); backup +${backupAfter - backupBefore} lamports (= rent); recovery_state=Some; momentopname=${wB.snapshot} = action_nonce bij initiate`);

  // B6/B7: tijdens de recovery - bevriezen via backup slaagt (idempotent hier), ontdooien weigert.
  await sendTx("B6: freeze_via_backup_authority tijdens recovery (al bevroren, idempotent)", [await freezeViaBackupIx(B.backup, B)], [B.backup], { ok: true });
  await sendTx("B7: unfreeze_via_backup_authority tijdens recovery weigert", [unfreezeViaBackupIx(B.backup, B)], [B.backup], customErr("RecoveryAlreadyInProgress"));

  // =====================================================================
  // C. freeze_via_passkey, unfreeze buiten/tijdens recovery, cancel_recovery_v3
  // =====================================================================
  const C = await createWallet("C");
  await fundBackup(C.backup);
  await sendTx("C1: freeze_via_passkey", await freezeViaPasskeyIxs(C.passkey, C), [], { ok: true });
  assertTrue((await walletRaw(C.walletPda)).disarmed, "C moet bevroren zijn");
  await sendTx("C2: tweede freeze_via_passkey weigert (al bevroren)", await freezeViaPasskeyIxs(C.passkey, C), [], customErr("WalletAlreadyDisarmed"));
  await sendTx("C3: unfreeze_via_backup_authority BUITEN recovery (controle: slaagt)", [unfreezeViaBackupIx(C.backup, C)], [C.backup], { ok: true });
  assertTrue(!(await walletRaw(C.walletPda)).disarmed, "C moet ontdooid zijn");

  const newOwnerC = generateTestPasskey().compressedPublicKey;
  await sendTx("C4: initiate_recovery", [await initiateRecoveryIx(C.backup, C, newOwnerC)], [C.backup], { ok: true });
  const wC0 = await walletRaw(C.walletPda);
  note("C4", `momentopname=${wC0.snapshot}, action_nonce=${wC0.actionNonce}`);
  await sendTx("C5: freeze_via_passkey TIJDENS recovery (niet-bevroren -> bevroren)", await freezeViaPasskeyIxs(C.passkey, C), [], { ok: true });
  const wC1 = await walletRaw(C.walletPda);
  assertTrue(wC1.disarmed && wC1.recoverySome, "bevroren en recovery nog lopend");
  await sendTx("C6: unfreeze_via_backup_authority TIJDENS recovery weigert", [unfreezeViaBackupIx(C.backup, C)], [C.backup], customErr("RecoveryAlreadyInProgress"));

  const walletC: any = await program.account.walletAccount.fetch(C.walletPda);
  const initiatedAt = walletC.recoveryState.initiatedAt.toArrayLike(Buffer, "le", 8);
  const liveNonce = await fetchActionNonce(connection, C.walletPda);
  assertTrue(liveNonce !== wC0.snapshot, "live nonce moet inmiddels van de momentopname afwijken");
  const cancelIxs = (nonceInChallenge: bigint) => {
    const payload = Buffer.concat([nonceLeBytes(nonceInChallenge), initiatedAt, newOwnerC]);
    const { secp, clientDataJSON } = passkeyIxFor(C.passkey, C.walletPda, "cancel_recovery_v3", payload);
    const ix = new TransactionInstruction({
      programId: throwaway,
      keys: [
        { pubkey: C.walletPda, isSigner: false, isWritable: true },
        { pubkey: C.passkeysPda, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([ixDisc("cancel_recovery"), vecU8(Buffer.from(clientDataJSON))]),
    });
    return [secp, ix];
  };
  await sendTx("C7: cancel_recovery met de LIVE nonce in de challenge weigert", cancelIxs(liveNonce), [], customErr("WebAuthnChallengeMismatch"),
    `live nonce ${liveNonce} != momentopname ${wC0.snapshot}`);
  await sendTx("C8: cancel_recovery_v3 met de momentopname slaagt", cancelIxs(wC0.snapshot), [], { ok: true },
    `challenge over momentopname ${wC0.snapshot}, terwijl live nonce ${liveNonce} was`);
  const wC2 = await walletRaw(C.walletPda);
  assertTrue(!wC2.recoverySome && wC2.snapshot === 0n && wC2.actionNonce === liveNonce + 1n, "recovery weg, momentopname 0, nonce +1");
  note("C8", `recovery_state=None, momentopname=0, action_nonce ${liveNonce} -> ${wC2.actionNonce}`);

  // =====================================================================
  // D. freeze_via_backup_authority tijdens recovery met echte staatswijziging
  // =====================================================================
  const D = await createWallet("D");
  await fundBackup(D.backup);
  await sendTx("D1: initiate_recovery", [await initiateRecoveryIx(D.backup, D, generateTestPasskey().compressedPublicKey)], [D.backup], { ok: true });
  assertTrue(!(await walletRaw(D.walletPda)).disarmed, "D moet nog niet bevroren zijn");
  await sendTx("D2: freeze_via_backup_authority TIJDENS recovery (niet-bevroren -> bevroren)", [await freezeViaBackupIx(D.backup, D)], [D.backup], { ok: true });
  const wD = await walletRaw(D.walletPda);
  assertTrue(wD.disarmed && wD.recoverySome, "bevroren en recovery nog lopend");
  note("D2", "disarmed false -> true, recovery_state blijft Some");

  const passed = results.filter((r) => r.pass).length;
  console.log(`\nKLAAR: ${passed}/${results.length} transacties met de verwachte uitkomst.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
