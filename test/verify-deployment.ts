/**
 * Deployment Verification Test
 * 
 * Verifies that:
 * 1. The active-defense program is deployed on devnet
 * 2. PDA derivation works correctly
 * 3. Account reading works (returns null for non-existent accounts)
 * 
 * Run: npx ts-node test/verify-deployment.ts
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  ACTIVE_DEFENSE_PROGRAM_ID,
  derivePoisonTokenPda,
  deriveMaliciousPda,
  readPoisonTokenAccount,
  readMaliciousAddresses,
} from "../client/src/poisonToken";

const RPC_URL = "https://api.devnet.solana.com";

async function main() {
  console.log("=".repeat(60));
  console.log("ACTIVE DEFENSE - DEPLOYMENT VERIFICATION");
  console.log("=".repeat(60));

  const connection = new Connection(RPC_URL, "confirmed");

  // ----------------------------------------------------------
  // TEST 1: Program is deployed
  // ----------------------------------------------------------
  console.log("\n[TEST 1] Program deployment check");
  console.log("-".repeat(40));

  const programAccount = await connection.getAccountInfo(
    ACTIVE_DEFENSE_PROGRAM_ID
  );

  if (programAccount) {
    console.log(`  PASS: Program found at ${ACTIVE_DEFENSE_PROGRAM_ID.toBase58()}`);
    console.log(`  Data size: ${programAccount.data.length} bytes`);
    console.log(`  Balance: ${programAccount.lamports / 1e9} SOL`);
    console.log(`  Owner: ${programAccount.owner.toBase58()}`);
  } else {
    console.log(`  FAIL: Program NOT found at ${ACTIVE_DEFENSE_PROGRAM_ID.toBase58()}`);
    process.exit(1);
  }

  // ----------------------------------------------------------
  // TEST 2: PDA derivation
  // ----------------------------------------------------------
  console.log("\n[TEST 2] PDA derivation");
  console.log("-".repeat(40));

  // Use a mock wallet PDA for testing
  const mockWalletPda = new PublicKey(
    "9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9"
  );
  const mockMint = new PublicKey(
    "So11111111111111111111111111111111111111112"
  ); // Wrapped SOL mint

  const [poisonTokenPda, poisonBump] = derivePoisonTokenPda(
    mockWalletPda,
    mockMint
  );
  console.log(`  Poison Token PDA: ${poisonTokenPda.toBase58()}`);
  console.log(`  Bump: ${poisonBump}`);

  const [maliciousPda, maliciousBump] = deriveMaliciousPda(mockWalletPda);
  console.log(`  Malicious PDA: ${maliciousPda.toBase58()}`);
  console.log(`  Bump: ${maliciousBump}`);

  // Verify PDAs are valid (not all zeros)
  if (
    poisonTokenPda.toBytes().every((b) => b === 0) ||
    maliciousPda.toBytes().every((b) => b === 0)
  ) {
    console.log("  FAIL: PDA derivation produced zero address");
    process.exit(1);
  }
  console.log("  PASS: PDAs derived successfully");

  // ----------------------------------------------------------
  // TEST 3: Account reading (should return null for non-existent)
  // ----------------------------------------------------------
  console.log("\n[TEST 3] Account reading (non-existent accounts)");
  console.log("-".repeat(40));

  const poisonInfo = await readPoisonTokenAccount(
    connection,
    mockWalletPda,
    mockMint
  );
  if (poisonInfo === null) {
    console.log("  PASS: Poison Token account correctly returns null (not created yet)");
  } else {
    console.log(`  INFO: Poison Token account exists!`);
    console.log(`    Triggered: ${poisonInfo.triggered}`);
    console.log(`    Authorized recipients: ${poisonInfo.authorizedRecipients.length}`);
  }

  const maliciousInfo = await readMaliciousAddresses(
    connection,
    mockWalletPda
  );
  if (maliciousInfo === null) {
    console.log("  PASS: Malicious account correctly returns null (not created yet)");
  } else {
    console.log(`  INFO: Malicious account exists!`);
    console.log(`    Addresses: ${maliciousInfo.addresses.length}`);
  }

  // ----------------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------------
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log(`  Program ID:    ${ACTIVE_DEFENSE_PROGRAM_ID.toBase58()}`);
  console.log(`  Cluster:       devnet`);
  console.log(`  Program size:  ${programAccount!.data.length} bytes`);
  console.log(`  Status:        LIVE`);
  console.log("=".repeat(60));
  console.log("\nAll verification checks passed.");
  console.log("Next step: Create a poison token with a real spankwallet instance.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
