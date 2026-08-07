import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { createHash, randomBytes } from "crypto";
import { assert } from "chai";
import BN from "bn.js";
import type { Spankwallet } from "../target/types/spankwallet";

describe("spankwallet: init_wallet", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Spankwallet as Program<Spankwallet>;

  // BELANGRIJK: dit is GEEN echte secp256r1 passkey-publieke sleutel, slechts
  // 33 willekeurige bytes. init_wallet vereist geen passkey-handtekening (de
  // payer tekent als gewone Anchor Signer) — deze test valideert dus alleen
  // de account-/PDA-aanmaaklogica uit v0.2 §3.1/§3.2, NIET de
  // secp256r1-precompile-verificatie in verify_passkey_signature. Die laatste
  // vereist een echte WebAuthn-handtekening en is een aparte, latere test.
  //
  // ECHTE randomness i.p.v. een vaste/deterministische waarde: Anchor.toml
  // draait tegen ECHT devnet, waar accounts PERMANENT blijven bestaan tussen
  // testruns. Een vaste seed_key botst bij elke herhaalde `anchor test`-run
  // (of bij toevallige overlap met een andere testfile) op een reeds
  // bestaande PDA ("already in use") — precies wat er gebeurde toen
  // recovery.ts's eerste test toevallig dezelfde vaste waarde gebruikte als
  // deze file. Randomness lost dit bij de bron op, voor alle testfiles
  // tegelijk en voor elke herhaalde run.
  function dummySeedKey(): number[] {
    return Array.from(randomBytes(33));
  }

  function derivePdas(seedKey: number[]) {
    // Moet exact overeenkomen met hash_seed_key() in instructions.rs: SHA-256
    // over de ruwe 33-byte seed_key, want die 33 bytes overschrijden Solana's
    // 32-byte-per-seed-limiet en kunnen dus nooit direct als PDA-seed dienen.
    const seedHash = createHash("sha256").update(Buffer.from(seedKey)).digest();

    const [walletPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("wallet"), seedHash],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), walletPda.toBuffer()],
      program.programId
    );
    // walletSeedHash als number[] teruggeven — dit is het instructie-argument
    // dat het programma nu zelf on-chain herverifieert (require! in
    // init_wallet), zie README §"KRITIEKE BUG... E0425".
    return { walletPda, vaultPda, walletSeedHash: Array.from(seedHash) };
  }

  it("maakt WalletAccount + VaultAccount aan met correcte default-waarden", async () => {
    const seedKey = dummySeedKey();
    const backupAuthority = Keypair.generate();
    const { walletPda, vaultPda, walletSeedHash } = derivePdas(seedKey);

    await program.methods
      .initWallet(seedKey, walletSeedHash, backupAuthority.publicKey, null)
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const wallet = await program.account.walletAccount.fetch(walletPda);

    // seed_key en owner_passkey moeten bij aanmaak identiek zijn (v0.2 §3.1:
    // seed_key is onveranderlijk, owner_passkey muteert pas bij recovery).
    assert.deepEqual(Array.from(wallet.seedKey), seedKey);
    assert.deepEqual(Array.from(wallet.ownerPasskey), seedKey);

    // wallet_seed_hash moet exact de SHA-256 van seed_key zijn (32 bytes,
    // de daadwerkelijke PDA-seed-waarde — zie hash_seed_key in instructions.rs).
    const expectedHash = createHash("sha256").update(Buffer.from(seedKey)).digest();
    assert.deepEqual(Buffer.from(wallet.walletSeedHash), expectedHash);

    assert.equal(
      wallet.backupAuthority.toBase58(),
      backupAuthority.publicKey.toBase58()
    );

    // recovery_state moet leeg zijn direct na aanmaak.
    assert.isNull(wallet.recoveryState);

    // default timelock: 259200s = 72u (DEFAULT_RECOVERY_TIMELOCK_SECONDS, state.rs).
    assert.equal(wallet.recoveryTimelockSeconds.toNumber(), 259200);

    // fase 1: deposit_authority moet None zijn (permissionless deposits, §3.3).
    assert.isNull(wallet.depositAuthority);

    const vault = await program.account.vaultAccount.fetch(vaultPda);
    assert.equal(vault.wallet.toBase58(), walletPda.toBase58());
  });

  it("respecteert een expliciete recovery_timelock_seconds i.p.v. de default", async () => {
    const seedKey = dummySeedKey();
    const backupAuthority = Keypair.generate();
    const { walletPda, vaultPda, walletSeedHash } = derivePdas(seedKey);
    const customTimelock = new BN(3600); // 1 uur, puur voor deze test

    await program.methods
      .initWallet(seedKey, walletSeedHash, backupAuthority.publicKey, customTimelock)
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const wallet = await program.account.walletAccount.fetch(walletPda);
    assert.equal(wallet.recoveryTimelockSeconds.toNumber(), 3600);
  });

  it("faalt bij een tweede init_wallet met dezelfde seed_key (PDA bestaat al)", async () => {
    const seedKey = dummySeedKey();
    const backupAuthority = Keypair.generate();
    const { walletPda, vaultPda, walletSeedHash } = derivePdas(seedKey);

    const accounts = {
      wallet: walletPda,
      vault: vaultPda,
      payer: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    };

    await program.methods
      .initWallet(seedKey, walletSeedHash, backupAuthority.publicKey, null)
      .accounts(accounts)
      .rpc();

    let threw = false;
    try {
      await program.methods
        .initWallet(seedKey, walletSeedHash, backupAuthority.publicKey, null)
        .accounts(accounts)
        .rpc();
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "een tweede init_wallet-aanroep met dezelfde seed_key had moeten falen (PDA bestaat al)"
    );
  });
});
