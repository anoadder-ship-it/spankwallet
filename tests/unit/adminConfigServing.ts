import { assert } from "chai";
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import { createRequire } from "module";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

/**
 * STATUS.md sectie 180: admin/https-server.js serveert /config.js uit een
 * lokaal sleutelbestand buiten git (rechten 600, eigen eigenaar, UUID), en
 * valt anders terug op de gecommitte admin/config.js, die alleen een fout
 * gooit. De sleutel zelf hoort nooit in git en nooit in een logregel. Alle
 * sleutels hier zijn willekeurige nep-UUID's in een tijdelijke map.
 */

const ROOT = process.cwd();
const SERVER_FILE = path.join(ROOT, "admin", "https-server.js");
const SERVER_SOURCE = fs.readFileSync(SERVER_FILE, "utf8");
const COMMITTED_CONFIG = fs.readFileSync(path.join(ROOT, "admin", "config.js"));
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Zonder de bewaking zou require() de server zelf starten (poort 8766, key.pem):
// dan de module niet laden, en faalt elke test hieronder met deze reden.
// createRequire: Node laadt dit bestand zonder relatieve imports als ES-module.
const GUARDED = /if \(require\.main === module\)/.test(SERVER_SOURCE);
const server = GUARDED ? createRequire(SERVER_FILE)(SERVER_FILE) : null;

function serverModule() {
  assert.isTrue(GUARDED, "admin/https-server.js start bij require(); listen hoort alleen bij require.main === module");
  assert.isFunction(server.loadLocalConfig, "loadLocalConfig wordt niet geëxporteerd");
  assert.isFunction(server.createRequestHandler, "createRequestHandler wordt niet geëxporteerd");
  return server;
}

type Response = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

async function get(localConfig: Buffer | null, requestPath: string): Promise<Response> {
  const srv = http.createServer(serverModule().createRequestHandler(localConfig));
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as AddressInfo;
  try {
    return await new Promise<Response>((resolve, reject) => {
      // path als ruwe string: http.request normaliseert "../" niet weg.
      const req = http.request({ host: "127.0.0.1", port, path: requestPath, method: "GET" }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

// Laadt een sleutelbestand en vangt elke uitvoer: de eigen waarschuwingen en
// alles wat er (per ongeluk) via console zou lopen.
function load(file: string, opts: { uid?: number } = {}) {
  const warnings: string[] = [];
  const stray: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(saved) as (keyof typeof saved)[]) console[k] = (...a: unknown[]) => stray.push(a.join(" "));
  try {
    const body = serverModule().loadLocalConfig(file, { ...opts, warn: (m: string) => warnings.push(m) });
    return { body: body as Buffer | null, warnings, all: [...warnings, ...stray].join("\n") };
  } finally {
    Object.assign(console, saved);
  }
}

describe("admin/https-server.js: /config.js uit het lokale sleutelbestand (STATUS.md sectie 180)", () => {
  let dir: string;
  const fakeKey = crypto.randomUUID();
  const keyFile = () => path.join(dir, "helius-devnet.key");
  const writeKey = (content: string, mode = 0o600) => {
    fs.writeFileSync(keyFile(), content);
    fs.chmodSync(keyFile(), mode);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "spankwallet-sleutel-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("require() start de server niet", () => {
    serverModule();
  });

  it("geldig sleutelbestand (600, eigen eigenaar): /config.js is precies de module met die sleutel, met no-cache", async () => {
    writeKey(fakeKey + "\n");
    const { body, warnings } = load(keyFile());
    assert.deepEqual(warnings, []);
    const res = await get(body, "/config.js");
    assert.equal(res.status, 200);
    assert.equal(res.body.toString("utf8"), `export const HELIUS_API_KEY = "${fakeKey}";\n`);
    assert.equal(res.headers["content-type"], "text/javascript");
    assert.equal(res.headers["cache-control"], "no-store, no-cache, must-revalidate, max-age=0");
    assert.equal(res.headers["pragma"], "no-cache");
    assert.equal(res.headers["expires"], "0");
    // De query-string (deep-link-terugkeer) verandert daar niets aan.
    assert.equal((await get(body, "/config.js?nonce=x")).body.toString("utf8"), res.body.toString("utf8"));
  });

  it("ontbrekend bestand: één waarschuwing, en /config.js is byte voor byte de gecommitte admin/config.js", async () => {
    const { body, warnings } = load(keyFile());
    assert.isNull(body);
    assert.lengthOf(warnings, 1);
    const res = await get(body, "/config.js");
    assert.equal(res.status, 200);
    assert.isTrue(res.body.equals(COMMITTED_CONFIG));
    assert.equal(res.headers["cache-control"], "no-store, no-cache, must-revalidate, max-age=0");
  });

  const rejected: [string, () => void, { uid?: number }][] = [
    ["rechten 644", () => writeKey(fakeKey + "\n", 0o644), {}],
    ["rechten 640", () => writeKey(fakeKey + "\n", 0o640), {}],
    ["rechten 400", () => writeKey(fakeKey + "\n", 0o400), {}],
    ["andere eigenaar", () => writeKey(fakeKey + "\n"), { uid: (process.getuid?.() ?? 0) + 1 }],
    ["leeg bestand", () => writeKey(""), {}],
    ["geen UUID", () => writeKey("geen-sleutel-" + fakeKey.slice(0, 8) + "\n"), {}],
    ["UUID met aanhalingsteken erachter", () => writeKey(fakeKey + '";alert(1)//\n'), {}],
    ["UUID met een tweede regel", () => writeKey(fakeKey + "\n" + fakeKey + "\n"), {}],
    ["UUID met </script>", () => writeKey(fakeKey + "</script>\n"), {}],
    ["symlink naar een geldig bestand", () => {
      const real = path.join(dir, "echt.key");
      fs.writeFileSync(real, fakeKey + "\n");
      fs.chmodSync(real, 0o600);
      fs.symlinkSync(real, keyFile());
    }, {}],
  ];
  for (const [what, setup, opts] of rejected) {
    it(`${what}: terugval, één waarschuwing, en niets van de inhoud in de uitvoer`, async () => {
      setup();
      const { body, warnings, all } = load(keyFile(), opts);
      assert.isNull(body);
      assert.lengthOf(warnings, 1);
      assert.notInclude(all, fakeKey);
      assert.notInclude(all, fakeKey.slice(0, 8));
      assert.notMatch(all, UUID);
      const res = await get(body, "/config.js");
      assert.isTrue(res.body.equals(COMMITTED_CONFIG));
    });
  }

  it("het sleutelbestand is via geen enkele URL op te vragen", async () => {
    writeKey(fakeKey + "\n");
    const { body } = load(keyFile());
    const base = path.basename(keyFile());
    const attempts = [
      "/" + base,
      "/../" + base,
      "/%2e%2e/" + base,
      keyFile(),
      "/" + keyFile(),
      "/config.js/../" + base,
      "/.config/spankwallet/helius-devnet.key",
      "/../../../../" + path.relative("/", keyFile()),
      "/key.pem",
    ];
    for (const p of attempts) {
      const res = await get(body, p);
      assert.equal(res.status, 404, p);
      assert.notInclude(res.body.toString("utf8"), fakeKey, p);
    }
  });

  it("admin/config.js bevat geen sleutel (geen UUID) en gooit een fout", () => {
    const text = COMMITTED_CONFIG.toString("utf8");
    assert.notMatch(text, UUID);
    assert.match(text, /^throw new Error\("Geen Helius-sleutel/m);
  });
});

describe("admin/wallet-signer.html is bevroren (STATUS.md sectie 173/179/180)", () => {
  // De gereviewde pagina van §179. Een bewuste wijziging aan de pagina past
  // deze hash expliciet aan, met een eigen STATUS-sectie en review.
  it("sha256 is die van §179", () => {
    const page = fs.readFileSync(path.join(ROOT, "admin", "wallet-signer.html"));
    assert.equal(crypto.createHash("sha256").update(page).digest("hex"), "2dcfb299fba176fc3da0fd096ca5525094ced6aa86055f0b61789c242e646557");
  });
});
