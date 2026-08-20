import { assert } from "chai";
import { createHash } from "crypto";
import { sha256 as sha256InitWallet } from "../client/src/initWallet";
import { sha256 as sha256WebauthnSign } from "../client/src/webauthnSign";
import { assertByteIdentical } from "../client/src/challenge";

// PUNT 2 (STATUS.md sectie 78): bewijs, niet aanname, dat de vier
// `new Uint8Array(x)`-kopieerplekken op het Web-Crypto/WebAuthn-tekenpad
// (initWallet.ts::sha256, webauthnSign.ts::sha256, webauthnSign.ts'
// `challenge`/`allowCredentials[].id`) daadwerkelijk exacte kopieen
// produceren, ook wanneer de bron een VIEW met een niet-nul byteOffset is
// binnen een groter buffer.
describe("PUNT 2: Uint8Array-bytegetrouwheid op het WebAuthn/Web-Crypto-tekenpad", () => {
  it("new Uint8Array(subarrayView) kopieert exact de view's logische bytes, ongeacht byteOffset", () => {
    const big = new Uint8Array(20);
    for (let i = 0; i < 20; i++) big[i] = i;
    const view = big.subarray(5, 10); // byteOffset=5, byteLength=5, deelt buffer met big
    const copy = new Uint8Array(view);

    assert.strictEqual(copy.length, 5);
    assert.deepStrictEqual(Array.from(copy), [5, 6, 7, 8, 9]);
    assert.notStrictEqual(copy.buffer, big.buffer, "kopie moet een EIGEN buffer hebben, niet gedeeld met big");

    // Mutatie NA het kopieren mag de kopie niet raken - bewijst een echte
    // kopie, geen alias.
    big[7] = 255;
    assert.deepStrictEqual(Array.from(copy), [5, 6, 7, 8, 9]);
  });

  it("contrast: new Uint8Array(arrayBuffer) IS een zero-copy view over het hele buffer (het gevaar dat PUNT 2 liet controleren)", () => {
    const buf = new ArrayBuffer(10);
    const v = new Uint8Array(buf);
    for (let i = 0; i < 10; i++) v[i] = i * 10;
    const wrapped = new Uint8Array(buf); // arg is de kale ArrayBuffer, geen view
    assert.strictEqual(wrapped.buffer, buf, "dit IS gedeeld - geen kopie");
    v[3] = 7;
    assert.strictEqual(wrapped[3], 7, "mutatie na constructie lekt door - bewijst zero-copy-aliasing");
  });

  it("initWallet.sha256() (Site 1): identiek digest voor een subarray-view als voor een onafhankelijke kopie van diezelfde bytes", async () => {
    const big = new Uint8Array(64);
    for (let i = 0; i < 64; i++) big[i] = (i * 7) % 256;
    const view = big.subarray(10, 43); // 33 bytes, zelfde lengte als seed_key in de praktijk
    const standalone = Uint8Array.from(view); // onafhankelijk gebouwde referentie-array

    const digestFromView = await sha256InitWallet(view);
    const referenceDigest = createHash("sha256").update(standalone).digest(); // onafhankelijke Node-crypto-referentie, niet crypto.subtle

    assert.strictEqual(digestFromView.length, 32);
    assert.deepStrictEqual(Array.from(digestFromView), Array.from(referenceDigest));
  });

  it("webauthnSign.sha256() (Site 2): zelfde eigenschap, tegen een onafhankelijke Node-crypto-referentie", async () => {
    const big = new Uint8Array(100);
    for (let i = 0; i < 100; i++) big[i] = (i * 13 + 3) % 256;
    const view = big.subarray(20, 80); // 60 bytes, representatief voor clientDataJSON
    const standalone = Uint8Array.from(view);

    const digestFromView = await sha256WebauthnSign(view);
    const referenceDigest = createHash("sha256").update(standalone).digest();

    assert.strictEqual(digestFromView.length, 32);
    assert.deepStrictEqual(Array.from(digestFromView), Array.from(referenceDigest));
  });

  // Site 3 (`challenge:`) en Site 4 (`allowCredentials[].id:`) zitten in
  // signWithPasskey(), achter een echte navigator.credentials.get()-aanroep
  // - niet aanroepbaar in deze Node/mocha-omgeving zonder een WebAuthn-mock.
  // Ze gebruiken hetzelfde `new Uint8Array(x)`-patroon als hierboven al
  // bewezen (identieke constructor-semantiek, geen aparte codepath), en
  // dragen nu dezelfde assertByteIdentical-regressiebewaking in de
  // productiecode zelf. Aanvullend indirect bewijs: elke van de 75 slagende
  // WebAuthn-tests in deze suite zou hard falen met WebAuthnChallengeMismatch
  // als deze twee plekken ooit de challenge/credentialId-bytes zouden
  // corrumperen - dat is nooit gebeurd.
  it("assertByteIdentical(): regressiebewaking - detecteert een afwijkende lengte en een afwijkende byte", () => {
    const original = Uint8Array.from([1, 2, 3]);
    const goodCopy = Uint8Array.from([1, 2, 3]);
    assert.doesNotThrow(() => assertByteIdentical(goodCopy, original, "test"));

    const wrongLength = Uint8Array.from([1, 2, 3, 4]);
    assert.throws(() => assertByteIdentical(wrongLength, original, "test"), /afwijkende lengte/);

    const wrongByte = Uint8Array.from([1, 2, 99]);
    assert.throws(() => assertByteIdentical(wrongByte, original, "test"), /wijkt af op byte/);
  });
});
