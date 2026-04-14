import crypto from "node:crypto";

import type { EncryptedHandshakeMessage, HandshakePayload, IdentityData } from "./types.js";

function toBase64(value: Buffer | ArrayBuffer): string {
  return Buffer.from(value instanceof Buffer ? value : new Uint8Array(value)).toString("base64");
}

function fromBase64(value: string): Buffer {
  return Buffer.from(value, "base64");
}

function exportPublicPem(key: crypto.KeyObject): string {
  return key.export({ format: "pem", type: "spki" }).toString();
}

function hkdf(secret: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", secret, salt, Buffer.from(info, "utf-8"), 32));
}

const HANDSHAKE_INFO = "claw-crony:handshake:v1";

export function encryptHandshake(
  payload: HandshakePayload,
  recipientPublicKeyPem: string,
): string {
  const recipientPublicKey = crypto.createPublicKey(recipientPublicKeyPem);
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const sharedSecret = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipientPublicKey,
  });
  const iv = crypto.randomBytes(12);
  const key = hkdf(sharedSecret, iv, HANDSHAKE_INFO);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf-8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const encrypted: EncryptedHandshakeMessage = {
    version: 1,
    algorithm: "x25519-aes-256-gcm",
    senderPublicKey: exportPublicPem(ephemeral.publicKey),
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
    authTag: toBase64(authTag),
  };

  return JSON.stringify(encrypted);
}

export function decryptHandshake(ciphertext: string, identity: IdentityData): HandshakePayload {
  const envelope = JSON.parse(ciphertext) as EncryptedHandshakeMessage;
  if (envelope.algorithm !== "x25519-aes-256-gcm") {
    throw new Error(`Unsupported handshake algorithm: ${envelope.algorithm}`);
  }

  const privateKey = crypto.createPrivateKey(identity.privateKey);
  const senderPublicKey = crypto.createPublicKey(envelope.senderPublicKey);
  const iv = fromBase64(envelope.iv);
  const sharedSecret = crypto.diffieHellman({
    privateKey,
    publicKey: senderPublicKey,
  });
  const key = hkdf(sharedSecret, iv, HANDSHAKE_INFO);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(fromBase64(envelope.authTag));
  const plaintext = Buffer.concat([
    decipher.update(fromBase64(envelope.ciphertext)),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString("utf-8")) as HandshakePayload;
}
