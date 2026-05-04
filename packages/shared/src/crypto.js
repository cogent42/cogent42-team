// Symmetric column encryption using libsodium secretbox (xsalsa20-poly1305).
// Key is the platform-wide MASTER_KEY (32 bytes, base64-encoded in env).
// Stored format: 24-byte nonce || ciphertext (single BYTEA column).

import nacl from "tweetnacl";
import { Buffer } from "node:buffer";

let _key;
function getKey() {
  if (_key) return _key;
  const raw = process.env.MASTER_KEY;
  if (!raw) throw new Error("MASTER_KEY not set");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== nacl.secretbox.keyLength) {
    throw new Error(`MASTER_KEY must decode to ${nacl.secretbox.keyLength} bytes (got ${buf.length})`);
  }
  _key = new Uint8Array(buf);
  return _key;
}

/** Encrypt a string. Returns a Buffer suitable for a BYTEA column. */
export function encryptString(plain) {
  if (plain == null) return null;
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(Buffer.from(String(plain), "utf8"), nonce, getKey());
  return Buffer.concat([Buffer.from(nonce), Buffer.from(ct)]);
}

/** Decrypt a Buffer/Uint8Array back to a string, or null if input is null. */
export function decryptString(buf) {
  if (buf == null) return null;
  const bytes = Uint8Array.from(buf);
  const nonce = bytes.slice(0, nacl.secretbox.nonceLength);
  const ct = bytes.slice(nacl.secretbox.nonceLength);
  const pt = nacl.secretbox.open(ct, nonce, getKey());
  if (!pt) throw new Error("decrypt failed (key mismatch or corrupt ciphertext)");
  return Buffer.from(pt).toString("utf8");
}
