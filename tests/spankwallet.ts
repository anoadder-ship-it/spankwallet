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
  TestPasskey,
} from "./webauthnTestHelper";

describe("spankwallet: init_wallet", () => {
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
    return { walletPda, vaultPda, walletSeedHash: Array.from(seedHash) };
  }

  // init_wallet vereist sinds STATUS.md sectie 22 een ECHTE secp256r1-
  // handtekening (bewijs van bezit, voorkomt het front-running-risico uit
  // Bevinding C). Deze helper bouwt de volledige flow: echt keypair, de
  // exacte on-chain challenge, een synthetische-maar-cryptografisch-echte
  // WebAuthn-handtekening, en de precompile-instructie ervoor.
  async function callInitWallet(
    passkey: TestPasskey,
    walletPda: PublicKey,
    vaultPda: PublicKey,
    walletSeedHash: number[],
    backupAuthority: PublicKey,
    recoveryTimelockSeconds: BN | null
  ) {
    const payload = Buffer.concat([
      backupAuthority.toBuffer(),
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

    return program.methods
      .initWallet(
        Array.from(passkey.compressedPublicKey),
        walletSeedHash,
        backupAuthority,
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
  }

  it("maakt WalletAccount + VaultAccount aan met correcte default-waarden", async () => {
    const passkey = generateTestPasskey();
    const backupAuthority = Keypair.generate();
    const { walletPda, vaultPda, walletSeedHash } = derivePdas(passkey.compressedPublicKey);

    await callInitWallet(passkey, walletPda, vaultPda, walletSeedHash, backupAuthority.publicKey, null);

    const wallet = await program.account.walletAccount.fetch(walletPda);

    assert.deepEqual(Array.from(wallet.seedKey), Array.from(passkey.compressedPublicKey));
    assert.deepEqual(Array.from(wallet.ownerPasskey), Array.from(passkey.compressedPublicKey));

    const expectedHash = createHash("sha256").update(passkey.compressedPublicKey).digest();
    assert.deepEqual(Buffer.from(wallet.walletSeedHash), expectedHash);

    assert.equal(
      wallet.backupAuthority.toBase58(),
      backupAuthority.publicKey.toBase58()
    );

    assert.isNull(wallet.recoveryState);
    assert.equal(wallet.recoveryTimelockSeconds.toNumber(), 259200);
    assert.isNull(wallet.depositAuthority);

    const vault = await program.account.vaultAccount.fetch(vaultPda);
    assert.equal(vault.wallet.toBase58(), walletPda.toBase58());
  });

  it("respecteert een expliciete recovery_timelock_seconds i.p.v. de default", async () => {
    const passkey = generateTestPasskey();
    const backupAuthority = Keypair.generate();
    const { walletPda, vaultPda, walletSeedHash } = derivePdas(passkey.compressedPublicKey);
    const customTimelock = new BN(3600);

    await callInitWallet(
      passkey,
      walletPda,
      vaultPda,
      walletSeedHash,
      backupAuthority.publicKey,
      customTimelock
    );

    const wallet = await program.account.walletAccount.fetch(walletPda);
    assert.equal(wallet.recoveryTimelockSeconds.toNumber(), 3600);
  });

  it("faalt bij een tweede init_wallet met dezelfde seed_key (PDA bestaat al)", async () => {
    const passkey = generateTestPasskey();
    const backupAuthority = Keypair.generate();
    const { walletPda, vaultPda, walletSeedHash } = derivePdas(passkey.compressedPublicKey);

    await callInitWallet(passkey, walletPda, vaultPda, walletSeedHash, backupAuthority.publicKey, null);

    let threw = false;
    try {
      await callInitWallet(passkey, walletPda, vaultPda, walletSeedHash, backupAuthority.publicKey, null);
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "een tweede init_wallet-aanroep met dezelfde seed_key had moeten falen (PDA bestaat al)"
    );
  });
});
