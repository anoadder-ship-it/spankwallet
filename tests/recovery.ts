import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { createHash, randomBytes } from "crypto";
import { assert } from "chai";
import BN from "bn.js";
import type { Spankwallet } from "../target/types/spankwallet";
import {
  generateTestPasskey,
  buildExpectedChallenge,
  signTestChallenge,
  buildSecp256r1Instruction,
  encodeOptionalI64,
  advanceOnChainClockPast,
  fetchActionNonce,
  nonceLeBytes,
} from "./webauthnTestHelper";

describe("spankwallet: recovery-flow (initiate/finalize - initiate en finalize zelf vereisen geen passkey, init_wallet erin wel)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Spankwallet as Program<Spankwallet>;

  // new_owner_passkey (argument van initiate_recovery) wordt hier NIET
  // cryptografisch geverifieerd - initiate_recovery vereist alleen de
  // backup_authority-handtekening, geen passkey-precompile. Puur het
  // prefix-byte moet geldig zijn (validate_passkey_prefix, STATUS.md
  // sectie 21) - vandaar dat dit nog steeds willekeurige bytes mag zijn.
  function dummyNewOwnerPasskey(): number[] {
    const bytes = randomBytes(33);
    bytes[0] = 0x02;
    return Array.from(bytes);
  }

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
    const [passkeysPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("passkeys"), walletPda.toBuffer()],
      program.programId
    );
    return { walletPda, vaultPda, passkeysPda, walletSeedHash: Array.from(seedHash) };
  }

  // init_wallet vereist sinds STATUS.md sectie 22 een ECHTE secp256r1-
  // handtekening (bewijs van bezit). Zie tests/spankwallet.ts voor dezelfde
  // aanpak, hier hergebruikt binnen deze recovery-flow-tests.
  async function createWallet(timelockSeconds?: number) {
    const passkey = generateTestPasskey();
    const backupAuthority = Keypair.generate();
    const { walletPda, vaultPda, passkeysPda, walletSeedHash } = derivePdas(
      passkey.compressedPublicKey
    );
    const recoveryTimelockSeconds = timelockSeconds != null ? new BN(timelockSeconds) : null;

    const payload = Buffer.concat([
      backupAuthority.publicKey.toBuffer(),
      encodeOptionalI64(recoveryTimelockSeconds ? recoveryTimelockSeconds.toNumber() : null),
    ]);
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
        recoveryTimelockSeconds,
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

    return {
      seedKey: Array.from(passkey.compressedPublicKey),
      backupAuthority,
      walletPda,
      vaultPda,
      passkeysPda,
    };
  }

  it("initiate_recovery zet recovery_state met de juiste new_owner_passkey", async () => {
    const { seedKey, backupAuthority, walletPda } = await createWallet();
    const newOwnerPasskey = dummyNewOwnerPasskey();

    const beforeTs = Math.floor(Date.now() / 1000);

    await program.methods
      .initiateRecovery(newOwnerPasskey)
      .accounts({
        wallet: walletPda,
        backupAuthority: backupAuthority.publicKey,
      })
      .signers([backupAuthority])
      .rpc();

    const wallet = await program.account.walletAccount.fetch(walletPda);
    assert.isNotNull(wallet.recoveryState);
    assert.deepEqual(
      Array.from(wallet.recoveryState.newOwnerPasskey),
      newOwnerPasskey
    );
    assert.deepEqual(Array.from(wallet.ownerPasskey), seedKey);

    const initiatedAt = wallet.recoveryState.initiatedAt.toNumber();
    assert.isAtLeast(initiatedAt, beforeTs - 5);
  });

  it("faalt met een verkeerde backup_authority-signer", async () => {
    const { walletPda } = await createWallet();
    const wrongSigner = Keypair.generate();
    const newOwnerPasskey = dummyNewOwnerPasskey();

    let threw = false;
    try {
      await program.methods
        .initiateRecovery(newOwnerPasskey)
        .accounts({
          wallet: walletPda,
          backupAuthority: wrongSigner.publicKey,
        })
        .signers([wrongSigner])
        .rpc();
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "initiate_recovery met een verkeerde backup_authority had moeten falen"
    );
  });

  it("faalt als er al een recovery loopt (RecoveryAlreadyInProgress)", async () => {
    const { backupAuthority, walletPda } = await createWallet();
    const newOwnerPasskey = dummyNewOwnerPasskey();

    await program.methods
      .initiateRecovery(newOwnerPasskey)
      .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
      .signers([backupAuthority])
      .rpc();

    let threw = false;
    try {
      await program.methods
        .initiateRecovery(newOwnerPasskey)
        .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
        .signers([backupAuthority])
        .rpc();
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "een tweede initiate_recovery terwijl er al een loopt had moeten falen"
    );
  });

  it("finalize_recovery faalt vóór het tijdslot is verstreken", async () => {
    const { backupAuthority, walletPda, passkeysPda } = await createWallet(10);
    const newOwnerPasskey = dummyNewOwnerPasskey();

    await program.methods
      .initiateRecovery(newOwnerPasskey)
      .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
      .signers([backupAuthority])
      .rpc();

    let threw = false;
    try {
      // B1 (STATUS.md sectie 76): passkeys is niet meer optioneel - het
      // AFGELEIDE PDA-adres meegeven, ook al bestaat het nog niet (dit
      // wallet heeft nooit add_passkey aangeroepen). De programma-ID-
      // sentinel is sinds B1 geen geldige invoer meer (faalt op de
      // seeds-constraint).
      await program.methods
        .finalizeRecovery()
        .accounts({ wallet: walletPda, passkeys: passkeysPda })
        .rpc();
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "finalize_recovery vóór afloop van het tijdslot had moeten falen"
    );
  });

  it("finalize_recovery slaagt ná het tijdslot en wijzigt owner_passkey (wallet zonder ooit add_passkey aangeroepen te hebben)", async () => {
    const timelockSeconds = 3;
    const { seedKey, backupAuthority, walletPda, passkeysPda } = await createWallet(
      timelockSeconds
    );
    const newOwnerPasskey = dummyNewOwnerPasskey();

    await program.methods
      .initiateRecovery(newOwnerPasskey)
      .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
      .signers([backupAuthority])
      .rpc();

    const afterInitiate = await program.account.walletAccount.fetch(walletPda);
    await advanceOnChainClockPast(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      afterInitiate.recoveryState.initiatedAt.toNumber() + timelockSeconds
    );

    // B1 (STATUS.md sectie 76) - dit is exact de regressie waar de B1-fix
    // het meeste risico op loopt: dit wallet heeft NOOIT add_passkey
    // aangeroepen, dus PasskeysAccount bestaat niet op dit adres. Het
    // AFGELEIDE (niet-bestaande) PDA meegeven moet nog steeds gewoon
    // slagen - een niet-bestaand account op het juiste adres is een
    // geldige, normale staat, opgevangen door de expliciete bestaanstest
    // in de instructie-body, niet door de constraint zelf.
    await program.methods
      .finalizeRecovery()
      .accounts({ wallet: walletPda, passkeys: passkeysPda })
      .rpc();

    const wallet = await program.account.walletAccount.fetch(walletPda);
    assert.deepEqual(Array.from(wallet.ownerPasskey), newOwnerPasskey);
    assert.isNull(wallet.recoveryState);
    assert.deepEqual(Array.from(wallet.seedKey), seedKey);
  });

  // STATUS.md sectie 141-vervolg (bronfix), herzien in sectie 160: bewijs
  // dat cancel_recovery/finalize_recovery na de overgang Some -> None ALLES
  // achter de nieuwe (kortere) serialisatie nullen - niet alleen dat
  // recovery_state logisch None decodeert.
  //
  // Achtergrond: Borsh schrijft bij None alleen de tagbyte; de velden
  // erachter schuiven 41 bytes op en Anchor's exit-serialisatie schrijft
  // alleen tot de nieuwe lengte. Tot en met sectie 159 nulde de bronfix een
  // VAST gebied (149..190, de oude RecoveryState-payload). Dat gebied valt
  // binnen de nieuwe serialisatie en werd dus direct weer overschreven
  // (sinds sectie 159 volledig: de None-layout loopt tot 191). De oude
  // staart - 191..232 bij een 264-byte-layout, met o.a. een kopie van de
  // oude action_nonce en de oude recovery_nonce_snapshot - bleef staan.
  // Sectie 160 nult daarom vanaf de werkelijke serialisatielengte tot het
  // einde van het account.
  //
  // Offsets letterlijk uit state.rs (niet geïmporteerd): een toekomstige
  // veldtoevoeging moet deze test bewust bijwerken.
  //
  // None/None-serialisatie (incl. discriminator): 8 + 33 + 32 + 33 + 1 + 1
  // + 8 + 32 + 1 (recovery_state-tag) + 8 + 1 (deposit_authority-tag) + 8 +
  // 8 + 8 + 1 + 8 (recovery_nonce_snapshot) = 191.
  const SERIALIZED_LEN_NONE_NONE = 191;
  const RECOVERY_NONCE_SNAPSHOT_OFFSET_NONE_NONE = SERIALIZED_LEN_NONE_NONE - 8; // 183

  async function assertTailZeroedAfterRecovery(walletPda: PublicKey, label: string) {
    const raw = await provider.connection.getAccountInfo(walletPda);
    const data = raw!.data;
    const tail = data.subarray(SERIALIZED_LEN_NONE_NONE);
    const firstNonZero = tail.findIndex((b) => b !== 0);
    assert.isTrue(
      tail.length > 0 && firstNonZero === -1,
      `${label}: alles vanaf byte ${SERIALIZED_LEN_NONE_NONE} tot het einde (${data.length}) hoort 0x00 te zijn, ` +
        `eerste niet-nul byte op ${firstNonZero === -1 ? "-" : SERIALIZED_LEN_NONE_NONE + firstNonZero}: ` +
        tail.toString("hex")
    );
    // Het laatste veld van de huidige struct (recovery_nonce_snapshot) is 0.
    assert.equal(
      data.readBigUInt64LE(RECOVERY_NONCE_SNAPSHOT_OFFSET_NONE_NONE).toString(),
      "0",
      `${label}: recovery_nonce_snapshot hoort 0 te zijn na afloop van de recovery`
    );
  }

  /// Bevriezen via de backup authority vóór de recovery: verhoogt de nonce
  /// (en zet disarmed), zodat de oude staart na afloop gegarandeerd
  /// niet-nul bytes bevat (oude action_nonce, oude momentopname). Zonder dit
  /// kon de oude staart bij een verse wallet toevallig al nul zijn en mat de
  /// test niets.
  async function freezeViaBackup(walletPda: PublicKey, backupAuthority: Keypair) {
    await program.methods
      .freezeViaBackupAuthority()
      .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
      .signers([backupAuthority])
      .rpc();
  }

  /// Sanity: direct na initiate_recovery staat er in de oude staart
  /// (vanaf 191) data - anders meet de nulcontrole erna niets.
  async function assertTailNonZeroDuringRecovery(walletPda: PublicKey) {
    const raw = await provider.connection.getAccountInfo(walletPda);
    assert.isFalse(
      raw!.data.subarray(SERIALIZED_LEN_NONE_NONE).every((b) => b === 0),
      "sanity-check: tijdens de recovery hoort er data vanaf byte 191 te staan"
    );
  }

  // createWallet() hierboven geeft geen bruikbaar TestPasskey-object terug
  // (alleen de rauwe seed_key-bytes) - cancel_recovery moet ondertekend
  // worden door de HUIDIGE owner_passkey, dus deze twee tests bouwen hun
  // eigen wallet op met een bewaard TestPasskey-object i.p.v.
  // createWallet()'s interne generatie te hergebruiken.
  async function createWalletWithPasskey(timelockSeconds?: number) {
    const passkey = generateTestPasskey();
    const backupAuthority = Keypair.generate();
    const { walletPda, vaultPda, passkeysPda, walletSeedHash } = derivePdas(
      passkey.compressedPublicKey
    );
    const recoveryTimelockSeconds = timelockSeconds != null ? new BN(timelockSeconds) : null;

    const payload = Buffer.concat([
      backupAuthority.publicKey.toBuffer(),
      encodeOptionalI64(recoveryTimelockSeconds ? recoveryTimelockSeconds.toNumber() : null),
    ]);
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
        recoveryTimelockSeconds,
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

    return { passkey, backupAuthority, walletPda, vaultPda, passkeysPda };
  }

  it("cancel_recovery nult alles achter de nieuwe serialisatie tot het einde van het account (bronfix sectie 141, herzien in sectie 160)", async () => {
    const { passkey, backupAuthority, walletPda, passkeysPda } = await createWalletWithPasskey();
    const newOwnerPasskey = dummyNewOwnerPasskey();
    await freezeViaBackup(walletPda, backupAuthority);

    await program.methods
      .initiateRecovery(newOwnerPasskey)
      .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
      .signers([backupAuthority])
      .rpc();

    await assertTailNonZeroDuringRecovery(walletPda);

    // Sectie 158/159: de challenge is gebonden aan deze recovery-poging
    // (momentopname van de nonce bij initiate_recovery), niet aan de live nonce.
    const walletAfterInitiate = await program.account.walletAccount.fetch(walletPda);
    const nonceBefore = await fetchActionNonce(provider.connection, walletPda);
    const cancelPayload = Buffer.concat([
      nonceLeBytes(BigInt(walletAfterInitiate.recoveryNonceSnapshot.toString())),
      walletAfterInitiate.recoveryState.initiatedAt.toArrayLike(Buffer, "le", 8),
      Buffer.from(walletAfterInitiate.recoveryState.newOwnerPasskey),
    ]);
    const cancelChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "cancel_recovery_v3",
      cancelPayload
    );
    const cancelSigned = signTestChallenge(passkey, cancelChallenge);
    const cancelSecpIx = buildSecp256r1Instruction(
      passkey.compressedPublicKey,
      cancelSigned.signedMessage,
      cancelSigned.rawSignature
    );

    await program.methods
      .cancelRecovery(cancelSigned.clientDataJSON)
      .accounts({
        wallet: walletPda,
        passkeys: passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([cancelSecpIx])
      .rpc();

    const walletAfterCancel = await program.account.walletAccount.fetch(walletPda);
    assert.isNull(walletAfterCancel.recoveryState);
    assert.equal(
      (await fetchActionNonce(provider.connection, walletPda)).toString(),
      (nonceBefore + 1n).toString(),
      "cancel_recovery verhoogt de nonce nog steeds"
    );
    await assertTailZeroedAfterRecovery(walletPda, "cancel_recovery");
  });

  it("finalize_recovery nult alles achter de nieuwe serialisatie tot het einde van het account (bronfix sectie 141, herzien in sectie 160)", async () => {
    const timelockSeconds = 3;
    const { backupAuthority, walletPda, passkeysPda } = await createWalletWithPasskey(
      timelockSeconds
    );
    const newOwnerPasskey = dummyNewOwnerPasskey();
    await freezeViaBackup(walletPda, backupAuthority);

    await program.methods
      .initiateRecovery(newOwnerPasskey)
      .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
      .signers([backupAuthority])
      .rpc();

    await assertTailNonZeroDuringRecovery(walletPda);

    const afterInitiate = await program.account.walletAccount.fetch(walletPda);
    await advanceOnChainClockPast(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      afterInitiate.recoveryState.initiatedAt.toNumber() + timelockSeconds
    );

    await program.methods
      .finalizeRecovery()
      .accounts({ wallet: walletPda, passkeys: passkeysPda })
      .rpc();

    const walletAfterFinalize = await program.account.walletAccount.fetch(walletPda);
    assert.isNull(walletAfterFinalize.recoveryState);
    assert.deepEqual(Array.from(walletAfterFinalize.ownerPasskey), newOwnerPasskey);
    await assertTailZeroedAfterRecovery(walletPda, "finalize_recovery");
  });
});
