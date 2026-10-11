import { assert } from "chai";
import { spawnSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import { createRequire } from "module";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

/**
 * STATUS.md sectie 180/181: admin/https-server.js serveert /config.js uit een
 * lokaal sleutelbestand buiten git (rechten 600, eigen eigenaar, UUID), en
 * valt anders terug op de gecommitte admin/config.js, die alleen een fout
 * gooit. De sleutel zelf hoort nooit in git en nooit in een logregel. Alle
 * sleutels hier zijn willekeurige nep-UUID's in een tijdelijke map; het echte
 * sleutelbestand wordt nooit geopend (zie de require hieronder).
 */

const ROOT = process.cwd();
const SERVER_FILE = path.join(ROOT, "admin", "https-server.js");
const COMMITTED_CONFIG = fs.readFileSync(path.join(ROOT, "admin", "config.js"));
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const REAL_KEY_FILE = path.join(os.homedir(), ".config", "spankwallet", "helius-devnet.key");
// Paden waarvoor een gewoon object een geërfde waarde geeft (§181, review M2).
const PROTOTYPE_PATHS = ["/constructor", "/__proto__", "/toString", "/hasOwnProperty"];

// createRequire: Node laadt dit bestand zonder relatieve imports als ES-module;
// zo delen we bovendien de CommonJS-objecten fs en net met de server.
const cjsRequire = createRequire(SERVER_FILE);
const cjsFs = cjsRequire("fs");
const cjsNet = cjsRequire("net");

// De require zelf, bespioneerd (§181, review M3b): SPANKWALLET_HELIUS_KEY_FILE
// wijst op een niet-bestaand tijdelijk pad, listen wordt opgenomen in plaats van
// uitgevoerd, en het echte sleutelbestand openen wordt geweigerd. Zo opent een
// kapotte bewaking geen poort en leest ze de echte sleutel niet.
const probe = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spankwallet-require-"));
  const savedEnv = process.env.SPANKWALLET_HELIUS_KEY_FILE;
  process.env.SPANKWALLET_HELIUS_KEY_FILE = path.join(dir, "bestaat-niet.key");
  const listenCalls: unknown[][] = [];
  const realKeyOpens: string[] = [];
  const origListen = cjsNet.Server.prototype.listen;
  const origOpenSync = cjsFs.openSync;
  cjsNet.Server.prototype.listen = function (this: unknown, ...args: unknown[]) {
    listenCalls.push(args);
    return this;
  };
  cjsFs.openSync = function (this: unknown, p: unknown, ...rest: unknown[]) {
    if (path.resolve(String(p)) === REAL_KEY_FILE) {
      realKeyOpens.push(String(p));
      throw Object.assign(new Error("echt sleutelbestand geweigerd in de test"), { code: "EACCES" });
    }
    return origOpenSync.call(this, p, ...rest);
  };
  let mod: any = null;
  let error: unknown = null;
  try {
    mod = cjsRequire(SERVER_FILE);
  } catch (e) {
    error = e;
  } finally {
    cjsNet.Server.prototype.listen = origListen;
    cjsFs.openSync = origOpenSync;
    if (savedEnv === undefined) delete process.env.SPANKWALLET_HELIUS_KEY_FILE;
    else process.env.SPANKWALLET_HELIUS_KEY_FILE = savedEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { mod, error, listenCalls, realKeyOpens };
})();

function serverModule() {
  assert.isNull(probe.error, `require() gooide: ${String(probe.error)}`);
  for (const name of ["loadLocalConfig", "createRequestHandler"]) {
    assert.isFunction(probe.mod?.[name], `${name} wordt niet geëxporteerd`);
  }
  return probe.mod;
}

// parseListenConfig en main (§181) apart, zodat het rood per test iets zegt.
function exported(name: "parseListenConfig" | "main") {
  assert.isFunction(serverModule()[name], `${name} wordt niet geëxporteerd`);
  return serverModule()[name];
}

type Response = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

// Eén server voor een reeks verzoeken. Gooit de handler, dan gedraagt de test
// zich als het echte proces (dat dan stopt): de server gaat dicht, volgende
// verzoeken mislukken, en de fout wordt na afloop gemeld.
async function withServer<T>(localConfig: Buffer | null, run: (request: (p: string) => Promise<Response>) => Promise<T>): Promise<T> {
  const handler = serverModule().createRequestHandler(localConfig);
  const thrown: unknown[] = [];
  const srv = http.createServer((req, res) => {
    try {
      handler(req, res);
    } catch (e) {
      thrown.push(e);
      res.socket?.destroy();
      srv.close();
      srv.closeAllConnections();
    }
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as AddressInfo;
  const request = (requestPath: string) =>
    new Promise<Response>((resolve, reject) => {
      // path als ruwe string: http.request normaliseert "../" niet weg.
      const req = http.request({ host: "127.0.0.1", port, path: requestPath, method: "GET", agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", (e) => reject(new Error(`${requestPath}: ${e.message}; de handler gooide: ${thrown.map(String).join("; ")}`)));
      req.end();
    });
  try {
    return await run(request);
  } finally {
    srv.closeAllConnections();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    assert.deepEqual(thrown.map(String), [], "de handler gooide (in het echte proces: de server stopt)");
  }
}

const get = (localConfig: Buffer | null, requestPath: string) => withServer(localConfig, (request) => request(requestPath));

// Vangt alles wat via console loopt, plus de eigen log/warn-functies.
async function captured<T>(run: (sink: (m: string) => void) => T | Promise<T>) {
  const lines: string[] = [];
  const sink = (m: string) => lines.push(m);
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const k of Object.keys(saved) as (keyof typeof saved)[]) console[k] = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    const result = await run(sink);
    return { result, lines };
  } finally {
    Object.assign(console, saved);
  }
}

async function load(file: string, opts: { uid?: number } = {}) {
  const warnings: string[] = [];
  const { result, lines } = await captured(() =>
    serverModule().loadLocalConfig(file, { ...opts, warn: (m: string) => warnings.push(m) }) as Buffer | null,
  );
  return { body: result, warnings, all: [...warnings, ...lines].join("\n") };
}

async function freePort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

// main() in dit proces, zonder certificaat (https.createServer({}) luistert wel,
// een TLS-handdruk slaagt niet): host, poort, sleutel en elke logregel.
async function runMain(env: Record<string, string>) {
  let srv: any;
  const { lines } = await captured(async (sink) => {
    srv = exported("main")(env, { tlsOptions: {}, log: sink, warn: sink });
    await new Promise<void>((resolve, reject) => {
      if (srv.listening) resolve();
      srv.once("listening", () => setImmediate(resolve));
      srv.once("error", reject);
    });
  });
  const address = srv.address() as AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return { address, all: lines.join("\n") };
}

function runScript(env: Record<string, string>, timeout = 10000) {
  const res = spawnSync(process.execPath, [SERVER_FILE], { env: { ...process.env, ...env }, encoding: "utf8", timeout });
  return { status: res.status, signal: res.signal, out: `${res.stdout}${res.stderr}` };
}

describe("admin/https-server.js: /config.js uit het lokale sleutelbestand (STATUS.md sectie 180/181)", () => {
  let dir: string;
  const fakeKey = crypto.randomUUID();
  const keyFile = () => path.join(dir, "helius-devnet.key");
  const writeKey = (content: string, mode = 0o600) => {
    fs.writeFileSync(keyFile(), content);
    fs.chmodSync(keyFile(), mode);
  };
  // Het pad zelf kan toevallig hex bevatten; voor de "niets van de inhoud"-toets eruit.
  const withoutPaths = (text: string) => text.split(dir).join("<map>");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "spankwallet-sleutel-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("require() luistert niet en opent het echte sleutelbestand niet", () => {
    serverModule();
    assert.deepEqual(probe.listenCalls, [], "listen() tijdens require()");
    assert.deepEqual(probe.realKeyOpens, [], "het echte sleutelbestand geopend tijdens require()");
  });

  it("geldig sleutelbestand (600, eigen eigenaar): /config.js is precies de module met die sleutel, met no-cache, en de sleutel staat in geen enkele logregel", async () => {
    writeKey(fakeKey + "\n");
    const { body, warnings, all } = await load(keyFile());
    assert.deepEqual(warnings, []);
    assert.notInclude(all, fakeKey);
    assert.notMatch(all, UUID);
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
    const { body, warnings } = await load(keyFile());
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
      const { body, warnings, all } = await load(keyFile(), opts);
      assert.isNull(body);
      assert.lengthOf(warnings, 1);
      const text = withoutPaths(all);
      assert.notInclude(text, fakeKey);
      assert.notInclude(text, fakeKey.slice(0, 4));
      assert.notMatch(text, UUID);
      const res = await get(body, "/config.js");
      assert.isTrue(res.body.equals(COMMITTED_CONFIG));
    });
  }

  it("een FIFO op het sleutelpad blijft niet hangen: terugval als 'geen gewoon bestand' (§181, L2)", () => {
    const made = spawnSync("mkfifo", ["-m", "600", keyFile()]);
    assert.equal(made.status, 0, "mkfifo");
    // In een eigen proces: een blokkerende open() houdt de hele event-loop vast, ook mocha's time-out.
    const script = `require(${JSON.stringify(SERVER_FILE)}).loadLocalConfig(${JSON.stringify(keyFile())}, { warn: (m) => console.log(m) })`;
    const res = spawnSync(process.execPath, ["-e", script], {
      env: { ...process.env, SPANKWALLET_HELIUS_KEY_FILE: path.join(dir, "bestaat-niet.key") },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.isNull(res.signal, "blijft hangen op de FIFO (afgebroken na 5 s)");
    assert.equal(res.status, 0, res.stderr);
    assert.include(res.stdout, "geen gewoon bestand");
  });

  it("het sleutelbestand is via geen enkele URL op te vragen, en geen enkele URL laat de server stoppen", async () => {
    writeKey(fakeKey + "\n");
    const { body } = await load(keyFile());
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
      "//config.js",
      "/x/config.js",
      "/../config.js",
      ...PROTOTYPE_PATHS,
    ];
    await withServer(body, async (request) => {
      for (const p of attempts) {
        const res = await request(p);
        assert.equal(res.status, 404, p);
        assert.notInclude(res.body.toString("utf8"), fakeKey, p);
      }
      assert.equal((await request("/config.js")).status, 200, "antwoordt daarna nog");
    });
  });

  it("/constructor, /__proto__, /toString en /hasOwnProperty geven 404 en de server blijft antwoorden (§181, M2)", async () => {
    await withServer(null, async (request) => {
      for (const p of PROTOTYPE_PATHS) assert.equal((await request(p)).status, 404, p);
      const after = await request("/wallet-signer.html");
      assert.equal(after.status, 200);
    });
  });

  it("admin/config.js bevat geen sleutel (geen UUID) en gooit een fout", () => {
    const text = COMMITTED_CONFIG.toString("utf8");
    assert.notMatch(text, UUID);
    assert.match(text, /^throw new Error\("Geen Helius-sleutel/m);
  });
});

describe("admin/https-server.js: adres en poort (STATUS.md sectie 181, M1/L1)", () => {
  let dir: string;
  const fakeKey = crypto.randomUUID();
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "spankwallet-start-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const missingKey = () => path.join(dir, "bestaat-niet.key");

  it("standaard 127.0.0.1 en poort 8766", () => {
    assert.deepEqual(exported("parseListenConfig")({}), { host: "127.0.0.1", port: 8766 });
  });

  it("main(): standaard alleen loopback, geen LAN-waarschuwing, en de sleutel in geen enkele logregel", async () => {
    const keyFile = path.join(dir, "helius-devnet.key");
    fs.writeFileSync(keyFile, fakeKey + "\n");
    fs.chmodSync(keyFile, 0o600);
    const port = await freePort();
    const { address, all } = await runMain({ SPANKWALLET_HELIUS_KEY_FILE: keyFile, ADMIN_HTTPS_PORT: String(port) });
    assert.equal(address.address, "127.0.0.1");
    assert.equal(address.port, port);
    assert.include(all, "Lokale Helius-sleutel geladen");
    assert.include(all, `draait op https://127.0.0.1:${port}`);
    assert.notInclude(all, "hele netwerk");
    assert.notInclude(all, fakeKey);
    assert.notMatch(withoutDir(all, dir), UUID);
  });

  it("main(): ADMIN_HTTPS_HOST=127.0.0.2 wordt gebruikt (loopback, geen waarschuwing)", async () => {
    const port = await freePort();
    const { address, all } = await runMain({ SPANKWALLET_HELIUS_KEY_FILE: missingKey(), ADMIN_HTTPS_HOST: "127.0.0.2", ADMIN_HTTPS_PORT: String(port) });
    assert.equal(address.address, "127.0.0.2");
    assert.notInclude(all, "hele netwerk");
  });

  it("main(): ADMIN_HTTPS_HOST=0.0.0.0 wordt gebruikt, met precies één waarschuwing dat /config.js de sleutel aan het hele netwerk geeft", async () => {
    const port = await freePort();
    const { address, all } = await runMain({ SPANKWALLET_HELIUS_KEY_FILE: missingKey(), ADMIN_HTTPS_HOST: "0.0.0.0", ADMIN_HTTPS_PORT: String(port) });
    assert.equal(address.address, "0.0.0.0");
    assert.equal(all.split("hele netwerk").length - 1, 1, all);
  });

  for (const host of ["", "localhost", "bogus", "999.1.1.1", "127.0.0.1 ", "0.0.0.0;rm"]) {
    it(`ongeldige ADMIN_HTTPS_HOST ${JSON.stringify(host)}: parseListenConfig weigert`, () => {
      assert.throws(() => exported("parseListenConfig")({ ADMIN_HTTPS_HOST: host }), /ADMIN_HTTPS_HOST/);
    });
  }

  for (const port of ["", "0x2000", "abc", "70000", "8766.5", "0", "-1", " 8766"]) {
    it(`ongeldige ADMIN_HTTPS_PORT ${JSON.stringify(port)}: parseListenConfig weigert`, () => {
      assert.throws(() => exported("parseListenConfig")({ ADMIN_HTTPS_PORT: port }), /ADMIN_HTTPS_PORT/);
    });
  }

  it("geldige grenzen van de poort: 1 en 65535", () => {
    assert.equal(exported("parseListenConfig")({ ADMIN_HTTPS_PORT: "1" }).port, 1);
    assert.equal(exported("parseListenConfig")({ ADMIN_HTTPS_PORT: "65535" }).port, 65535);
  });

  it("het script stopt met een duidelijke fout bij een ongeldig adres (exit 2, niets geopend)", async () => {
    const port = await freePort();
    const res = runScript({ SPANKWALLET_HELIUS_KEY_FILE: missingKey(), ADMIN_HTTPS_HOST: "bogus", ADMIN_HTTPS_PORT: String(port) });
    assert.isNull(res.signal, res.out);
    assert.equal(res.status, 2, res.out);
    assert.match(res.out, /FOUT: ADMIN_HTTPS_HOST/);
    assert.notInclude(res.out, "draait op");
  });

  it("het script stopt met een duidelijke fout bij een ongeldige poort (exit 2, niets geopend)", () => {
    const res = runScript({ SPANKWALLET_HELIUS_KEY_FILE: missingKey(), ADMIN_HTTPS_PORT: "abc" });
    assert.isNull(res.signal, res.out);
    assert.equal(res.status, 2, res.out);
    assert.match(res.out, /FOUT: ADMIN_HTTPS_PORT/);
    assert.notInclude(res.out, "draait op");
  });
});

function withoutDir(text: string, dir: string) {
  return text.split(dir).join("<map>");
}

describe("admin/wallet-signer.html is bevroren (STATUS.md sectie 173/179/180)", () => {
  // De gereviewde pagina van §179. Een bewuste wijziging aan de pagina past
  // deze hash expliciet aan, met een eigen STATUS-sectie en review.
  it("sha256 is die van §179", () => {
    const page = fs.readFileSync(path.join(ROOT, "admin", "wallet-signer.html"));
    assert.equal(crypto.createHash("sha256").update(page).digest("hex"), "2dcfb299fba176fc3da0fd096ca5525094ced6aa86055f0b61789c242e646557");
  });
});
