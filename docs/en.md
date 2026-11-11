# OpenRGB

Brings into Gladys the RGB lighting of a computer driven by
[OpenRGB](https://openrgb.org) (motherboard, RAM, graphics card, fans, LED
strips, keyboard, mouse…), through the **SDK server** of OpenRGB on your
local network: no account, no cloud.

> Never tested with a real device: built from the protocol of the OpenRGB SDK
> server (as the openrgb-sdk library reads it). Tell us on the forum how it
> goes. Not affiliated with OpenRGB.

## What you get

One device per controller OpenRGB sees, with:

- **Light**: on / off. Off sets every LED to black in the direct mode; on
  brings back the last color seen on (white if none);
- **Color**: every LED of the controller to that color, in the direct mode;
- **Effect mode**: the active mode (Direct, Static, Rainbow…), shown; changing
  it needs the option **Allow the effect modes**.

And, when OpenRGB has saved profiles, an **OpenRGB profiles** device: choosing
a profile loads it (every device at once), only with the option **Allow
loading the profiles**. OpenRGB does not tell which profile is active: the
list shows no read value.

No feature is a switch. The lights obey "turn off the lights" like any other.

Not handled: brightness, colors per LED or per zone, speed and direction of
the effects, resizing zones. The integration never sends a save request (no
mode saved to a device, no profile created or deleted); some devices keep
their last mode on their own.

Left out (the status says so): a controller without a "per-LED color" mode (it
can be neither colored nor turned off this way), and two identical
controllers without a serial at the same location (never a write on the wrong
one).

## Setup

1. In OpenRGB, **SDK Server** tab, click **Start Server** (or run
   `openrgb --server`, with `--server-port` if needed). Tick the automatic
   start if OpenRGB starts with the computer.
2. Give that computer a fixed address in your router.
3. In **Address of the OpenRGB computer**, type its IP address (or name), with
   `:port` only if not 6742.
4. Save, then add the devices from the **Discover** tab.

The SDK server has no password: any device on your network can drive it. Keep
it on a trusted network, never open it to the Internet.

The status tells how many controllers were read, those left out, a server that
does not answer (and when it is tried again), a service that answers but not
as OpenRGB.

**Test the connection** reads the server, or shows the last read when it is
younger than an interval (never faster than the interval).

## Which controller a device drives

OpenRGB numbers its controllers, but the number changes when it detects them
again. A device is therefore tied to its controller by a fingerprint of the
vendor, the name and the serial (or, without a serial, of the location OpenRGB
shows: bus and address). Before every write, the controller is read at its
number; if it is not that one anymore, the whole list is read to find it; if
it is gone: "nothing sent".

A USB device without a serial plugged into another port may thus show up as a
new device in Discover.

## Turning off

Off needs no option. It goes before the other commands and before the reads
(a read stuck for 1 s is cut), and cancels the commands of that controller
still waiting: nothing asked before the Off leaves after it. It also works
before the configuration is read (the address kept in `/data` serves).

When the read that follows does not show the controller off, the Off is kept
(in `/data`) and sent again by the next reads, 3 times at most. A newer
command that left for that controller (on, color, mode) or a profile loaded
stops these resends.

An Off is refused only when the controller is no longer on the server (or is
there twice, without a serial). When
the server does not answer, it is kept and sent at the next reads (3 times at
most).

## Answers to a command

- "Done": the read that follows shows the value asked;
- "Sent, without confirmation": it left, but the read does not show it (yet);
- "Nothing sent": refused before anything left (option off, controller not
  found, value not valid, an Off came after it, server unreachable).

## Data kept

In `/data`: the address of the server, the time of the last read (a restart
never reads sooner than the interval), for each controller its number in
OpenRGB and its last color on, the Offs to send again. No name, no serial.
