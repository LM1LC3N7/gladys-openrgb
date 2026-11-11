# gladys-openrgb

[Gladys Assistant](https://gladysassistant.com) integration for the **RGB
lighting of a computer through [OpenRGB](https://openrgb.org)**, over the
local network to the OpenRGB SDK server: each controller (motherboard, RAM,
GPU, fans, strips, keyboard, mouse…) becomes a light with on / off, color and
its effect mode; the profiles saved in OpenRGB can be loaded.

- Off goes first, without any option, before the configuration is read, cuts
  a stalled read, cancels the commands still waiting; kept in `/data` and sent
  again (3 times at most) until a read shows it.
- Effect modes and profiles are written only when their option is ticked
  (both off by default); the integration never sends a save request.
- A device drives only its own controller: identity read before every write.
- The SDK server has no password: keep it on a trusted network.

Never tested with a real device. Not affiliated with OpenRGB.

User guide: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
node scripts/cover.mjs cover.png   # the store cover
```

See `CLAUDE.md` (architecture, rules) and `TODO.md` (status, decisions).
Licensed under the Apache License 2.0; the protocol layout source is credited
in `THIRD_PARTY_NOTICES.md`.
