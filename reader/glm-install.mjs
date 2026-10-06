import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { open, mkdir, rename, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

const SOURCE_SHA = "24ca1840804a2aa3faeb2cadf31f628ec8bd48393cf1938c414f0e6cda81914a";
async function digest(path, start = 0) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { start })) hash.update(chunk);
  return hash.digest("hex");
}
/** Stream a metadata-only copy. Model tensor bytes and relative offsets never change. */
export async function patchGlmEot(source, destination) {
  if (existsSync(destination)) throw new Error("EOT hedefi mevcut; üzerine yazılmadı.");
  const input = await open(source, "r"), prefix = Buffer.alloc(32 * 1024 * 1024);
  let head;
  try { const result = await input.read(prefix, 0, prefix.length, 0); head = prefix.subarray(0, result.bytesRead); }
  finally { await input.close(); }
  if (head.toString("ascii", 0, 4) !== "GGUF" || head.readUInt32LE(4) !== 3) throw new Error("GGUF v3 kaynak gerekli.");
  const tensors = Number(head.readBigUInt64LE(8)), entries = Number(head.readBigUInt64LE(16));
  if (!Number.isSafeInteger(tensors) || tensors < 1 || tensors > 10000 || !Number.isSafeInteger(entries) || entries > 100000) throw new Error("GGUF başlığı geçersiz.");
  let pos = 24, alignment = 32, tokenId = -1, eotExists = false;
  const ensure = n => { if (n < 0 || pos + n > head.length) throw new Error("GGUF metadata sınırı aşıldı."); };
  const u32 = () => { ensure(4); const value = head.readUInt32LE(pos); pos += 4; return value; };
  const u64 = () => { ensure(8); const value = Number(head.readBigUInt64LE(pos)); pos += 8; if (!Number.isSafeInteger(value)) throw new Error("GGUF uzunluğu geçersiz."); return value; };
  const string = () => { const size = u64(); ensure(size); const value = head.toString("utf8", pos, pos + size); pos += size; return value; };
  const value = (type, key = "") => {
    if (type === 8) return string();
    if (type === 9) {
      const itemType = u32(), count = u64();
      if (count > 1_000_000) throw new Error("GGUF dizi sınırı aşıldı.");
      for (let i = 0; i < count; i++) {
        const item = value(itemType);
        if (key === "tokenizer.ggml.tokens" && item === "<|user|>") {
          if (tokenId !== -1) throw new Error("Birden fazla EOT adayı bulundu."); tokenId = i;
        }
      }
      return undefined;
    }
    const size = ({ 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 })[type];
    if (!size) throw new Error("GGUF metadata türü desteklenmiyor.");
    ensure(size); const number = type === 4 ? head.readUInt32LE(pos) : undefined; pos += size; return number;
  };
  for (let i = 0; i < entries; i++) {
    const key = string(), type = u32();
    const item = value(type, key);
    if (key === "general.alignment") alignment = item;
    if (key === "tokenizer.ggml.eot_token_id") eotExists = true;
  }
  if (eotExists || tokenId < 0 || !Number.isInteger(alignment) || alignment < 1 || alignment > 4096) throw new Error("EOT kopyası için metadata koşulları sağlanmadı.");
  const metadataEnd = pos;
  for (let i = 0; i < tensors; i++) {
    string(); const dimensions = u32(); if (dimensions > 8) throw new Error("Tensor boyutu geçersiz.");
    for (let j = 0; j < dimensions; j++) u64(); u32(); u64();
  }
  const dataStart = Math.ceil(pos / alignment) * alignment;
  const key = Buffer.from("tokenizer.ggml.eot_token_id");
  const addition = Buffer.alloc(8 + key.length + 4 + 4);
  addition.writeBigUInt64LE(BigInt(key.length)); key.copy(addition, 8);
  addition.writeUInt32LE(4, 8 + key.length); addition.writeUInt32LE(tokenId, 12 + key.length);
  const header = Buffer.from(head.subarray(0, 24)); header.writeBigUInt64LE(BigInt(entries + 1), 16);
  const newDataStart = Math.ceil((pos + addition.length) / alignment) * alignment;
  const before = Buffer.concat([header, head.subarray(24, metadataEnd), addition, head.subarray(metadataEnd, pos), Buffer.alloc(newDataStart - pos - addition.length)]);
  const temporary = `${destination}.${randomUUID()}.partial`;
  try {
    const output = createWriteStream(temporary, { flags: "wx" });
    await new Promise((resolve, reject) => { output.once("error", reject); output.write(before, error => error ? reject(error) : resolve()); });
    await pipeline(createReadStream(source, { start: dataStart }), output);
    const originalDataSha256 = await digest(source, dataStart), patchedDataSha256 = await digest(temporary, newDataStart);
    if (originalDataSha256 !== patchedDataSha256) throw new Error("Tensor veri doğrulaması başarısız.");
    await rename(temporary, destination);
    return { tokenId, tensorCount: tensors, originalDataSha256, patchedDataSha256, sourceSha256: await digest(source), patchedSha256: await digest(destination) };
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

export async function installGlmEot({ projectRoot, readerUrl, pullSource }) {
  const tags = await (await fetch(`${readerUrl}/api/tags`)).json();
  if (tags.models?.some(model => model.name === "glm-ocr-eot:q8_0")) {
    const result = await (await fetch(`${readerUrl}/api/show`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "glm-ocr-eot:q8_0" }) })).json();
    if (result.details?.quantization_level !== "Q8_0" || result.model_info?.["tokenizer.ggml.eot_token_id"] !== 59253)
      throw new Error("Mevcut GLM alias'ı istenen Q8/EOT paketi değil; üzerine yazılmadı.");
    console.log("GLM-OCR Q8/EOT kurulu ve doğrulandı; indirme yapılmadı."); return;
  }
  const modelRoot = join(projectRoot, "work", "reader", "models"), source = join(modelRoot, "blobs", `sha256-${SOURCE_SHA}`);
  if (!existsSync(source)) await pullSource();
  if (await digest(source) !== SOURCE_SHA) throw new Error("Resmî GLM kaynak SHA-256 değeri eşleşmedi; kurulum durduruldu.");
  const directory = join(projectRoot, "work", "reader", "glm-eot"); await mkdir(directory, { recursive: true });
  const destination = join(directory, "glm-ocr-eot-q8.gguf");
  const provenance = join(directory, "provenance.json");
  const metadata = existsSync(destination)
    ? JSON.parse(await readFile(provenance, "utf8")) : await patchGlmEot(source, destination);
  if (metadata.tokenId !== 59253 || metadata.tensorCount !== 527) throw new Error("GLM EOT metadata doğrulaması başarısız.");
  if (metadata.sourceSha256 !== SOURCE_SHA || metadata.patchedSha256 !== await digest(destination)) throw new Error("Yerel EOT kopyasının SHA-256 doğrulaması başarısız.");
  await writeFile(provenance, JSON.stringify(metadata, null, 2));
  const modelfile = join(directory, "Modelfile");
  await writeFile(modelfile, `FROM "${destination.replaceAll("\\", "/")}"\nTEMPLATE {{ .Prompt }}\nRENDERER glm-ocr\nPARSER glm-ocr\nPARAMETER temperature 0\n`);
  await new Promise((resolve, reject) => {
    const child = spawn(join(projectRoot, "work", "reader", "v0.35.0", "ollama.exe"), ["create", "glm-ocr-eot:q8_0", "-f", modelfile], {
      cwd: projectRoot, windowsHide: true, stdio: "inherit", env: { ...process.env, OLLAMA_HOST: new URL(readerUrl).host, OLLAMA_MODELS: modelRoot, OLLAMA_NO_CLOUD: "true" },
    });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error("Yerel GLM alias'ı oluşturulamadı; doğrulanan EOT kopyası korunuyor.")));
  });
  console.log("GLM-OCR Q8/EOT hazır; özgün model ağırlıkları değişmedi.");
}
