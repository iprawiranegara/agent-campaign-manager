# Source provenance

Campaign Manager is maintained by Izzu Prawiranegara. The MIT license and copyright notice from the author's original OMO research campaign source are retained in the repository root.

The shared campaign schema/core and initial Codex adapter derive from that source, with baseline revision `64c0c3c1961ec5b2c16120fc1dfdf4190cfd37c3`. Later local work added stricter evidence/reconciliation, actionable error outcomes, native-thread isolation and bounded Codex reminders. The Hermes adapter adds conversation routing and request projection around the shared server.

This publication copy combines the maintained Codex 0.1.1 and Hermes 0.1.0 source packages. Preparation removes machine-specific paths, generates installation descriptors, makes fixture containment explicit and adds setup tests. It does not include private campaign databases, channel keys, host configuration, session logs or dashboard evidence.

[Co-Researcher](https://github.com/poemswe/co-researcher) (poemswe) and [Superpowers](https://github.com/obra/superpowers) (Jesse Vincent) are referenced by skill names as separately installed method/execution layers. Their source is not copied or redistributed here; see [dependencies](dependencies.md). Hermes and Codex are external host applications and are not included. Their APIs are documented through links in the installation guides.

The 0.2.0 preparation adds the author's read-only dashboard, configurable project grouping, a portable npm command and shell/PowerShell installation entry points. It ports the Hermes adapter's private channel handling to native Windows and corrects shared-core native path containment.

Schema lineage does not certify interoperability with an arbitrary OpenCode/OMO version. The optional test can be run against a separately supplied adapter. See [compatibility](compatibility.md) for the tested boundaries.
