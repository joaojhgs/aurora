# V857 K3 STT receiver identity correction

V857 is a private copy of the source-only K3 bundle V851. It resolves the
single issue from the independent V855 review: Faster-Whisper receives a model
directory, while the pinned model weight is the regular `model.bin` member
inside that directory. The proof now binds the exact canonical constructor
directory separately and verifies that the independently hashed weight,
configuration, tokenizer, and vocabulary files are canonical direct members
of that directory. It compares the observed constructor argument to the
directory, rather than to `model.bin`. The original model-file hashes and all
45 strict native warmup joins are retained; no route label is used as model
identity.

The runner's STT receiver schema now requires `constructor_directory`,
`tokenizer_sha256`, and `vocabulary_sha256` in addition to its pinned source,
model, and config identity fields. The corresponding receiver artifact must
include `actual_provider_files.model_directory` and canonical, individually
hashed `model.bin`, `config.json`, `tokenizer.json`, and `vocabulary.txt`
entries. The proof rejects missing files, symlinked/noncanonical file paths,
members outside the admitted directory, and a constructor argument that does
not exactly match the admitted directory.

Validation was source-only: Python `ast.parse` passed for all ten Python files.
No model import/invocation, test, service, network request, build, or device
operation was run. The bundle still requires Root's independent source,
endpoint, receiver, configuration, auth, and resource admission before any
future launch.

SHA-256 values:

| File | SHA-256 |
|---|---|
| `runner.py` | `6b534605a668a424f6ab1e9164e3ddada57eeadd989b95cd706208199efcfa40` |
| `receiver_proof.py` | `25ce34e728c55ecf62cca5db20cb1d0ef8bfa92676966e49ce8ce7aad0295c42` |
| `README.md` | `18ec2097647e3fc66be01ffc17907cfae05e7f2b4ad368bd30c0dba76896a75a` |
| `controller.py` | `ea542c7b4f2c1355d6f06000fe6424ad6099778e91466f82becc38af2e64a0fd` |
| `k3_composition.py` | `a62e5a036eb127657e1f81c503c08a272a7ef603c53c5e03991c17f4daa1a9e6` |
| `stage_adapter.py` | `204ea4d6b48571ab7ba0add0310a3dadd87b5e1e2afdc172634185755c9bb02c` |
| `bootstrap.py` | `6dddcd75348326ed65f6efaf05abdc40dcc503d512dd0a20b6335cbb277f5d50` |
| `candidate-manifest.json` | `ce75b965ee5879ebece6ea7dfe133441547d20ccf89ecd5d66ea510bd9645e60` |
