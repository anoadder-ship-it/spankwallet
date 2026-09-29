// STATUS.md sectie 168 (review §167, M-A): EEN bron voor "welk Squads-
// voorstel is precies deze upgrade, en mag het nu uitgevoerd/goedgekeurd
// worden". Gebruikt door admin/wallet-signer.html (knoppen 2/3/4, het getoonde
// TRANSACTION_INDEX) en door scripts/checkProposalTimelock.ts (via
// scripts/lib/squadsUpgradeProposal.ts). Voorheen had de pagina een eigen
// route (findCanonicalProposal: het laagste goedgekeurde voorstel waarvan
// EEN instructie de buffer raakt) en eiste het script iets anders (het
// laatste voorstel); een groene pre-flight kon zo over een ander voorstel
// gaan dan het voorstel dat knop 4 uitvoerde.
//
// Regel (uitvoeren): het laatste voorstel (multisig.transactionIndex) is
// goedgekeurd, niet stale, en zijn VaultTransaction is precies de upgrade
// (upgradeProposalProblems); en GEEN ENKEL ander voorstel staat op Approved of
// Executing, ongeacht wat erin staat (sectie 169, review §168 M-1/M-2).
// Goedkeuren: het laatste voorstel is open (Active of Approved), dezelfde
// eis over andere voorstellen, en daarnaast geen ander open voorstel voor
// deze buffer (duplicaten). Alle voorstellen 1..transactionIndex worden
// gelezen, ook stale: Squads voert een goedgekeurde vault-transactie ook uit
// als hij stale is.
//
// Waarom niet op inhoud herkennen (de regel van sectie 168: "raakt deze
// buffer"): die herkenning miste geldige varianten - een Upgrade met extra
// bytes achter de opcode (de loader leest met allow_trailing_bytes), een
// Upgrade van hetzelfde programma vanaf een andere buffer, een buffer via een
// lookup-table, een CPI, Write/SetAuthority/Close op de buffer, en Batches
// (de losse transacties staan in accounts die de scan niet leest). Elk
// uitvoerbaar voorstel naast dit ene kan de upgrade beinvloeden; dus mag er
// geen zijn.
//
// Geen imports en geen Buffer: draait ongewijzigd in de browser en in Node.
// De aanroeper geeft zijn eigen PublicKey-klasse (@solana/web3.js) mee.
//
// Layouts uit @sqds/multisig 2.1.4, src/generated/accounts/{Multisig,Proposal,
// VaultTransaction}.ts en types/{VaultTransactionMessage,
// MultisigCompiledInstruction,MultisigMessageAddressTableLookup}.ts; PDA-seeds
// uit src/pda.ts. Gecontroleerd tegen de echte VaultTransactions #11, #13 en
// #14 op devnet (tests/unit/fixtures/devnetSquads20260929.json).

export const SQUADS_PROGRAM_ID = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
export const BPF_LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
const SYSVAR_RENT = "SysvarRent111111111111111111111111111111111";
const SYSVAR_CLOCK = "SysvarC1ock11111111111111111111111111111111";

const MULTISIG_DISCRIMINATOR = [224, 116, 121, 186, 68, 161, 79, 236];
const PROPOSAL_DISCRIMINATOR = [26, 94, 189, 187, 116, 136, 53, 33];
const VAULT_TRANSACTION_DISCRIMINATOR = [168, 250, 162, 100, 81, 14, 162, 207];

// ProposalStatus-tag (1 byte): Draft=0, Active=1, Rejected=2, Approved=3,
// Executing=4, Executed=5, Cancelled=6. Alle behalve Executing dragen een
// i64-timestamp.
export const PROPOSAL_STATUS_NAMES = ["Draft", "Active", "Rejected", "Approved", "Executing", "Executed", "Cancelled"];
export const ACTIVE_TAG = 1;
export const APPROVED_TAG = 3;
export const EXECUTING_TAG = 4;
// Statussen waarin Squads een voorstel (nog) kan uitvoeren: Approved (vault-
// of config-transactie, of een batch die nog niet begonnen is) en Executing
// (een batch halverwege).
export const EXECUTABLE_TAGS = [APPROVED_TAG, EXECUTING_TAG];

// UpgradeableLoaderInstruction::Upgrade (u32-LE 3), accountvolgorde zoals de
// pagina hem opbouwt en zoals #11/#13/#14 on-chain staan: programdata,
// program, buffer, spill, rent, clock, authority.
const UPGRADE_OPCODE = [3, 0, 0, 0];

// getMultipleAccounts: maximaal 100 adressen per aanroep.
const MAX_ACCOUNTS_PER_CALL = 100;

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function u64le(n) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}

/** Leest begrensd: elke lezing voorbij het einde gooit, zodat een afgekapt account nooit half gedecodeerd wordt. */
class Reader {
  constructor(data) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.offset = 0;
  }
  take(n) {
    if (this.offset + n > this.data.length) throw new Error(`afgekapt op offset ${this.offset} (+${n} > ${this.data.length})`);
    const at = this.offset;
    this.offset += n;
    return at;
  }
  u8() {
    return this.data[this.take(1)];
  }
  u16() {
    return this.view.getUint16(this.take(2), true);
  }
  u32() {
    return this.view.getUint32(this.take(4), true);
  }
  u64() {
    return this.view.getBigUint64(this.take(8), true);
  }
  i64() {
    return this.view.getBigInt64(this.take(8), true);
  }
  raw(n) {
    const at = this.take(n);
    // Altijd een kopie: Buffer.prototype.slice (Node) deelt het geheugen.
    return Uint8Array.prototype.slice.call(this.data, at, at + n);
  }
  bytes() {
    return this.raw(this.u32());
  }
  vec(item) {
    const n = this.u32();
    const out = [];
    for (let i = 0; i < n; i++) out.push(item());
    return out;
  }
  get atEnd() {
    return this.offset === this.data.length;
  }
}

function hasDiscriminator(data, discriminator) {
  return data.length >= 8 && bytesEqual(data.subarray(0, 8), discriminator);
}

function withDiscriminator(data, discriminator, name, decode) {
  if (!hasDiscriminator(data, discriminator)) return `geen ${name}-discriminator`;
  const r = new Reader(data);
  r.offset = 8;
  try {
    return decode(r);
  } catch (e) {
    return `${name}: ${e.message}`;
  }
}

export function createUpgradeProposalCheck(PublicKey) {
  const squads = new PublicKey(SQUADS_PROGRAM_ID);
  const loader = new PublicKey(BPF_LOADER_UPGRADEABLE);
  const rent = new PublicKey(SYSVAR_RENT);
  const clock = new PublicKey(SYSVAR_CLOCK);
  const text = new TextEncoder();
  const key = (r) => new PublicKey(r.raw(32));

  function transactionPda(multisig, index) {
    return PublicKey.findProgramAddressSync(
      [text.encode("multisig"), multisig.toBytes(), text.encode("transaction"), u64le(index)],
      squads
    )[0];
  }

  function proposalPda(multisig, index) {
    return PublicKey.findProgramAddressSync(
      [text.encode("multisig"), multisig.toBytes(), text.encode("transaction"), u64le(index), text.encode("proposal")],
      squads
    )[0];
  }

  function vaultPda(multisig, vaultIndex) {
    return PublicKey.findProgramAddressSync(
      [text.encode("multisig"), multisig.toBytes(), text.encode("vault"), Uint8Array.of(vaultIndex)],
      squads
    )[0];
  }

  function decodeMultisigHeader(data) {
    return withDiscriminator(data, MULTISIG_DISCRIMINATOR, "Multisig", (r) => {
      r.raw(32); // create_key
      r.raw(32); // config_authority
      return { threshold: r.u16(), timeLockSeconds: r.u32(), transactionIndex: r.u64(), staleTransactionIndex: r.u64() };
    });
  }

  function decodeProposalHeader(data) {
    return withDiscriminator(data, PROPOSAL_DISCRIMINATOR, "Proposal", (r) => {
      const multisig = key(r);
      const transactionIndex = r.u64();
      const statusTag = r.u8();
      if (statusTag >= PROPOSAL_STATUS_NAMES.length) throw new Error(`onbekende status-tag ${statusTag}`);
      const statusTimestamp = statusTag === EXECUTING_TAG ? null : r.i64();
      return { multisig, transactionIndex, statusTag, statusTimestamp };
    });
  }

  /** Volledige decode; bytes over na het bericht = afwijking (Squads alloceert exact). */
  function decodeVaultTransaction(data) {
    return withDiscriminator(data, VAULT_TRANSACTION_DISCRIMINATOR, "VaultTransaction", (r) => {
      const multisig = key(r);
      r.raw(32); // creator
      const index = r.u64();
      r.u8(); // bump
      const vaultIndex = r.u8();
      r.u8(); // vault_bump
      const ephemeralSignerBumps = r.bytes();
      const numSigners = r.u8();
      r.u8(); // num_writable_signers
      r.u8(); // num_writable_non_signers
      const accountKeys = r.vec(() => key(r));
      const instructions = r.vec(() => ({ programIdIndex: r.u8(), accountIndexes: Array.from(r.bytes()), data: r.bytes() }));
      const addressTableLookups = r.vec(() => ({ accountKey: key(r), writable: r.bytes(), readonly: r.bytes() }));
      if (!r.atEnd) throw new Error(`${data.length - r.offset} onverwachte bytes na het bericht`);
      return {
        multisig,
        index,
        vaultIndex,
        ephemeralSignerBumps,
        numSigners,
        accountKeys,
        instructions,
        addressTableLookupCount: addressTableLookups.length,
      };
    });
  }

  /**
   * Raakt EEN Upgrade-instructie van de loader (exact 03000000) deze buffer?
   * Alleen nog voor de duplicaat-melding van knop 2/3 (open voorstellen voor
   * deze buffer), NIET als veiligheidsgrens: hij mist varianten (zie de kop
   * van dit bestand). De grens is "geen ander voorstel Approved/Executing".
   */
  function touchesBuffer(vtx, buffer) {
    return vtx.instructions.some((ix) => {
      const program = vtx.accountKeys[ix.programIdIndex];
      if (!program || !program.equals(loader) || !bytesEqual(ix.data, UPGRADE_OPCODE)) return false;
      return ix.accountIndexes.some((i) => vtx.accountKeys[i] && vtx.accountKeys[i].equals(buffer));
    });
  }

  /**
   * Streng: de VaultTransaction doet precies één ding, programma
   * `expected.programId` upgraden vanaf `expected.buffer`, met de vault als
   * enige ondertekenaar, upgrade-authority en spill. Alles daarbuiten (een
   * tweede instructie, een lookup-table, ephemeral signers, een andere
   * accountvolgorde) is een afwijking, ook als het onschuldig zou kunnen zijn.
   */
  function upgradeProposalProblems(vtx, expected) {
    const problems = [];
    const vault = vaultPda(expected.multisig, expected.vaultIndex);
    if (!vtx.multisig.equals(expected.multisig)) problems.push(`multisig ${vtx.multisig.toBase58()}, verwacht ${expected.multisig.toBase58()}`);
    if (vtx.index !== expected.transactionIndex) problems.push(`index ${vtx.index}, verwacht ${expected.transactionIndex}`);
    if (vtx.vaultIndex !== expected.vaultIndex) problems.push(`vault-index ${vtx.vaultIndex}, verwacht ${expected.vaultIndex}`);
    if (vtx.ephemeralSignerBumps.length !== 0) problems.push(`${vtx.ephemeralSignerBumps.length} ephemeral signer(s), verwacht 0`);
    if (vtx.addressTableLookupCount !== 0) problems.push(`${vtx.addressTableLookupCount} address lookup table(s), verwacht 0`);
    const first = vtx.accountKeys[0];
    if (vtx.numSigners !== 1 || !first || !first.equals(vault)) {
      problems.push(`ondertekenaars: ${vtx.numSigners}, eerste sleutel ${first ? first.toBase58() : "-"}; verwacht alleen de vault ${vault.toBase58()}`);
    }
    if (vtx.instructions.length !== 1) {
      problems.push(`${vtx.instructions.length} instructies, verwacht precies 1 (de upgrade)`);
      return problems;
    }
    const ix = vtx.instructions[0];
    const at = (i) => vtx.accountKeys[i];
    const program = at(ix.programIdIndex);
    if (!program || !program.equals(loader)) {
      problems.push(`instructie roept ${program ? program.toBase58() : "?"} aan, niet de upgradeable loader`);
    }
    if (!bytesEqual(ix.data, UPGRADE_OPCODE)) problems.push(`instructiedata ${hex(ix.data)}, verwacht Upgrade (03000000)`);
    const expectedAccounts = [
      ["programdata", expected.programData],
      ["programma", expected.programId],
      ["buffer", expected.buffer],
      ["spill", vault],
      ["rent-sysvar", rent],
      ["clock-sysvar", clock],
      ["upgrade-authority", vault],
    ];
    if (ix.accountIndexes.length !== expectedAccounts.length) {
      problems.push(`${ix.accountIndexes.length} accounts in de instructie, verwacht ${expectedAccounts.length}`);
      return problems;
    }
    expectedAccounts.forEach(([name, want], i) => {
      const got = at(ix.accountIndexes[i]);
      if (!got || !got.equals(want)) problems.push(`${name}: ${got ? got.toBase58() : "ongeldige index"}, verwacht ${want.toBase58()}`);
    });
    return problems;
  }

  /**
   * Eén voorstel uit de scan, gelezen en gecontroleerd. Geeft null als er
   * geen proposal-account is (niet uitvoerbaar), anders { problems, status,
   * vtx }. vtx is null als de transactie geen VaultTransaction is (bv. een
   * config- of batch-transactie); de status telt dan nog steeds mee.
   */
  function readEntry(entry, multisigAddress) {
    const problems = [];
    const { index, proposal, transaction } = entry;
    if (!proposal) return null;
    if (!proposal.owner.equals(squads)) {
      return { problems: [`Proposal-account ${proposal.address.toBase58()} is niet van het Squads-programma (owner ${proposal.owner.toBase58()}).`] };
    }
    const header = decodeProposalHeader(proposal.data);
    if (typeof header === "string") return { problems: [`Proposal-account ${proposal.address.toBase58()}: ${header}`] };
    if (!header.multisig.equals(multisigAddress)) {
      problems.push(`Proposal #${index}: multisig ${header.multisig.toBase58()}, verwacht ${multisigAddress.toBase58()}`);
    }
    if (header.transactionIndex !== index) problems.push(`Proposal #${index}: transactionIndex ${header.transactionIndex}, verwacht ${index}`);
    if (!transaction) return { problems: [...problems, `Proposal #${index} heeft geen transactie-account`], status: header };
    if (!transaction.owner.equals(squads)) {
      problems.push(`VaultTransaction-account ${transaction.address.toBase58()} is niet van het Squads-programma (owner ${transaction.owner.toBase58()}).`);
      return { problems, status: header };
    }
    if (!hasDiscriminator(transaction.data, VAULT_TRANSACTION_DISCRIMINATOR)) return { problems, status: header, vtx: null };
    const vtx = decodeVaultTransaction(transaction.data);
    if (typeof vtx === "string") return { problems: [...problems, `VaultTransaction-account ${transaction.address.toBase58()}: ${vtx}`], status: header };
    return { problems, status: header, vtx };
  }

  /**
   * De selectieregel. `entries` moet precies de voorstellen 1..
   * multisig.transactionIndex bevatten (loadProposalEntries). purpose:
   * - "execute": het laatste voorstel is goedgekeurd, niet stale en precies
   *   de upgrade, en geen enkel ander voorstel staat op Approved of Executing
   *   (`blockers`), welke inhoud ook;
   * - "approve": het laatste voorstel is open (Active of Approved), dezelfde
   *   eis over `blockers`, en geen ander Active-voorstel voor deze buffer;
   * - "propose": alleen de lijsten (knop 2 weigert zonder bevestiging een
   *   nieuw voorstel als `candidates` niet leeg is).
   * `candidates`: open (Active/Approved) voorstellen voor deze buffer.
   * `blockers`: andere voorstellen dan het laatste op Approved of Executing.
   * Elk voorstel dat niet te lezen of te controleren is, is een probleem
   * (fail-closed), ook als het niet het laatste is.
   */
  function selectProposal({ multisig, multisigAddress, entries, expected, purpose }) {
    if (purpose !== "execute" && purpose !== "approve" && purpose !== "propose") throw new Error(`onbekend doel ${purpose}`);
    const wanted = purpose === "execute" ? [APPROVED_TAG] : [ACTIVE_TAG, APPROVED_TAG];
    const latest = multisig.transactionIndex;
    const problems = [];

    const complete = entries.length === Number(latest) && entries.every((e, i) => e.index === BigInt(i + 1));
    if (!complete) problems.push(`scan onvolledig: verwacht de voorstellen 1..${latest}, gelezen ${entries.length}`);

    const candidates = [];
    const blockers = [];
    let latestRead = null;
    for (const entry of entries) {
      const read = readEntry(entry, multisigAddress);
      if (entry.index === latest) latestRead = read;
      if (!read) continue;
      problems.push(...read.problems);
      if (!read.status) continue;
      const statusName = PROPOSAL_STATUS_NAMES[read.status.statusTag];
      if (entry.index !== latest && EXECUTABLE_TAGS.includes(read.status.statusTag)) blockers.push({ index: entry.index, statusName });
      if (read.vtx && (read.status.statusTag === ACTIVE_TAG || read.status.statusTag === APPROVED_TAG) && touchesBuffer(read.vtx, expected.buffer)) {
        candidates.push({ index: entry.index, statusName });
      }
    }
    if (purpose === "propose") return { target: null, candidates, blockers, problems };

    if (blockers.length > 0) {
      problems.push(
        `andere goedgekeurde of lopende voorstellen (Approved/Executing), ongeacht de inhoud: ` +
          blockers.map((b) => `#${b.index} (${b.statusName})`).join(", ") +
          ` (vereist: geen enkel, naast het laatste voorstel #${latest}; een overbodig voorstel eerst annuleren, niet uitvoeren)`
      );
    }
    if (purpose === "approve") {
      const duplicates = candidates.filter((c) => c.index !== latest && c.statusName === PROPOSAL_STATUS_NAMES[ACTIVE_TAG]).map((c) => `#${c.index}`);
      if (duplicates.length > 0) {
        problems.push(`andere open voorstellen voor deze buffer: ${duplicates.join(", ")} (vereist: precies één, en dat is het laatste voorstel #${latest})`);
      }
    }
    if (!latestRead) {
      problems.push(`het laatste voorstel #${latest} heeft geen proposal-account`);
      return { target: null, candidates, blockers, problems };
    }
    if (!latestRead.status) return { target: null, candidates, blockers, problems };
    const statusName = PROPOSAL_STATUS_NAMES[latestRead.status.statusTag];
    if (!wanted.includes(latestRead.status.statusTag)) {
      const want = wanted.map((t) => `"${PROPOSAL_STATUS_NAMES[t]}"`).join(" of ");
      problems.push(`Voorstel #${latest} staat op status "${statusName}", niet ${want}`);
    }
    if (latest <= multisig.staleTransactionIndex) problems.push(`Voorstel #${latest} is stale (staleTransactionIndex = ${multisig.staleTransactionIndex})`);
    if (latestRead.vtx === undefined) return { target: null, candidates, blockers, problems };
    if (latestRead.vtx === null) {
      problems.push(`Voorstel #${latest} is geen VaultTransaction`);
    } else {
      problems.push(...upgradeProposalProblems(latestRead.vtx, { ...expected, transactionIndex: latest }));
    }
    if (problems.length > 0) return { target: null, candidates, blockers, problems };
    return {
      target: { index: latest, statusName, statusTimestamp: latestRead.status.statusTimestamp, vtx: latestRead.vtx },
      candidates,
      blockers,
      problems,
    };
  }

  function accountBytes(address, info) {
    return info ? { address, owner: info.owner, data: info.data } : null;
  }

  /**
   * Leest het multisig-account en daarna alle voorstellen 1..transactionIndex
   * (proposal + transactie), minstens op de slot van de multisig-lezing.
   * Gooit bij een ontbrekend of vreemd multisig-account.
   */
  async function loadProposalEntries(connection, multisigAddress, commitment) {
    const { context, value: info } = await connection.getAccountInfoAndContext(multisigAddress, { commitment });
    if (!info) throw new Error(`Multisig-account ${multisigAddress.toBase58()} niet gevonden.`);
    if (!info.owner.equals(squads)) {
      throw new Error(`Multisig-account ${multisigAddress.toBase58()} is niet van het Squads-programma (owner ${info.owner.toBase58()}).`);
    }
    const multisig = decodeMultisigHeader(info.data);
    if (typeof multisig === "string") throw new Error(`Multisig-account: ${multisig}`);

    const addresses = [];
    for (let i = 1n; i <= multisig.transactionIndex; i++) {
      addresses.push(proposalPda(multisigAddress, i), transactionPda(multisigAddress, i));
    }
    const infos = [];
    for (let at = 0; at < addresses.length; at += MAX_ACCOUNTS_PER_CALL) {
      const chunk = addresses.slice(at, at + MAX_ACCOUNTS_PER_CALL);
      const { value } = await connection.getMultipleAccountsInfoAndContext(chunk, { commitment, minContextSlot: context.slot });
      if (value.length !== chunk.length) throw new Error(`getMultipleAccounts gaf ${value.length} antwoorden op ${chunk.length} adressen`);
      infos.push(...value);
    }
    const entries = [];
    for (let i = 0; i < addresses.length; i += 2) {
      entries.push({
        index: BigInt(i / 2 + 1),
        proposal: accountBytes(addresses[i], infos[i]),
        transaction: accountBytes(addresses[i + 1], infos[i + 1]),
      });
    }
    return { multisig, entries };
  }

  /** loadProposalEntries + selectProposal: wat pagina en script allebei doen. */
  async function loadAndSelect(connection, { multisigAddress, expected, purpose, commitment = "confirmed" }) {
    const { multisig, entries } = await loadProposalEntries(connection, multisigAddress, commitment);
    return { multisig, ...selectProposal({ multisig, multisigAddress, entries, expected, purpose }) };
  }

  return {
    squadsProgramId: squads,
    transactionPda,
    proposalPda,
    vaultPda,
    decodeMultisigHeader,
    decodeProposalHeader,
    decodeVaultTransaction,
    touchesBuffer,
    upgradeProposalProblems,
    selectProposal,
    loadProposalEntries,
    loadAndSelect,
  };
}
