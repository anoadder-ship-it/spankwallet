import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";

// Leesalleen, geen anchor-build nodig: de vraag is puur "toegekende bytes
// on-chain vs. worst-case LEN van de NIEUWE (nog te deployen) layout", en
// Anchor's account-discriminator hangt uitsluitend af van de structuurNAAM,
// niet van de velden erin.
//
// Ontstaan uit STATUS.md sectie 84/85 (B1-B7-migratieveiligheid): "decodeert
// vandaag" was het VERKEERDE criterium (sectie 84 vond alle bestaande
// wallets decodeerbaar, wat de vraag maskeerde) - het juiste criterium is
// worst-case: is de toegekende accountgrootte groot genoeg voor de nieuwe
// layout ONDER ELKE TOEKOMSTIGE Option-combinatie die de HUIDIGE broncode
// daadwerkelijk kan bereiken? Draai dit VOOR elke upgrade die een nieuw veld
// achteraan WalletAccount of SessionKeyAccount toevoegt, niet alleen deze
// ene keer.
//
// BELANGRIJK bij hergebruik: `WALLET_LEN_REACHABLE_WORST_CASE` hieronder
// is GEEN pure structuur-constante - hij is afhankelijk van een aanname
// (deposit_authority kan momenteel NOOIT Some worden, geverifieerd met
// `grep -n "deposit_authority" programs/spankwallet/src/instructions.rs` -
// precies één schrijfplek, altijd `None`). Verifieer die aanname OPNIEUW
// bij elk hergebruik (een Fase-2-instructie die deposit_authority ooit op
// Some zet, maakt dit getal ongeldig - gebruik dan
// WALLET_LEN_ALL_OPTIONS_SOME in plaats daarvan).
function disc(name: string): Buffer {
  return createHash("sha256").update("account:" + name).digest().slice(0, 8);
}

const PROGRAM_ID = new PublicKey("9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9");

// Pas deze vier constanten aan per upgrade die gecontroleerd wordt.
// Huidig ingevuld voor de B1-B7-vraag (sectie 84/85, 2026-08-22).
const WALLET_LEN_ALL_OPTIONS_SOME = 247; // volledige theoretische worst case (recovery_state EN deposit_authority Some)
const WALLET_LEN_REACHABLE_WORST_CASE = 215; // recovery_state Some (initiate_recovery, echt bereikbaar), deposit_authority geforceerd None (zie waarschuwing hierboven)
const SESSION_LEN_NEW = 429; // SessionKeyAccount heeft geen Option-velden: "worst case" == enige case

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const bs58 = (await import("bs58")).default;

  console.log("=== WalletAccount ===");
  const wallets = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc("WalletAccount")) } }],
  });
  let notSafeReachable = 0;
  let notSafeAllOptionsSome = 0;
  for (const { pubkey, account } of wallets) {
    const allocated = account.data.length;
    const safeReachable = allocated >= WALLET_LEN_REACHABLE_WORST_CASE;
    const safeAllOptionsSome = allocated >= WALLET_LEN_ALL_OPTIONS_SOME;
    if (!safeReachable) notSafeReachable++;
    if (!safeAllOptionsSome) notSafeAllOptionsSome++;
    console.log(
      `${pubkey.toBase58()}  toegekend=${allocated}  ` +
      `veilig-onder-bereikbare-worst-case(${WALLET_LEN_REACHABLE_WORST_CASE})=${safeReachable}  ` +
      `veilig-onder-volledige-Option-worst-case(${WALLET_LEN_ALL_OPTIONS_SOME})=${safeAllOptionsSome}`
    );
  }
  console.log(
    `totaal WalletAccounts: ${wallets.length}, ` +
    `NIET veilig (bereikbare worst case): ${notSafeReachable}, ` +
    `NIET veilig (volledige Option-worst-case, incl. nog-niet-actieve Fase 2): ${notSafeAllOptionsSome}`
  );

  console.log("\n=== SessionKeyAccount ===");
  const sessions = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc("SessionKeyAccount")) } }],
  });
  let sessionUnsafe = 0;
  for (const { pubkey, account } of sessions) {
    const allocated = account.data.length;
    const safe = allocated >= SESSION_LEN_NEW;
    if (!safe) sessionUnsafe++;
    console.log(`${pubkey.toBase58()}  toegekend=${allocated}  veilig(${SESSION_LEN_NEW})=${safe}`);
  }
  console.log(`totaal SessionKeyAccounts: ${sessions.length}, NIET veilig: ${sessionUnsafe}`);
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
