# Third-party notices

The shared core and router use Node.js built-in modules, including `node:sqlite`, crypto, filesystem and child-process APIs. The Hermes bridge/reminder modules use Python's standard library and the host-provided Hermes plugin API. No third-party runtime package is vendored.

The original OMO campaign source is MIT-licensed, copyright (c) 2026 Izzu Prawiranegara. Its notice is preserved in [LICENSE](LICENSE). See [source provenance](docs/provenance.md).

The campaign profiles name skills from two separately maintained projects. This package does not redistribute their source; users install them from upstream as described in [dependencies](docs/dependencies.md).

- [Superpowers](https://github.com/obra/superpowers), copyright (c) 2025 Jesse Vincent, MIT License.
- [Co-Researcher](https://github.com/poemswe/co-researcher), copyright (c) 2025-2026 poemswe, MIT License.
 Hermes and Codex are separate host applications with their own terms and licenses.
