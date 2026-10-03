// Test-only: a REAL self-signed EC P-256 certificate and key carrying a SPIFFE
// URI SAN, via the system `openssl` (Node can parse certificates but cannot
// build one with custom extensions). The same helper stellar-core-ts's own
// suite uses; the key never leaves the test process.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TlsIdentity {
  readonly cert: string;
  readonly key: string;
}

/** `cn` must differ between identities that share a trust bundle: OpenSSL finds
 *  a self-signed anchor by subject name, so two with the same name shadow each other. */
export function makeIdentity(san: string, cn: string = san): TlsIdentity {
  const dir = mkdtempSync(join(tmpdir(), "calliope-tls-"));
  try {
    const keyPath = join(dir, "id.key");
    const certPath = join(dir, "id.crt");
    const cnfPath = join(dir, "ext.cnf");
    execFileSync("openssl", [
      "ecparam",
      "-name",
      "prime256v1",
      "-genkey",
      "-noout",
      "-out",
      keyPath,
    ]);
    writeFileSync(
      cnfPath,
      [
        "[req]",
        "distinguished_name = dn",
        "x509_extensions = ext",
        "prompt = no",
        "[dn]",
        `CN = ${cn}`,
        "[ext]",
        `subjectAltName = ${san}`,
        "basicConstraints = critical,CA:FALSE",
        "keyUsage = critical,digitalSignature",
        "",
      ].join("\n"),
    );
    execFileSync("openssl", [
      "req",
      "-x509",
      "-new",
      "-key",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-config",
      cnfPath,
    ]);
    return {
      cert: readFileSync(certPath, "utf8"),
      key: readFileSync(keyPath, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
