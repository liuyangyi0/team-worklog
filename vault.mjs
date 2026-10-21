import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const unavailable = (message) =>
  Object.assign(new Error(message), { status: 503 });
function parseKey(value) {
  if (Buffer.isBuffer(value) && value.length === 32) return Buffer.from(value);
  if (typeof value !== "string")
    throw unavailable(
      "账号库主密钥格式无效，需提供 32 字节 hex 或 base64 密钥",
    );
  const text = value.trim();
  if (/^[a-f0-9]{64}$/i.test(text)) return Buffer.from(text, "hex");
  if (/^[A-Za-z0-9+/]{43}=$/.test(text)) {
    const key = Buffer.from(text, "base64");
    if (key.length === 32 && key.toString("base64") === text) return key;
  }
  throw unavailable("账号库主密钥格式无效，需提供 32 字节 hex 或 base64 密钥");
}

/**
 * The key is separate from the database. Never regenerate it when ciphertext
 * already exists. Key rotation requires a coordinated re-encryption migration;
 * changing VAULT_MASTER_KEY alone is deliberately not treated as rotation.
 */
export function createVault({ db, dataDir, masterKey } = {}) {
  let key = null,
    problem = "";
  const keyPath = path.join(dataDir, ".keys", "vault-v1.key");
  const samples = [];
  for (const [table, parent, kind] of [
    ["credential_versions", "credential_id", "credential"],
    ["configuration_versions", "configuration_id", "configuration"],
  ]) {
    if (
      !db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table)
    )
      continue;
    const sample = db
      .prepare(
        `SELECT id,${parent} AS parent_id,secret_context,secret_payload FROM ${table} WHERE secret_payload<>'' LIMIT 1`,
      )
      .get();
    if (sample) samples.push({ ...sample, kind });
  }
  try {
    const supplied = masterKey ?? process.env.VAULT_MASTER_KEY;
    if (supplied !== undefined && supplied !== "") key = parseKey(supplied);
    else if (fs.existsSync(keyPath))
      key = parseKey(fs.readFileSync(keyPath).toString("utf8"));
    else if (samples.length)
      throw unavailable(
        "账号库密钥缺失；请恢复原 VAULT_MASTER_KEY 或独立备份的 .keys/vault-v1.key，系统不会重建密钥",
      );
    else {
      fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
      const generated = randomBytes(32);
      try {
        fs.writeFileSync(keyPath, generated.toString("hex") + "\n", {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      key = parseKey(fs.readFileSync(keyPath, "utf8"));
    }
    for (const sample of samples)
      decryptRaw(
        sample.secret_payload,
        `${sample.kind}:${sample.parent_id}:${sample.secret_context || sample.id}`,
      );
  } catch (error) {
    key = null;
    problem =
      error.status === 503
        ? error.message
        : "账号库密钥不可用或与现有密文不匹配，请检查独立密钥恢复设置";
  }
  function ready() {
    if (!key) throw unavailable(problem || "账号库密钥不可用");
  }
  function decryptRaw(payload, context) {
    const data = JSON.parse(payload);
    if (
      data.key_version !== "v1" ||
      !/^[a-f0-9]{24}$/.test(data.nonce) ||
      !/^[a-f0-9]{32}$/.test(data.tag)
    )
      throw unavailable("密文格式或密钥版本不受支持");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(data.nonce, "hex"),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(data.tag, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(data.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
  return {
    status: () => ({
      available: Boolean(key),
      key_version: "v1",
      message: problem,
    }),
    encrypt(value, context) {
      ready();
      const nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(context));
      const ciphertext = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return JSON.stringify({
        key_version: "v1",
        nonce: nonce.toString("hex"),
        tag: cipher.getAuthTag().toString("hex"),
        ciphertext: ciphertext.toString("base64"),
      });
    },
    decrypt(payload, context) {
      ready();
      try {
        return decryptRaw(payload, context);
      } catch {
        throw unavailable("无法解密此版本，请恢复对应账号库密钥；原密文已保留");
      }
    },
  };
}
