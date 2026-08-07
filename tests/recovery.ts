import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { createHash, randomBytes } from "crypto";
import { assert } from "chai";
import BN from "bn.js";
import type { Spankwallet } from "../target/types/spankwallet";

describe("spankwallet: recovery-flow (initiate/finalize, zonder passkey)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Spankwallet as Program<Spankwallet>;

  // Zelfde opzet als in spankwallet.ts: geen echte secp256r1-sleutel nodig
  // voor init_wallet/initiate_recovery/finalize_recovery — die vereisen geen
  // passkey-handtekening. Alleen cancel_recovery (owner-veto) en execute/hunt
  // vereisen de secp256r1-precompile en zijn dus NIET hier getest — die
  // wachten op een echte WebAuthn-passkey (zie README, browser-testpagina).
  //
  // ECHTE randomness i.p.v. vaste fill-waarden: Anchor.toml draait tegen ECHT
  // devnet, waar accounts PERMANENT blijven bestaan tussen testruns. Vaste
  // seed_keys botsten hierdoor zowel tussen testfiles onderling als bij elke
  // herhaalde `anchor test`-run ("already in use") — zie README voor de volle
  // uitleg. Randomness lost dit bij de bron op.
  function dummySeedKey(): number[] {
    return Array.from(randomBytes(33));
  }

  function dummyNewOwnerPasskey(): number[] {
    return Array.from(randomBytes(33));
  }

  function derivePdas(seedKey: number[]) {
    const seedHash = createHash("sha256").update(Buffer.from(seedKey)).digest();
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

  async function createWallet(timelockSeconds?: number) {
    const seedKey = dummySeedKey();
    const backupAuthority = Keypair.generate();
    const { walletPda, vaultPda, walletSeedHash } = derivePdas(seedKey);

    await program.methods
      .initWallet(
        seedKey,
        walletSeedHash,
        backupAuthority.publicKey,
        timelockSeconds != null ? new BN(timelockSeconds) : null
      )
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { seedKey, backupAuthority, walletPda, vaultPda };
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
    // owner_passkey mag nog NIET gewijzigd zijn — pas na finalize_recovery.
    assert.deepEqual(Array.from(wallet.ownerPasskey), seedKey);

    const initiatedAt = wallet.recoveryState.initiatedAt.toNumber();
    assert.isAtLeast(initiatedAt, beforeTs - 5); // kleine marge voor klokverschil
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
    // Timelock ruim genoeg om de assertie hierna te draaien (10s), maar kort
    // genoeg om de andere tests niet te lang op te houden.
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
    const timelockSeconds = 3; // kort gehouden zodat de test snel blijft
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

    // seed_key mag NOOIT muteren, ook niet na recovery (zie state.rs §3.1 —
    // dit is precies de eerder gevonden kritieke PDA-adresseringsbug). We
    // vergelijken met de seedKey die createWallet() daadwerkelijk gebruikte,
    // niet met een opnieuw gegenereerde waarde (die zou vanwege de
    // randomness sowieso nooit matchen).
    assert.deepEqual(Array.from(wallet.seedKey), seedKey);
  });
});
