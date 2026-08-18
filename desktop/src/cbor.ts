export type CborValue =
  | number
  | bigint
  | Uint8Array
  | string
  | boolean
  | null
  | CborValue[]
  | Map<CborValue, CborValue>;

class CborReader {
  private pos = 0;
  constructor(private readonly data: Uint8Array) {}

  private readByte(): number {
    if (this.pos >= this.data.length) {
      throw new Error("CBOR: onverwacht einde van data");
    }
    return this.data[this.pos++];
  }

  private readBytes(n: number): Uint8Array {
    if (this.pos + n > this.data.length) {
      throw new Error("CBOR: onverwacht einde van data (readBytes)");
    }
    const out = this.data.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  private readUintOfLength(additionalInfo: number): number {
    if (additionalInfo < 24) return additionalInfo;
    if (additionalInfo === 24) return this.readByte();
    if (additionalInfo === 25) {
      const b = this.readBytes(2);
      return (b[0] << 8) | b[1];
    }
    if (additionalInfo === 26) {
      const b = this.readBytes(4);
      return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    }
    if (additionalInfo === 27) {
      const b = this.readBytes(8);
      let out = 0;
      for (const byte of b) out = out * 256 + byte;
      return out;
    }
    throw new Error(`CBOR: onverwachte additionalInfo-waarde ${additionalInfo} voor lengte`);
  }

  read(): CborValue {
    const first = this.readByte();
    const majorType = first >> 5;
    const additionalInfo = first & 0x1f;

    switch (majorType) {
      case 0: {
        if (additionalInfo === 27) {
          const b = this.readBytes(8);
          let out = 0n;
          for (const byte of b) out = out * 256n + BigInt(byte);
          return out <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(out) : out;
        }
        return this.readUintOfLength(additionalInfo);
      }
      case 1: {
        const n = this.readUintOfLength(additionalInfo);
        return -1 - n;
      }
      case 2: {
        const len = this.readUintOfLength(additionalInfo);
        return this.readBytes(len);
      }
      case 3: {
        const len = this.readUintOfLength(additionalInfo);
        const bytes = this.readBytes(len);
        return new TextDecoder().decode(bytes);
      }
      case 4: {
        const len = this.readUintOfLength(additionalInfo);
        const out: CborValue[] = [];
        for (let i = 0; i < len; i++) out.push(this.read());
        return out;
      }
      case 5: {
        const len = this.readUintOfLength(additionalInfo);
        const out = new Map<CborValue, CborValue>();
        for (let i = 0; i < len; i++) {
          const key = this.read();
          const value = this.read();
          out.set(key, value);
        }
        return out;
      }
      case 7: {
        if (additionalInfo === 20) return false;
        if (additionalInfo === 21) return true;
        if (additionalInfo === 22) return null;
        throw new Error(`CBOR: niet-ondersteunde simple value ${additionalInfo}`);
      }
      default:
        throw new Error(`CBOR: niet-ondersteund major type ${majorType}`);
    }
  }
}

export function cborDecode(data: Uint8Array): CborValue {
  return new CborReader(data).read();
}
