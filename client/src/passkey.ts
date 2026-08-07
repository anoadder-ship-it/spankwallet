import { cborDecode, CborValue } from "./cbor";

export interface PasskeyCreationResult {
  compressedPublicKey: Uint8Array;
  credentialId: Uint8Array;
  rawAttestationObject: Uint8Array;
}

const COSE_KTY = 1;
const COSE_ALG = 3;
const COSE_EC2_CRV = -1;
const COSE_EC2_X = -2;
const COSE_EC2_Y = -3;

const COSE_KTY_EC2 = 2;
const COSE_CRV_P256 = 1;
const COSE_ALG_ES256 = -7;

function extractCredentialPublicKeyBytes(
  authenticatorData: Uint8Array
): { credentialId: Uint8Array; publicKeyBytes: Uint8Array } {
  const FLAGS_OFFSET = 32;
  const AT_FLAG = 0x40;

  const flags = authenticatorData[FLAGS_OFFSET];
  if ((flags & AT_FLAG) === 0) {
    throw new Error(
      "authenticatorData bevat geen attested credential data (AT-flag niet gezet) " +
        "- dit hoort niet voor te komen bij navigator.credentials.create()"
    );
  }

  let offset = 32 + 1 + 4;
  offset += 16;

  const credIdLen = (authenticatorData[offset] << 8) | authenticatorData[offset + 1];
  offset += 2;

  const credentialId = authenticatorData.slice(offset, offset + credIdLen);
  offset += credIdLen;

  const publicKeyBytes = authenticatorData.slice(offset);

  return { credentialId, publicKeyBytes };
}

function coseKeyToCompressedPublicKey(coseKey: CborValue): Uint8Array {
  if (!(coseKey instanceof Map)) {
    throw new Error("COSE-key is geen CBOR-map - onverwacht formaat");
  }

  const kty = coseKey.get(COSE_KTY);
  const alg = coseKey.get(COSE_ALG);
  const crv = coseKey.get(COSE_EC2_CRV);
  const x = coseKey.get(COSE_EC2_X);
  const y = coseKey.get(COSE_EC2_Y);

  if (kty !== COSE_KTY_EC2) {
    throw new Error(
      `Onverwacht COSE key type: ${kty} (verwacht EC2=${COSE_KTY_EC2}). ` +
        "Controleer dat pubKeyCredParams alg: -7 (ES256) bevat."
    );
  }
  if (alg !== COSE_ALG_ES256) {
    throw new Error(`Onverwacht COSE-algoritme: ${alg} (verwacht ES256=${COSE_ALG_ES256})`);
  }
  if (crv !== COSE_CRV_P256) {
    throw new Error(`Onverwachte curve: ${crv} (verwacht P-256=${COSE_CRV_P256})`);
  }
  if (!(x instanceof Uint8Array) || x.length !== 32) {
    throw new Error("X-coordinaat ontbreekt of heeft niet de verwachte lengte van 32 bytes");
  }
  if (!(y instanceof Uint8Array) || y.length !== 32) {
    throw new Error("Y-coordinaat ontbreekt of heeft niet de verwachte lengte van 32 bytes");
  }

  const yIsOdd = (y[y.length - 1] & 1) === 1;
  const prefix = yIsOdd ? 0x03 : 0x02;

  const compressed = new Uint8Array(33);
  compressed[0] = prefix;
  compressed.set(x, 1);
  return compressed;
}

export async function createSpankWalletPasskey(
  rpName: string,
  rpId: string,
  userName: string
): Promise<PasskeyCreationResult> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));

  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: rpName, id: rpId },
      user: {
        id: userId,
        name: userName,
        displayName: userName,
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
      timeout: 120000,
      attestation: "none",
    },
  })) as PublicKeyCredential;

  if (!credential) {
    throw new Error("navigator.credentials.create() gaf geen credential terug");
  }

  const response = credential.response as AuthenticatorAttestationResponse;
  const attestationObjectBytes = new Uint8Array(response.attestationObject);

  const attestationObject = cborDecode(attestationObjectBytes);
  if (!(attestationObject instanceof Map)) {
    throw new Error("attestationObject is geen CBOR-map - onverwacht formaat");
  }

  const authData = attestationObject.get("authData");
  if (!(authData instanceof Uint8Array)) {
    throw new Error("attestationObject bevat geen geldige authData");
  }

  const { credentialId, publicKeyBytes } = extractCredentialPublicKeyBytes(authData);
  const coseKey = cborDecode(publicKeyBytes);
  const compressedPublicKey = coseKeyToCompressedPublicKey(coseKey);

  return {
    compressedPublicKey,
    credentialId,
    rawAttestationObject: attestationObjectBytes,
  };
}
