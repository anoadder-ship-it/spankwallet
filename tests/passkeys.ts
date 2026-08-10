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
  TestPasskey,
} from "./webauthnTestHelper";

describe("spankwallet: multi-passkey (add_passkey / remove_passkey) + finalize_recovery-wipe", () => {
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
    const [passkeysPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("passkeys"), walletPda.toBuffer()],
      program.programId
    );
    return { walletPda, vaultPda, passkeysPda, walletSeedHash: Array.from(seedHash) };
  }

  // init_wallet vereist een echte secp256r1-handtekening (STATUS.md sectie
  // 22) - zelfde aanpak als de andere testbestanden.
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

    return { passkey, backupAuthority, walletPda, vaultPda, passkeysPda };
  }

  async function callAddPasskey(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    passkeysPda: PublicKey,
    newPasskeyBytes: Buffer
  ) {
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "add_passkey",
      newPasskeyBytes
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      signingPasskey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    return program.methods
      .addPasskey(Array.from(newPasskeyBytes), clientDataJSON)
      .accounts({
        wallet: walletPda,
        passkeys: passkeysPda,
        payer: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  async function callRemovePasskey(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    passkeysPda: PublicKey,
    targetPasskeyBytes: Buffer
  ) {
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "remove_passkey",
      targetPasskeyBytes
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      signingPasskey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    return program.methods
      .removePasskey(Array.from(targetPasskeyBytes), clientDataJSON)
      .accounts({
        wallet: walletPda,
        passkeys: passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  // add_allowed_program hergebruikt als "willekeurige andere passkey-
  // geverifieerde instructie" om aan te tonen dat een net toegevoegde/
  // verwijderde sleutel daadwerkelijk wel/geen zeggenschap heeft - niet
  // omdat de allowlist zelf relevant is voor deze tests.
  async function callAddAllowedProgramAs(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    programIdToAllow: PublicKey
  ) {
    const [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), walletPda.toBuffer()],
      program.programId
    );
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "add_allowed_program",
      programIdToAllow.toBuffer()
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      signingPasskey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    return program.methods
      .addAllowedProgram(programIdToAllow, clientDataJSON)
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

  function dummyNewOwnerPasskey(): number[] {
    const bytes = randomBytes(33);
    bytes[0] = 0x02;
    return Array.from(bytes);
  }

  it("add_passkey voegt een extra passkey toe aan een nieuw (init_if_needed) passkeys-account", async () => {
    const { passkey, walletPda, passkeysPda } = await createWallet();
    const extra = generateTestPasskey();

    await callAddPasskey(passkey, walletPda, passkeysPda, extra.compressedPublicKey);

    const passkeys = await program.account.passkeysAccount.fetch(passkeysPda);
    assert.equal(passkeys.count, 1);
    assert.isFalse(passkeys.ownerPasskeyRevoked);
    assert.deepEqual(
      Array.from(passkeys.additionalPasskeys[0]),
      Array.from(extra.compressedPublicKey)
    );
  });

  it("een net toegevoegde passkey heeft daadwerkelijk volledige zeggenschap (kan zelf add_allowed_program ondertekenen)", async () => {
    const { passkey, walletPda, passkeysPda } = await createWallet();
    const extra = generateTestPasskey();
    await callAddPasskey(passkey, walletPda, passkeysPda, extra.compressedPublicKey);

    // Ondertekend met de NIEUWE, extra sleutel - niet met de oorspronkelijke
    // owner_passkey - om te bewijzen dat deze daadwerkelijk gelijke,
    // volledige zeggenschap heeft (geen rollen, zie STATUS.md).
    await callAddAllowedProgramAs(extra, walletPda, SystemProgram.programId);

    const [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), walletPda.toBuffer()],
      program.programId
    );
    const policy = await program.account.policyAccount.fetch(policyPda);
    assert.equal(policy.count, 1);
    assert.equal(policy.allowedPrograms[0].toBase58(), SystemProgram.programId.toBase58());
  });

  it("add_passkey faalt bij het opnieuw toevoegen van owner_passkey zelf (PasskeyAlreadyRegistered)", async () => {
    const { passkey, walletPda, passkeysPda } = await createWallet();

    let threw = false;
    try {
      await callAddPasskey(passkey, walletPda, passkeysPda, passkey.compressedPublicKey);
    } catch (err) {
      threw = true;
    }
    assert.isTrue(threw, "add_passkey met owner_passkey zelf had moeten falen");
  });

  it("add_passkey faalt bij een duplicaat van een al toegevoegde extra passkey (PasskeyAlreadyRegistered)", async () => {
    const { passkey, walletPda, passkeysPda } = await createWallet();
    const extra = generateTestPasskey();
    await callAddPasskey(passkey, walletPda, passkeysPda, extra.compressedPublicKey);

    let threw = false;
    try {
      await callAddPasskey(passkey, walletPda, passkeysPda, extra.compressedPublicKey);
    } catch (err) {
      threw = true;
    }
    assert.isTrue(threw, "een tweede add_passkey met dezelfde sleutel had moeten falen");
  });

  it("remove_passkey verwijdert een extra passkey en houdt de lijst aaneengesloten (swap-remove)", async () => {
    const { passkey, walletPda, passkeysPda } = await createWallet();
    const extraA = generateTestPasskey();
    const extraB = generateTestPasskey();
    await callAddPasskey(passkey, walletPda, passkeysPda, extraA.compressedPublicKey);
    await callAddPasskey(passkey, walletPda, passkeysPda, extraB.compressedPublicKey);

    await callRemovePasskey(passkey, walletPda, passkeysPda, extraA.compressedPublicKey);

    const passkeys = await program.account.passkeysAccount.fetch(passkeysPda);
    assert.equal(passkeys.count, 1);
    assert.deepEqual(
      Array.from(passkeys.additionalPasskeys[0]),
      Array.from(extraB.compressedPublicKey)
    );
  });

  it("een verwijderde passkey heeft geen zeggenschap meer", async () => {
    const { passkey, walletPda, passkeysPda } = await createWallet();
    const extra = generateTestPasskey();
    await callAddPasskey(passkey, walletPda, passkeysPda, extra.compressedPublicKey);
    await callRemovePasskey(passkey, walletPda, passkeysPda, extra.compressedPublicKey);

    let threw = false;
    try {
      await callAddAllowedProgramAs(extra, walletPda, SystemProgram.programId);
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "een verwijderde passkey had geen enkele instructie meer moeten kunnen ondertekenen"
    );
  });

  it("remove_passkey faalt voor een niet-geregistreerde passkey (PasskeyNotRegistered)", async () => {
    const { passkey, walletPda, passkeysPda } = await createWallet();
    // passkeys-account moet al bestaan wil remove_passkey uberhaupt draaien
    // (geen init_if_needed, zie instructions.rs) - eerst een echte extra
    // sleutel toevoegen, dan een ANDERE, nooit-toegevoegde sleutel proberen
    // te verwijderen.
    const extra = generateTestPasskey();
    await callAddPasskey(passkey, walletPda, passkeysPda, extra.compressedPublicKey);
    const neverAdded = generateTestPasskey();

    let threw = false;
    try {
      await callRemovePasskey(passkey, walletPda, passkeysPda, neverAdded.compressedPublicKey);
    } catch (err) {
      threw = true;
    }
    assert.isTrue(threw, "remove_passkey voor een niet-geregistreerde sleutel had moeten falen");
  });

  it("remove_passkey faalt bij het verwijderen van de laatste geldige passkey (CannotRemoveLastPasskey)", async () => {
    const { passkey, walletPda, passkeysPda } = await createWallet();
    const extra = generateTestPasskey();
    // passkeys-account moet bestaan; voeg een extra sleutel toe en
    // verwijder die weer, zodat owner_passkey (nog actief) de ENIGE
    // overgebleven geldige sleutel is - exact het scenario dat de
    // lockout-bescherming moet tegenhouden.
    await callAddPasskey(passkey, walletPda, passkeysPda, extra.compressedPublicKey);
    await callRemovePasskey(passkey, walletPda, passkeysPda, extra.compressedPublicKey);

    let threw = false;
    try {
      await callRemovePasskey(passkey, walletPda, passkeysPda, passkey.compressedPublicKey);
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "het verwijderen van de allerlaatste geldige passkey had moeten falen (lockout-bescherming)"
    );
  });

  it("remove_passkey kan owner_passkey zelf intrekken zodra er een extra passkey bestaat", async () => {
    const { passkey, walletPda, passkeysPda } = await createWallet();
    const extra = generateTestPasskey();
    await callAddPasskey(passkey, walletPda, passkeysPda, extra.compressedPublicKey);

    // Nu zijn er 2 geldige sleutels (owner + extra) - owner_passkey
    // intrekken moet dus WEL mogen, met de extra sleutel als de resterende
    // geldige ondertekenaar.
    await callRemovePasskey(extra, walletPda, passkeysPda, passkey.compressedPublicKey);

    const passkeysAfter = await program.account.passkeysAccount.fetch(passkeysPda);
    assert.isTrue(passkeysAfter.ownerPasskeyRevoked);
    assert.equal(passkeysAfter.count, 1);

    // De ingetrokken owner_passkey heeft nu geen zeggenschap meer.
    let threw = false;
    try {
      await callAddAllowedProgramAs(passkey, walletPda, SystemProgram.programId);
    } catch (err) {
      threw = true;
    }
    assert.isTrue(threw, "de ingetrokken owner_passkey had geen zeggenschap meer moeten hebben");
  });

  it("add_passkey faalt tijdens een lopende recovery (RecoveryAlreadyInProgress)", async () => {
    const { passkey, backupAuthority, walletPda, passkeysPda } = await createWallet();

    await program.methods
      .initiateRecovery(dummyNewOwnerPasskey())
      .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
      .signers([backupAuthority])
      .rpc();

    const extra = generateTestPasskey();
    let threw = false;
    try {
      await callAddPasskey(passkey, walletPda, passkeysPda, extra.compressedPublicKey);
    } catch (err) {
      threw = true;
    }
    assert.isTrue(threw, "add_passkey tijdens een lopende recovery had moeten falen");
  });

  it("remove_passkey faalt tijdens een lopende recovery (RecoveryAlreadyInProgress)", async () => {
    const { passkey, backupAuthority, walletPda, passkeysPda } = await createWallet();
    const extra = generateTestPasskey();
    await callAddPasskey(passkey, walletPda, passkeysPda, extra.compressedPublicKey);

    await program.methods
      .initiateRecovery(dummyNewOwnerPasskey())
      .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
      .signers([backupAuthority])
      .rpc();

    let threw = false;
    try {
      await callRemovePasskey(passkey, walletPda, passkeysPda, extra.compressedPublicKey);
    } catch (err) {
      threw = true;
    }
    assert.isTrue(threw, "remove_passkey tijdens een lopende recovery had moeten falen");
  });

  it("finalize_recovery wist de volledige passkey-set (extra sleutels weg, owner_passkey_revoked terug naar false)", async () => {
    const timelockSeconds = 3;
    const { passkey, backupAuthority, walletPda, passkeysPda } = await createWallet(
      timelockSeconds
    );
    const extra = generateTestPasskey();
    await callAddPasskey(passkey, walletPda, passkeysPda, extra.compressedPublicKey);

    let passkeysBefore = await program.account.passkeysAccount.fetch(passkeysPda);
    assert.equal(passkeysBefore.count, 1);

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

    // passkeys-account bestaat al (add_passkey hierboven) - de ECHTE PDA
    // meegeven, niet de programma-ID-sentinel.
    await program.methods
      .finalizeRecovery()
      .accounts({ wallet: walletPda, passkeys: passkeysPda })
      .rpc();

    const wallet = await program.account.walletAccount.fetch(walletPda);
    assert.deepEqual(Array.from(wallet.ownerPasskey), newOwnerPasskey);

    const passkeysAfter = await program.account.passkeysAccount.fetch(passkeysPda);
    assert.equal(passkeysAfter.count, 0);
    assert.isFalse(passkeysAfter.ownerPasskeyRevoked);

    // De VOOR de recovery toegevoegde extra sleutel mag na de recovery geen
    // enkele zeggenschap meer hebben.
    let threw = false;
    try {
      await callAddAllowedProgramAs(extra, walletPda, SystemProgram.programId);
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "een sleutel van vóór de recovery had na de recovery geen zeggenschap meer moeten hebben"
    );
  });
});
