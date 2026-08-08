import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

export interface ConnectedWallet {
  publicKey: PublicKey;
  walletName: string;
  signAndSendTransaction: (transaction: Transaction) => Promise<{ signature: string }>;
}

function isSolanaWallet(wallet: Wallet): boolean {
  return (
    "solana:signAndSendTransaction" in wallet.features ||
    "solana:signTransaction" in wallet.features
  );
}

export async function connectWallet(): Promise<ConnectedWallet> {
  const { get } = getWallets();
  const wallets = get().filter(isSolanaWallet);

  if (wallets.length === 0) {
    throw new Error(
      "Geen Solana-browserwallet gevonden. Installeer bijvoorbeeld Phantom of " +
        "Solflare (beide implementeren de Wallet Standard) en herlaad deze pagina."
    );
  }

  const wallet = wallets[0];

  const connectFeature = wallet.features["standard:connect"] as
    | { connect: () => Promise<{ accounts: readonly WalletAccount[] }> }
    | undefined;
  if (!connectFeature) {
    throw new Error(`Wallet "${wallet.name}" ondersteunt standard:connect niet`);
  }

  const { accounts } = await connectFeature.connect();
  if (accounts.length === 0) {
    throw new Error(`Verbinding met "${wallet.name}" gaf geen accounts terug`);
  }
  const account = accounts[0];
  const publicKey = new PublicKey(account.publicKey);

  const signAndSendFeature = wallet.features["solana:signAndSendTransaction"] as
    | {
        signAndSendTransaction: (input: {
          transaction: Uint8Array;
          account: WalletAccount;
          chain: string;
        }) => Promise<readonly { signature: Uint8Array }[]>;
      }
    | undefined;

  if (!signAndSendFeature) {
    throw new Error(
      `Wallet "${wallet.name}" ondersteunt solana:signAndSendTransaction niet ` +
        "(nodig voor deze test - signTransaction-only wallets worden hier nog niet ondersteund)"
    );
  }

  return {
    publicKey,
    walletName: wallet.name,
    signAndSendTransaction: async (transaction: Transaction) => {
      const compiledMessage = transaction.compileMessage();
      const versioned = new VersionedTransaction(compiledMessage);

      // BELANGRIJK: VersionedTransaction(message) initialiseert signatures
      // als lege placeholders - eventuele reeds gezette handtekeningen op de
      // legacy Transaction (via transaction.partialSign(), bv. voor
      // multi-signer-instructies zoals initiate_recovery met een losse
      // backup_authority-sleutel naast de wallet-extensie) gaan anders
      // stilzwijgend verloren. Hier expliciet overzetten naar de juiste
      // signer-index in de versioned message.
      for (const { publicKey: signerKey, signature } of transaction.signatures) {
        if (signature === null) continue;
        const idx = compiledMessage.accountKeys.findIndex((k) => k.equals(signerKey));
        if (idx === -1) {
          throw new Error(
            "Kon signer " + signerKey.toBase58() + " niet terugvinden in de gecompileerde message"
          );
        }
        versioned.signatures[idx] = signature;
      }

      const serialized = versioned.serialize();

      const results = await signAndSendFeature.signAndSendTransaction({
        transaction: serialized,
        account,
        chain: "solana:devnet",
      });

      const signatureBytes = results[0].signature;
      const signature = bs58.encode(signatureBytes);
      return { signature };
    },
  };
}
