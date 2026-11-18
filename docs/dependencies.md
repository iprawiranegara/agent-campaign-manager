# Dependencies

Campaign Manager's research and engineering profiles rely on two skill libraries maintained by other people. This repository doesn't contain their code. Install them from their own repositories, in each client that runs those campaigns. [`dependencies.json`](../dependencies.json) holds the same information in machine-readable form.

| Project | Maintainer | License | Tested release | Needed by profiles |
| --- | --- | --- | --- | --- |
| [Superpowers](https://github.com/obra/superpowers) | Jesse Vincent | MIT | `v7.0.2` (`22f0b463`) | `engineering`, `research_delivery` |
| [Co-Researcher](https://github.com/poemswe/co-researcher) | poemswe | MIT | `v2.6.1` (`aa4997de`) | `research`, `research_delivery` |

`research_delivery` is the default profile, so a default campaign expects both. `status_only` campaigns need neither.

Campaign Manager doesn't check that they're installed. `campaign_preflight` lists the skills a campaign's profile expects; the agent has to load them. If a library is missing, choose a profile that doesn't need it.

## Hermes

Superpowers installs as a Hermes plugin from its repository:

```sh
hermes plugins install obra/superpowers --ref 22f0b463e7a5e579904dd6211a520321035526f7 --enable
```

Hermes scans plugins from community sources before installing them. With the default `plugins.scan_on_install` setting, the scan blocks Superpowers. Read the findings it prints. If you accept them, run the same command again with `--force`. Add `--yes-deps` when installing without an interactive prompt, because the plugin asks before installing its Node packages.

Co-Researcher's Hermes route is a clone of the tagged release, registered as an external skill directory:

```sh
git clone --branch v2.6.1 https://github.com/poemswe/co-researcher.git "$HOME/.local/share/co-researcher"
```

Then add its `skills` folder to the profile's `config.yaml`, keeping any entries already there:

```yaml
skills:
  external_dirs:
    - /absolute/path/to/co-researcher/skills
```

Hermes loads all 15 Co-Researcher skills from that folder. It doesn't scan external directories, so review the clone before adding it. Update with `git fetch --tags` and a checkout of the newer tag. Installing the skills one at a time with `hermes skills install poemswe/co-researcher/skills/<name>` works for 14 of them. The scanner rates `literature-review` as dangerous because it runs bundled scripts through `uv`, and `--force` doesn't override that verdict for community sources.

On native Windows, clone into a folder under `%LOCALAPPDATA%` and use that absolute path in `external_dirs`.

## Codex

- Superpowers: in Codex, open `/plugins`, search for `superpowers` and select Install Plugin. The [upstream README](https://github.com/obra/superpowers#codex-cli) also covers the Codex app.
- Co-Researcher: follow [`.codex/INSTALL.md`](https://github.com/poemswe/co-researcher/blob/v2.6.1/.codex/INSTALL.md) in the upstream repository. It clones to `~/.codex/co-researcher`, adds a hook section to `~/.codex/AGENTS.md` and runs a bootstrap command.

Both Codex procedures come from the upstream projects and weren't re-tested for this release.

## Other clients

Both projects document installation for further clients, including Claude Code. See their READMEs. Campaign Manager's own adapters cover Codex and Hermes only.
