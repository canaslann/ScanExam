"""Create a separate metadata-only GLM test copy; preserve and verify all weights."""
import hashlib
import json
import sys
from pathlib import Path

import gguf
from gguf.scripts.gguf_new_metadata import MetadataDetails, copy_with_new_metadata

source, destination, provenance = map(Path, sys.argv[1:4])
if destination.exists():
    raise RuntimeError("Output exists; original and prior test copy were not overwritten")
reader = gguf.GGUFReader(source, "r")
token_key = "tokenizer.ggml.eot_token_id"
if reader.get_field(token_key) is not None:
    raise RuntimeError("Source already has an EOT token; no patch is needed")
tokens = reader.get_field("tokenizer.ggml.tokens").contents()
matches = [i for i, token in enumerate(tokens) if token == "<|user|>"]
if len(matches) != 1:
    raise RuntimeError("Cannot identify exactly one <|user|> token")
token_id = matches[0]
arch = reader.get_field("general.architecture").contents()
writer = gguf.GGUFWriter(destination, arch=arch, endianess=reader.endianess)
alignment = reader.get_field("general.alignment")
if alignment is not None:
    writer.data_alignment = alignment.contents()
copy_with_new_metadata(reader, writer, {
    token_key: MetadataDetails(gguf.GGUFValueType.UINT32, token_id, "GLM-OCR generation terminator")
}, [])
patched = gguf.GGUFReader(destination, "r")
if patched.get_field(token_key).contents() != token_id:
    raise RuntimeError("EOT verification failed")
old = {tensor.name: tensor for tensor in reader.tensors}
new = {tensor.name: tensor for tensor in patched.tensors}
if old.keys() != new.keys():
    raise RuntimeError("Tensor names changed")
for name, tensor in old.items():
    other = new[name]
    if tensor.tensor_type != other.tensor_type or tensor.n_bytes != other.n_bytes:
        raise RuntimeError(f"Tensor type/size changed: {name}")
    if hashlib.sha256(memoryview(tensor.data).cast("B")).digest() != hashlib.sha256(memoryview(other.data).cast("B")).digest():
        raise RuntimeError(f"Tensor data changed: {name}")
data = {"source": str(source), "patched": str(destination), "changedKey": token_key,
        "token": "<|user|>", "tokenId": token_id, "verifiedIdenticalTensors": len(old),
        "ggufTool": "gguf 0.19.0 / gguf_new_metadata", "reason": "https://github.com/ollama/ollama/pull/17195"}
provenance.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
print(json.dumps(data))
