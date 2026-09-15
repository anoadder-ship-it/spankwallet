import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { assert } from "chai";
import * as path from "path";
import type { Spankwallet } from "../target/types/spankwallet";
import idl from "../target/idl/spankwallet.json";
import { startLocalValidator, LocalValidatorHandle } from "./migrateWalletAccountValidator";

/**
 * STATUS.md sectie 143 (live-validator-integratietest van
 * migrate_wallet_account, "Deel A" - de permanente regressietest). Draait
 * tegen een EIGEN, apart opgestarte solana-test-validator (zie
 * ./migrateWalletAccountValidator.ts), NIET tegen de ambient validator van de rest
 * van de suite - nodig omdat deze test drie synthetische
 * WalletAccountOld-shaped accounts (231/239/247 bytes) al bij validator-
 * genesis op hun exacte, vooraf berekende PDA-adressen moet laten bestaan
 * (tests/fixtures/migrateWalletAccountOld{231,239,247}.json). Puur
 * synthetisch, geen enkele /tmp-afhankelijkheid en geen echte devnet-data -
 * dat is precies het verschil met Deel B (zie STATUS.md), dat WEL echte,
 * eerder opgehaalde devnet-bytes gebruikt en NIET wordt gecommit.
 *
 * De drie fixtures zijn eenmalig gegenereerd (zie STATUS.md sectie 143 voor
 * het generatorscript) met vaste, deterministische seed_key/backup_authority-
 * bytes - de onderstaande constanten zijn de uitkomst van die generatie,
 * hier letterlijk overgenomen zodat dit testbestand zelfstandig leesbaar is
 * zonder het (niet-gecommitte) generatorscript opnieuw te hoeven draaien.
 */

const PROGRAM_ID = new PublicKey("9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9");
const CREATED_AT = 1_700_000_000;
const RECOVERY_TIMELOCK_SECONDS = 259_200;

interface Fixture {
  label: string;
  oldLen: number;
  seedKeyHex: string;
  walletSeedHashHex: string;
  walletPda: PublicKey;
  walletBump: number;
  vaultBump: number;
  backupAuthority: PublicKey;
  expectedActionNonce: bigint;
  expectedSessionEpoch: bigint;
  lamportsAtGenesis: number;
  fixtureFile: string;
}

const FIXTURES: Fixture[] = [
  {
    label: "231-byte (vóór action_nonce/session_epoch)",
    oldLen: 231,
    seedKeyHex: "021d102ed73a79c9fff41d601e83b633827fdcf74d730bca5815db11b19dfa863a",
    walletSeedHashHex: "888d83890b2bc5220d370838d3ab09e6ef0091e2734708fa15afc383944ae900",
    walletPda: new PublicKey("DznfVgQWkLnCGbTijbFPQfSMiyFMPGgxmygfo3aJ7QZT"),
    walletBump: 254,
    vaultBump: 255,
    backupAuthority: new PublicKey("4iarHE9cqFWyHqgUwBLGhQKr9pBHCa48rWwd3B6Ufe3V"),
    expectedActionNonce: 0n,
    expectedSessionEpoch: 0n,
    lamportsAtGenesis: 1_823_720,
    fixtureFile: "migrateWalletAccountOld231.json",
  },
  {
    label: "239-byte (mét action_nonce, zonder session_epoch)",
    oldLen: 239,
    seedKeyHex: "02da3a1c1ec9b8c0b6e9ce582f5d86979d685e52d4932396ba3c3e3a8c015a6b15",
    walletSeedHashHex: "7869e7a9af3c76fac77000cf39e906f7da7e722dc97e08c531df5f63ec57ae05",
    walletPda: new PublicKey("7KgftRTTMyHNrS5G5Yi371oP4iD9V2Uh4L7Rmpt67RuA"),
    walletBump: 254,
    vaultBump: 255,
    backupAuthority: new PublicKey("3XoVufsxaSi2ZktWYChB2uqCFBTmz6tt1PuFRUGVBzco"),
    expectedActionNonce: 7n,
    expectedSessionEpoch: 0n,
    lamportsAtGenesis: 1_864_360,
    fixtureFile: "migrateWalletAccountOld239.json",
  },
  {
    label: "247-byte (mét action_nonce EN session_epoch)",
    oldLen: 247,
    seedKeyHex: "029b25244c543f22ad1e91bb254424e6beef08bf739e59b3ed85fa5cf852ada473",
    walletSeedHashHex: "ae3780529ceb71c21c91fbfb9fcd7800cb272845566951b3195876cb4c913d3f",
    walletPda: new PublicKey("8Lh2PT5KteFSKTjxH3BcGJCQqoKFkqcaqYTCsxKNSRhC"),
    walletBump: 254,
    vaultBump: 254,
    backupAuthority: new PublicKey("9QMhJQQqrubrcyu9jV5QgScQiZYE8E8LcTdRpv7on2Sp"),
    expectedActionNonce: 11n,
    expectedSessionEpoch: 3n,
    lamportsAtGenesis: 1_905_000,
    fixtureFile: "migrateWalletAccountOld247.json",
  },
];

const LEDGER_DIR = path.join(__dirname, "..", ".anchor", "test-ledger-migrate-wallet-account");
const RPC_PORT = 8910;
const GOSSIP_PORT = 8015;
const FAUCET_PORT = 9905;
const DYNAMIC_PORT_RANGE = "9920-9960";

describe("spankwallet: migrate_wallet_account - live-validator-integratietest (STATUS.md sectie 143, Deel A)", function () {
  this.timeout(180_000);

  let validator: LocalValidatorHandle;
  let connection: Connection;
  let provider: anchor.AnchorProvider;
  let program: Program<Spankwallet>;
  let feePayer: Keypair;
  let rentPayer: Keypair;

  before(async function () {
    validator = await startLocalValidator({
      ledgerDir: LEDGER_DIR,
      rpcPort: RPC_PORT,
      gossipPort: GOSSIP_PORT,
      faucetPort: FAUCET_PORT,
      dynamicPortRange: DYNAMIC_PORT_RANGE,
      programId: PROGRAM_ID.toBase58(),
      programSoPath: path.join(__dirname, "..", "target", "deploy", "spankwallet.so"),
      accounts: FIXTURES.map((f) => ({
        address: f.walletPda.toBase58(),
        filepath: path.join(__dirname, "fixtures", f.fixtureFile),
      })),
    });
    connection = validator.connection;

    feePayer = Keypair.generate();
    rentPayer = Keypair.generate();
    for (const kp of [feePayer, rentPayer]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 2_000_000_000);
      await connection.confirmTransaction(sig, "confirmed");
    }

    provider = new anchor.AnchorProvider(connection, new anchor.Wallet(feePayer), {
      commitment: "confirmed",
    });
    program = new anchor.Program(idl as anchor.Idl, provider) as unknown as Program<Spankwallet>;
  });

  after(async function () {
    if (validator) {
      await validator.stop();
    }
  });

  for (const fixture of FIXTURES) {
    describe(fixture.label, () => {
      it("migreert via een echte transactie, groeit naar 256 bytes, betaalt exact het juiste rentverschil, en draagt elk veld correct over", async () => {
        // Stap 1: onafhankelijke lezing VOORAF - bevestigt dat de
        // genesis-fixture daadwerkelijk in de oude vorm bestaat (niet
        // aangenomen).
        const before = await connection.getAccountInfo(fixture.walletPda, "confirmed");
        assert.isNotNull(before, "fixture-account bestaat niet vóór migratie");
        assert.equal(before!.data.length, fixture.oldLen);
        assert.equal(before!.lamports, fixture.lamportsAtGenesis);
        assert.isTrue(before!.owner.equals(PROGRAM_ID));

        const rentPayerBefore = await connection.getBalance(rentPayer.publicKey, "confirmed");
        const rentExempt256 = await connection.getMinimumBalanceForRentExemption(256);
        const expectedTopUp = rentExempt256 - fixture.lamportsAtGenesis;
        assert.isAbove(expectedTopUp, 0, "verwacht altijd een positieve rent-topup voor elke historische grootte");

        // Stap 2: de ECHTE transactie/Context - geen offline simulatie.
        await program.methods
          .migrateWalletAccount()
          .accounts({
            wallet: fixture.walletPda,
            payer: rentPayer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([rentPayer])
          .rpc({ commitment: "confirmed" });

        // Stap 3a: onafhankelijke on-chain lezing NA migratie - RAUWE bytes,
        // niet afgeleid van "transactie is geslaagd".
        const after = await connection.getAccountInfo(fixture.walletPda, "confirmed");
        assert.isNotNull(after, "account bestaat niet meer na migratie");
        assert.equal(after!.data.length, 256, "dataLen moet exact 256 zijn na migratie");
        assert.isTrue(after!.owner.equals(PROGRAM_ID));

        // Stap 3b: exact rentverschil - de payer betaalde PRECIES
        // (rentExempt(256) - rentExempt(oudeLengte)), berekend, niet geschat.
        // rentPayer is een APARTE signer dan de transactie-fee-payer
        // (feePayer/provider.wallet), dus dit verschil bevat GEEN
        // transactiekosten.
        const rentPayerAfter = await connection.getBalance(rentPayer.publicKey, "confirmed");
        assert.equal(
          rentPayerBefore - rentPayerAfter,
          expectedTopUp,
          "rentPayer moet exact het berekende rentverschil betaald hebben, niet meer en niet minder"
        );
        assert.equal(after!.lamports, rentExempt256, "wallet-account moet na migratie exact op het rent-exempte minimum voor 256 bytes staan");

        // Stap 3c + 5: elk veld correct overgenomen, gelezen via de
        // TS-client (program.account.walletAccount.fetch) - dit is
        // tegelijk de volledige round-trip-proef (RAUWE 256-byte-lengte
        // hierboven onafhankelijk, VELDEN hier via de normale clientroute).
        const wallet = await program.account.walletAccount.fetch(fixture.walletPda, "confirmed");

        const expectedSeedKey = Buffer.from(fixture.seedKeyHex, "hex");
        const expectedWalletSeedHash = Buffer.from(fixture.walletSeedHashHex, "hex");

        assert.deepEqual(Buffer.from(wallet.seedKey), expectedSeedKey, "seed_key niet correct overgenomen");
        assert.deepEqual(
          Buffer.from(wallet.walletSeedHash),
          expectedWalletSeedHash,
          "wallet_seed_hash niet correct overgenomen"
        );
        assert.deepEqual(
          Buffer.from(wallet.ownerPasskey),
          expectedSeedKey,
          "owner_passkey (= seed_key voor een vers account) niet correct overgenomen"
        );
        assert.equal(wallet.bump, fixture.walletBump, "bump niet correct overgenomen");
        assert.equal(wallet.vaultBump, fixture.vaultBump, "vault_bump niet correct overgenomen");
        assert.equal(wallet.createdAt.toNumber(), CREATED_AT, "created_at niet correct overgenomen");
        assert.isTrue(
          wallet.backupAuthority.equals(fixture.backupAuthority),
          "backup_authority niet correct overgenomen"
        );
        assert.isNull(wallet.recoveryState, "recovery_state moet None blijven (fixture had geen actieve recovery)");
        assert.equal(
          wallet.recoveryTimelockSeconds.toNumber(),
          RECOVERY_TIMELOCK_SECONDS,
          "recovery_timelock_seconds niet correct overgenomen"
        );
        assert.isNull(wallet.depositAuthority, "deposit_authority moet None blijven");
        assert.equal(
          BigInt(wallet.actionNonce.toString()),
          fixture.expectedActionNonce,
          "action_nonce niet correct overgenomen"
        );
        assert.equal(
          BigInt(wallet.sessionEpoch.toString()),
          fixture.expectedSessionEpoch,
          "session_epoch niet correct overgenomen"
        );
        assert.equal(
          wallet.spendThresholdLamports.toNumber(),
          0,
          "spend_threshold_lamports moet 0 zijn (nieuw veld, bestond niet in WalletAccountOld)"
        );
        assert.equal(wallet.disarmed, false, "disarmed moet false zijn (nieuw veld, bestond niet in WalletAccountOld)");
      });

      it("een tweede migrate_wallet_account-aanroep op hetzelfde, al-gemigreerde account faalt schoon met WalletAccountAlreadyMigrated - geen dubbele migratie, geen corruptie", async () => {
        const beforeSecondCall = await connection.getAccountInfo(fixture.walletPda, "confirmed");
        assert.isNotNull(beforeSecondCall);
        assert.equal(beforeSecondCall!.data.length, 256, "voorwaarde: account moet al gemigreerd zijn door de vorige test");
        const rentPayerBefore = await connection.getBalance(rentPayer.publicKey, "confirmed");

        let threw = false;
        let errorCode: string | undefined;
        try {
          await program.methods
            .migrateWalletAccount()
            .accounts({
              wallet: fixture.walletPda,
              payer: rentPayer.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([rentPayer])
            .rpc({ commitment: "confirmed" });
        } catch (err) {
          threw = true;
          if (err instanceof anchor.AnchorError) {
            errorCode = err.error.errorCode.code;
          } else {
            errorCode = String(err);
          }
        }

        assert.isTrue(threw, "een tweede migratie-aanroep had moeten falen, maar slaagde stilzwijgend");
        assert.equal(
          errorCode,
          "WalletAccountAlreadyMigrated",
          `verkeerde foutcode voor een dubbele migratiepoging: ${errorCode}`
        );

        // Geen corruptie: een gefaalde transactie rolt volledig terug op
        // Solana (atomisch) - onafhankelijk geverifieerd door de RAUWE bytes
        // en rentPayer's saldo exact ongewijzigd te bevestigen, niet enkel
        // "transactie faalde" aan te nemen.
        const afterSecondCall = await connection.getAccountInfo(fixture.walletPda, "confirmed");
        assert.isNotNull(afterSecondCall);
        assert.deepEqual(
          afterSecondCall!.data,
          beforeSecondCall!.data,
          "accountbytes mogen NIET veranderd zijn na een gefaalde tweede migratiepoging"
        );
        assert.equal(
          afterSecondCall!.lamports,
          beforeSecondCall!.lamports,
          "account-lamports mogen NIET veranderd zijn na een gefaalde tweede migratiepoging"
        );
        const rentPayerAfter = await connection.getBalance(rentPayer.publicKey, "confirmed");
        assert.equal(
          rentPayerAfter,
          rentPayerBefore,
          "rentPayer mag GEEN lamports kwijtraken aan een gefaalde tweede migratiepoging (guard draait vóór elke lamport-overdracht)"
        );
      });
    });
  }
});
