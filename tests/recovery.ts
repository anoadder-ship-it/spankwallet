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
} from "./webauthnTestHelper";

describe("spankwallet: recovery-flow (initiate/finalize, zonder passkey)", () => {
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
    return { walletPda, vaultPda, walletSeedHash: Array.from(seedHash) };
  }

  // init_wallet vereist sinds STATUS.md sectie 22 een ECHTE secp256r1-
  // handtekening (bewijs van bezit). Zie tests/spankwallet.ts voor dezelfde
  // aanpak, hier hergebruikt binnen deze recovery-flow-tests.
  async function createWallet(timelockSeconds?: number) {
    const passkey = generateTestPasskey();
    const backupAuthority = Keypair.generate();
    const { walletPda, vaultPda, walletSeedHash } = derivePdas(passkey.compressedPublicKey);
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
    };
  }

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    const { backupAuthority, walletPda } = await createWallet(10);
    const newOwnerPasskey = dummyNewOwnerPasskey();

    await program.methods
      .initiateRecovery(newOwnerPasskey)
      .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
      .signers([backupAuthority])
      .rpc();

    let threw = false;
    try {
      await program.methods
        .finalizeRecovery()
        .accounts({ wallet: walletPda })
        .rpc();
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "finalize_recovery vóór afloop van het tijdslot had moeten falen"
    );
  });

  it("finalize_recovery slaagt ná het tijdslot en wijzigt owner_passkey", async () => {
    const timelockSeconds = 3;
    const { seedKey, backupAuthority, walletPda } = await createWallet(timelockSeconds);
    const newOwnerPasskey = dummyNewOwnerPasskey();

    await program.methods
      .initiateRecovery(newOwnerPasskey)
      .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
      .signers([backupAuthority])
      .rpc();

    await sleep((timelockSeconds + 2) * 1000);

    await program.methods
      .finalizeRecovery()
      .accounts({ wallet: walletPda })
      .rpc();

    const wallet = await program.account.walletAccount.fetch(walletPda);
    assert.deepEqual(Array.from(wallet.ownerPasskey), newOwnerPasskey);
    assert.isNull(wallet.recoveryState);
    assert.deepEqual(Array.from(wallet.seedKey), seedKey);
  });
});
