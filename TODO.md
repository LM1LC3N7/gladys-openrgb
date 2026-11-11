# TODO - OpenRGB v1

## Status

Milestone 1: the controllers of an OpenRGB SDK server as lights (on / off,
color, effect mode), the profiles of OpenRGB, the connection test, Off kept in
`/data` and sent again. Tested against a fake SDK server (in memory on a
virtual clock, and on real TCP with the real clock sped up); never against a
real OpenRGB (no package for Debian 13 on the VM, no RGB hardware).

## To check on a real OpenRGB

- That `SET_CUSTOM_MODE` lands in a mode whose color mode is per-LED on the
  common devices (else color and Off end as "sent, without confirmation").
- The protocol versions served by OpenRGB 0.9 (4) and 1.0 (5): the controller
  data size field counts itself, the profile list layout, `LOAD_PROFILE`.
- A server that answers no `REQUEST_PROTOCOL_VERSION` (protocol 0): the 1.5 s
  wait at every connection.
- The profile list of OpenRGB 1.0 (profile changes in that release).

## Later

- Brightness (scaling the color, or the mode brightness when the mode has
  one), zones, per-LED effects, effect speed.
- A scene action "load a profile" in addition to the select.
- `keywords` and `countries` in the manifest (need `gladys_version >= 5.3.0`).

## Decisions

- **Version 0.1.0, set by hand once** in `package.json`, `package-lock.json`,
  the manifest `version` and the `docker_image` tag; every later version comes
  from Actions > Release.
- **SDK 0.16.0** (the latest on npm on 2026-11-11, `^0.16.0`).
- **Own client, no dependency**: openrgb-sdk 0.6.1 (MIT, last pushed
  2026-05-13; 0.6.0 on npm) has no bound on packet size, no timeout on its
  answers and resolves answers by id only; its packet layouts were written
  again here with bounds, credited in `THIRD_PARTY_NOTICES.md` (copied into the
  image with `LICENSE`). OpenRGB itself is GPL-2.0: only its network protocol
  is spoken, none of its code read nor copied.
- **Writes**: on / color = `SET_CUSTOM_MODE` then `UPDATE_LEDS` (every LED);
  Off = the same with black; mode = `UPDATE_MODE` with the values of the mode
  as just read; profile = `LOAD_PROFILE` of a listed name. Never `SAVE_MODE`,
  `SAVE_PROFILE`, `DELETE_PROFILE`, `RESIZE_ZONE`, segments, rescan. Modes and
  profiles behind `allow_modes` / `allow_profiles` (off by default, checked
  again just before the bytes leave): the SDK server has no authentication,
  the integration writes only what the user turned on.
- **Off is the protective command** (lights only, nothing sensitive): no
  option, the address of `/data` before the configuration, priority over
  commands and reads, a read stalled for 1 s cut, queued commands of the same
  controller cancelled (and a command checks it was not overtaken just before
  each write), kept in `/data` and sent again by the next reads (3 times at
  most), ended by a newer command that left or a profile loaded.
- **Identity**: the first 12 hex of SHA-256(vendor, name, `s:`serial or
  `l:`location). The index of OpenRGB is never the id; it is read again before
  every write (else the whole list). Two controllers alike are both left out.
- **Features**: `light/binary`, `light/color`, `text/select` for the mode
  (value = the mode name, 60 characters at most) and for the profile on a
  server device (`ext:<selector>:server:openrgb`, one per integration). The
  profile select publishes no state: OpenRGB does not tell the active profile.
  No `switch`. No brightness in v1.
- **State**: per-LED mode: on when an LED is not black, color = the most
  frequent non-black color; a mode named Off: off; another mode: on, with its
  first mode color when it has one. Unknown otherwise (never 0).
- **Reads**: every `poll_interval` (10 s, 5 to 300) from the start of the
  previous read, never sooner after a restart (time of the attempt in `/data`
  before the read), a configuration saved unchanged, the button or Discovery;
  failures spaced (×2 up to 5 min, never under the interval). Changed states
  only, 250 per minute at most.
- **Bounds**: packet ≤ 1 MiB (header checked before the body), ≤ 64
  controllers, 128 modes, 64 zones, 4096 LEDs, strings ≤ 512 bytes; a body that
  does not end exactly where its size says is refused. Connection 1.5 s,
  answer 1.5 s, command budget 3 s.
- **Category** `lighting` only.
