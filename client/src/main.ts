import { createSpankWalletPasskey } from "./passkey";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function log(msg: string): void {
  const el = document.getElementById("output")!;
  el.textContent += msg + "\n";
}

async function run(): Promise<void> {
  log("Stap 1: passkey aanmaken via navigator.credentials.create()...");
  try {
    const result = await createSpankWalletPasskey(
      "SpankWallet (test)",
      window.location.hostname,
      "spankwallet-test-user"
    );

    log("");
    log("SUCCES.");
    log("");
    log(`Gecomprimeerde publieke sleutel (33 bytes, dit is seed_key voor init_wallet):`);
    log(bytesToHex(result.compressedPublicKey));
    log("");
    log(`Lengte: ${result.compressedPublicKey.length} bytes (moet exact 33 zijn)`);
    log(`Prefix-byte: 0x${result.compressedPublicKey[0].toString(16)} (moet 0x02 of 0x03 zijn)`);
    log("");
    log(`Credential-ID (nodig voor navigator.credentials.get() later):`);
    log(bytesToHex(result.credentialId));
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

document.getElementById("start-btn")!.addEventListener("click", () => {
  document.getElementById("output")!.textContent = "";
  run();
});
