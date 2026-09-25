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

  // STATUS.md sectie 141-vervolg (bronfix): empirisch bewijs, niet alleen
  // beredeneerd, dat cancel_recovery/finalize_recovery de vrijgekomen
  // RecoveryState-payload-bytes ECHT nullen - niet alleen dat
  // recovery_state logisch None decodeert (dat zou de kapotte, ongefixte
  // situatie ook al laten "slagen", want de tag zelf was altijd al correct
  // 0).
  //
  // BELANGRIJKE CORRECTIE (empirisch ontdekt tijdens de rood/groen-run,
  // NIET vooraf voorzien): de eerste versie van deze test beweerde dat het
  // VOLLEDIGE 41-byte-gebied [149, 190) na de fix nul moet zijn. Dat is
  // ONJUIST en gaf, mét de fix actief, alsnog een falende (rode) test - de
  // bronfix nult die 41 bytes wel degelijk, maar Anchor's eigen, normale
  // exit()-serialisatie schrijft er DAARNA overheen met de echte,
  // legitieme veldwaarden die daadwerkelijk in dat gebied thuishoren
  // (recovery_timelock_seconds, deposit_authority-tag, action_nonce,
  // session_epoch, spend_threshold_lamports, disarmed - stuk voor stuk
  // echte data, geen stale bytes). Alleen het STUKJE ACHTER het laatste
  // huidige veld (`disarmed`) - de 7 bytes die GEEN enkel veld van de
  // huidige structuurdefinitie beslaat, maar wél binnen de historisch
  // gereserveerde RecoveryState-payload-ruimte valt - hoort na de fix nul
  // te zijn. Dát is precies de regio die een TOEKOMSTIGE, langere
  // structuurdefinitie zou lezen als nieuwe velden, en dus precies de
  // regio die de bronfix moet beschermen.
  //
  // Alle offsets hier zijn bewust letterlijk overgenomen uit state.rs (niet
  // geïmporteerd) - een toekomstige veldherordening/-toevoeging die deze
  // constanten laat verschuiven zou dit testbewijs dan ook zelf moeten
  // bijwerken, geen stille aanname.
  //
  // Sectie 159: sinds recovery_nonce_snapshot (8 bytes, achter `disarmed`)
  // zijn de 7 bytes hieronder niet meer "buiten elk veld", maar de eerste 7
  // bytes van dat nieuwe veld. cancel_recovery en finalize_recovery zetten
  // het op 0, dus de check blijft geldig en dekt nu ook die reset. De
  // bytes daarna (vanaf 191) vallen buiten deze test, zoals voorheen de
  // bytes vanaf 190.
  const RECOVERY_STATE_PAYLOAD_OFFSET = 149; // WalletAccount::RECOVERY_STATE_PAYLOAD_OFFSET
  const RECOVERY_STATE_PAYLOAD_LEN = 41; // RecoveryState::LEN
  // Einde van wat de HUIDIGE struct daadwerkelijk beschrijft, vanaf
  // RECOVERY_STATE_PAYLOAD_OFFSET: recovery_timelock_seconds(8) +
  // deposit_authority-tag(1) + action_nonce(8) + session_epoch(8) +
  // spend_threshold_lamports(8) + disarmed(1) = 34 bytes.
  const CURRENT_STRUCT_FIELDS_LEN_AFTER_TAG = 8 + 1 + 8 + 8 + 8 + 1;
  const STALE_TAIL_OFFSET = RECOVERY_STATE_PAYLOAD_OFFSET + CURRENT_STRUCT_FIELDS_LEN_AFTER_TAG; // 183
  const STALE_TAIL_LEN =
    RECOVERY_STATE_PAYLOAD_LEN - CURRENT_STRUCT_FIELDS_LEN_AFTER_TAG; // 7

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

  async function assertStaleTailZeroedAndCurrentFieldsPlausible(
    walletPda: PublicKey,
    label: string
  ) {
    const raw = await provider.connection.getAccountInfo(walletPda);
    const fullRegion = raw!.data.subarray(
      RECOVERY_STATE_PAYLOAD_OFFSET,
      RECOVERY_STATE_PAYLOAD_OFFSET + RECOVERY_STATE_PAYLOAD_LEN
    );
    const staleTail = raw!.data.subarray(STALE_TAIL_OFFSET, STALE_TAIL_OFFSET + STALE_TAIL_LEN);

    // De eigenlijke bronfix-bewering: het stukje ACHTER de huidige velden,
    // dat een toekomstige langere structuurdefinitie zou lezen, moet nul
    // zijn - dit was vóór de fix aantoonbaar niet zo (zie de rode testrun).
    assert.isTrue(
      staleTail.every((b) => b === 0),
      `${label}: de bytes ná de huidige velden (offset ${STALE_TAIL_OFFSET}..${
        STALE_TAIL_OFFSET + STALE_TAIL_LEN
      }, buiten het bereik van elk huidig veld) horen 0x00 te zijn ná de bronfix, kreeg: ${staleTail.toString(
        "hex"
      )}`
    );

    // Sanity-check op het OVERIGE deel (149..183): dat hoort NIET leeg te
    // zijn - dat is waar recovery_timelock_seconds/deposit_authority-tag/
    // action_nonce/session_epoch/spend_threshold_lamports/disarmed
    // daadwerkelijk staan, door Anchors eigen exit() teruggeschreven. Puur
    // ter documentatie/contrast met de stale-tail-check hierboven, geen
    // strikte inhoudscontrole (die velden worden al apart via
    // program.account.walletAccount.fetch() gecontroleerd in de tests
    // zelf).
    assert.isFalse(
      fullRegion.subarray(0, CURRENT_STRUCT_FIELDS_LEN_AFTER_TAG).every((b) => b === 0),
      `${label}: sanity-check - het deel dat de huidige velden beslaat (149..183) hoort niet leeg te zijn`
    );
  }

  it("cancel_recovery nult de vrijgekomen RecoveryState-payload-bytes expliciet (bronfix, sectie 141)", async () => {
    const { passkey, backupAuthority, walletPda, passkeysPda } = await createWalletWithPasskey();
    const newOwnerPasskey = dummyNewOwnerPasskey();

    await program.methods
      .initiateRecovery(newOwnerPasskey)
      .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
      .signers([backupAuthority])
      .rpc();

    // Sanity-check: de payload-regio moet NIET al-nul zijn direct na
    // initiate_recovery - anders meet deze test niets zinvols.
    const rawAfterInitiate = await provider.connection.getAccountInfo(walletPda);
    const regionAfterInitiate = rawAfterInitiate!.data.subarray(
      RECOVERY_STATE_PAYLOAD_OFFSET,
      RECOVERY_STATE_PAYLOAD_OFFSET + RECOVERY_STATE_PAYLOAD_LEN
    );
    assert.isFalse(
      regionAfterInitiate.every((b) => b === 0),
      "sanity-check: de RecoveryState-payload-regio hoort NIET al-nul te zijn direct na initiate_recovery"
    );

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
    await assertStaleTailZeroedAndCurrentFieldsPlausible(walletPda, "cancel_recovery");
  });

  it("finalize_recovery nult de vrijgekomen RecoveryState-payload-bytes expliciet (bronfix, sectie 141)", async () => {
    const timelockSeconds = 3;
    const { backupAuthority, walletPda, passkeysPda } = await createWalletWithPasskey(
      timelockSeconds
    );
    const newOwnerPasskey = dummyNewOwnerPasskey();

    await program.methods
      .initiateRecovery(newOwnerPasskey)
      .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
      .signers([backupAuthority])
      .rpc();

    const rawAfterInitiate = await provider.connection.getAccountInfo(walletPda);
    const regionAfterInitiate = rawAfterInitiate!.data.subarray(
      RECOVERY_STATE_PAYLOAD_OFFSET,
      RECOVERY_STATE_PAYLOAD_OFFSET + RECOVERY_STATE_PAYLOAD_LEN
    );
    assert.isFalse(
      regionAfterInitiate.every((b) => b === 0),
      "sanity-check: de RecoveryState-payload-regio hoort NIET al-nul te zijn direct na initiate_recovery"
    );

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
    await assertStaleTailZeroedAndCurrentFieldsPlausible(walletPda, "finalize_recovery");
  });
});
