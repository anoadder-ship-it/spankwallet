import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { assert } from "chai";
import BN from "bn.js";
import type { Spankwallet } from "../target/types/spankwallet";
import {
  generateTestPasskey,
  buildExpectedChallenge,
  signTestChallenge,
  buildSecp256r1Instruction,
  encodeOptionalI64,
  fetchActionNonce,
  nonceLeBytes,
  TestPasskey,
} from "./webauthnTestHelper";

// SPL Token (niet 2022) - vast, algemeen bekend adres. Uitsluitend nog
// gebruikt als "een willekeurig ander programma-ID" in de
// add/remove_allowed_program-tests hieronder - de Token::transfer-CPI-
// tests die hier eerder de volledige instructielay-outs nodig hadden
// (InitializeMint/InitializeAccount/MintTo/Transfer) zijn verplaatst naar
// tests/pendingAction.ts (STATUS.md sectie 131), dus die encodering staat
// hier niet meer.
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

interface RemainingAccountSpec {
  pubkey: PublicKey;
  isWritable: boolean;
  isSigner: boolean;
}

describe("spankwallet: programma-allowlist (add/remove_allowed_program) + initiate_advanced_action-allowlist-weigering", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Spankwallet as Program<Spankwallet>;

  function derivePdas(compressedPublicKey: Buffer) {
    const seedHash = createHash("sha256").update(compressedPublicKey).digest();
    const [walletPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("wallet"), seedHash],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), walletPda.toBuffer()],
      program.programId
    );
    const [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), walletPda.toBuffer()],
      program.programId
    );
    const [pendingActionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_action"), walletPda.toBuffer()],
      program.programId
    );
    return { walletPda, vaultPda, policyPda, pendingActionPda, walletSeedHash: Array.from(seedHash) };
  }

  // init_wallet vereist een echte secp256r1-handtekening (STATUS.md sectie
  // 22) - zelfde aanpak als tests/spankwallet.ts en tests/recovery.ts.
  async function createWallet() {
    const passkey = generateTestPasskey();
    const backupAuthority = Keypair.generate();
    const { walletPda, vaultPda, policyPda, walletSeedHash } = derivePdas(
      passkey.compressedPublicKey
    );

    const payload = Buffer.concat([backupAuthority.publicKey.toBuffer(), encodeOptionalI64(null)]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "init_wallet",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      passkey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      passkey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    await program.methods
      .initWallet(
        Array.from(passkey.compressedPublicKey),
        walletSeedHash,
        backupAuthority.publicKey,
        null,
        clientDataJSON
      )
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        payer: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([secp256r1Ix])
      .rpc();

    return { passkey, walletPda, vaultPda, policyPda };
  }

  async function callAddAllowedProgram(
    passkey: TestPasskey,
    walletPda: PublicKey,
    policyPda: PublicKey,
    programId: PublicKey
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const payload = Buffer.concat([nonceLeBytes(nonce), programId.toBuffer()]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "add_allowed_program",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      passkey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      passkey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    return program.methods
      .addAllowedProgram(programId, new BN(nonce.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        policy: policyPda,
        payer: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  async function callRemoveAllowedProgram(
    passkey: TestPasskey,
    walletPda: PublicKey,
    policyPda: PublicKey,
    programId: PublicKey
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const payload = Buffer.concat([nonceLeBytes(nonce), programId.toBuffer()]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "remove_allowed_program",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      passkey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      passkey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    return program.methods
      .removeAllowedProgram(programId, new BN(nonce.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        policy: policyPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  // Exacte TS-tegenhanger van de challenge-payload die
  // instructions.rs::execute_advanced opbouwt: cpi_program_id + u16 LE
  // aantal remaining accounts + per account (pubkey + is_writable +
  // is_signer) + u32 LE data-lengte + data. De vault wordt hier, net als
  // on-chain, GEFORCEERD als signer meegeteld ongeacht wat de aanroeper
  // opgeeft - anders zou de client een andere challenge berekenen dan het
  // programma verwacht en zou elke aanroep met de vault in de accountlijst
  // altijd falen.
  function buildExecuteAdvancedPayload(
    cpiProgramId: PublicKey,
    vaultPda: PublicKey,
    remainingAccounts: RemainingAccountSpec[],
    data: Buffer
  ): Buffer {
    const parts: Buffer[] = [cpiProgramId.toBuffer()];
    const countBuf = Buffer.alloc(2);
    countBuf.writeUInt16LE(remainingAccounts.length, 0);
    parts.push(countBuf);
    for (const acc of remainingAccounts) {
      const isSigner = acc.pubkey.equals(vaultPda) || acc.isSigner;
      parts.push(acc.pubkey.toBuffer());
      parts.push(Buffer.from([acc.isWritable ? 1 : 0]));
      parts.push(Buffer.from([isSigner ? 1 : 0]));
    }
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(data.length, 0);
    parts.push(lenBuf);
    parts.push(data);
    return Buffer.concat(parts);
  }

  // STATUS.md sectie 131 (vervolg op sectie 115/127-130): execute_advanced
  // is permanent geblokkeerd voor directe aanroep sinds die sectie -
  // dezelfde challenge-payload-vorm (buildExecuteAdvancedPayload) blijft
  // geldig, initiate_advanced_action herhaalt exact dezelfde
  // allowlist-/SelfCpi-/executable-checks en dezelfde challenge-binding,
  // alleen de aanroep en het accountschema veranderen.
  async function callInitiateAdvancedAction(
    passkey: TestPasskey,
    walletPda: PublicKey,
    vaultPda: PublicKey,
    pendingActionPda: PublicKey,
    policyPda: PublicKey,
    cpiProgramId: PublicKey,
    remainingAccounts: RemainingAccountSpec[],
    data: Buffer,
    extraSigners: Keypair[] = []
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const rawPayload = buildExecuteAdvancedPayload(cpiProgramId, vaultPda, remainingAccounts, data);
    const payload = Buffer.concat([nonceLeBytes(nonce), rawPayload]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "initiate_advanced_action",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      passkey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      passkey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    return program.methods
      .initiateAdvancedAction(data, new BN(nonce.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        pendingAction: pendingActionPda,
        policy: policyPda,
        cpiProgram: cpiProgramId,
        payer: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        remainingAccounts.map((a) => ({
          pubkey: a.pubkey,
          isWritable: a.isWritable,
          isSigner: a.isSigner,
        }))
      )
      .preInstructions([secp256r1Ix])
      .signers(extraSigners)
      .rpc();
  }

  it("add_allowed_program voegt een programma toe aan een nieuw (init_if_needed) policy-account", async () => {
    const { passkey, walletPda, policyPda } = await createWallet();

    await callAddAllowedProgram(passkey, walletPda, policyPda, TOKEN_PROGRAM_ID);

    const policy = await program.account.policyAccount.fetch(policyPda);
    assert.equal(policy.count, 1);
    assert.equal(policy.allowedPrograms[0].toBase58(), TOKEN_PROGRAM_ID.toBase58());
    assert.equal(policy.wallet.toBase58(), walletPda.toBase58());
  });

  it("add_allowed_program faalt bij het toevoegen van het eigen SpankWallet-programma-ID (SelfCpiNotAllowed)", async () => {
    const { passkey, walletPda, policyPda } = await createWallet();

    let threw = false;
    try {
      await callAddAllowedProgram(passkey, walletPda, policyPda, program.programId);
    } catch (err) {
      threw = true;
    }
    assert.isTrue(threw, "add_allowed_program met het eigen programma-ID had moeten falen");
  });

  it("add_allowed_program faalt bij een duplicaat (ProgramAlreadyAllowed)", async () => {
    const { passkey, walletPda, policyPda } = await createWallet();
    await callAddAllowedProgram(passkey, walletPda, policyPda, TOKEN_PROGRAM_ID);

    let threw = false;
    try {
      await callAddAllowedProgram(passkey, walletPda, policyPda, TOKEN_PROGRAM_ID);
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "een tweede add_allowed_program met hetzelfde programma-ID had moeten falen"
    );
  });

  it("remove_allowed_program verwijdert een programma en houdt de lijst aaneengesloten (swap-remove)", async () => {
    const { passkey, walletPda, policyPda } = await createWallet();
    const progA = Keypair.generate().publicKey;
    const progB = Keypair.generate().publicKey;
    await callAddAllowedProgram(passkey, walletPda, policyPda, progA);
    await callAddAllowedProgram(passkey, walletPda, policyPda, progB);

    await callRemoveAllowedProgram(passkey, walletPda, policyPda, progA);

    const policy = await program.account.policyAccount.fetch(policyPda);
    assert.equal(policy.count, 1);
    assert.equal(policy.allowedPrograms[0].toBase58(), progB.toBase58());
  });

  it("remove_allowed_program faalt als het programma niet op de lijst staat (ProgramNotAllowed)", async () => {
    const { passkey, walletPda, policyPda } = await createWallet();
    await callAddAllowedProgram(passkey, walletPda, policyPda, TOKEN_PROGRAM_ID);

    let threw = false;
    try {
      await callRemoveAllowedProgram(passkey, walletPda, policyPda, Keypair.generate().publicKey);
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "remove_allowed_program voor een niet-toegestaan programma had moeten falen"
    );
  });

  // STATUS.md sectie 131 (vervolg op sectie 115/127-130): execute_advanced
  // is permanent geblokkeerd voor directe aanroep sinds die sectie. Deze
  // test bewijst de allowlist-weigering nu via initiate_advanced_action
  // (dat exact dezelfde ProgramNotAllowed-check herhaalt, zie
  // instructions.rs). De twee tests die hier stonden voor een ECHTE CPI
  // (System::Assign en SPL Token::transfer) zijn verplaatst naar
  // tests/pendingAction.ts's kind=2-blok (yarn test:pending-action) - een
  // echte CPI loopt nu altijd via finalize_advanced_action, na de
  // wachtrij-timelock. De System::Assign-variant bleek daar al 1:1 te
  // overlappen met de bestaande "1. happy path"-test (bevestigd, geen
  // duplicaat toegevoegd); de Token::transfer-variant staat er als nieuwe,
  // niet eerder gedekte test bij.
  it("initiate_advanced_action faalt tegen een programma dat niet op de allowlist staat (ProgramNotAllowed)", async () => {
    const { passkey, walletPda, vaultPda, policyPda, pendingActionPda } = await createWallet();
    // Policy-account bestaat (met een ANDER programma erop), zodat dit
    // specifiek de ProgramNotAllowed-tak test, niet een ontbrekend account.
    await callAddAllowedProgram(passkey, walletPda, policyPda, TOKEN_PROGRAM_ID);

    let threw = false;
    try {
      await callInitiateAdvancedAction(
        passkey,
        walletPda,
        vaultPda,
        pendingActionPda,
        policyPda,
        SystemProgram.programId,
        [],
        Buffer.from([])
      );
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "initiate_advanced_action tegen een niet-toegestaan programma had moeten falen"
    );
  });
});
