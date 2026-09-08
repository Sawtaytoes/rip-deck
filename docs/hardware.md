# Drive and tower hardware

## Stable identity

Do not treat `/dev/srN` as drive identity. Linux can assign different device numbers whenever the USB tower disconnects or re-enumerates.

Rip Deck uses the drive firmware serial as canonical identity. The USB port path is a fast runtime hint, and the bridge serial is only a tiebreaker. See the [drive identity decision](decisions/2026-08-30-drive-identity-uses-firmware-serial-and-repairs-runtime-hints.md).

## USB topology

A long active USB extension connected to a multi-port hub can appear in sysfs as a three-tier hub cascade. The layers can be internal hub chips, not several physical hubs.

Keep the active extension's auxiliary power connected. An undervolted repeater can disconnect the complete drive bank.

Bulk tray operations move one motor at a time. Simultaneous motor load on a shared powered hub has disconnected the complete bus during active rips.

### The bank can drop and recover by itself, with no rip running

The complete drive bank can disconnect and re-enumerate about 20 seconds later
with nothing reading a disc. Measured 2026-09-07 at 22:45:24, tower idle, no
`makemkvcon` running.

Do not read a bank drop as a load symptom. The measured record of that evening:

| Powered from | To | Duration | Ended by |
| --- | --- | --- | --- |
| 20:37:03 | 21:11:20 | 34 m | ESPHome node reset opened the power relay |
| 22:30:16 | 22:45:24 | 15 m | Unexplained bank drop, recovered at 22:45:44 |
| 22:45:44 | 01:26:16+ | 2 h 40 m and counting | still up |

Four concurrent rips ran during the first window and none during the other two.
The unexplained drop happened in the window with no rips. The 650 W PSU has ample
5 V capacity, so drive load is not the mechanism.

**No over-current is ever logged.** Zero `over-current` lines appear in a 30 hour
kernel buffer that contains both bank drops. Do not wait for that signature
before believing a power fault, and do not treat its absence as proof the supply
is healthy.

Read the history with:

```bash
dmesg -T | grep -E 'usb (1|2)-2\.3: (USB disconnect|new)'
```

Both controllers appear because one physical USB 3 hub enumerates twice, as
`1-2.3` at high speed and `2-2.3` at SuperSpeed. A genuine bank drop takes both.

### Two 5 V sources feed the hub, and the NAS feed cannot simply be removed

The active USB extension is powered from the NAS USB 3 port **and** from the
chassis PSU through a 24-pin adapter. The owner's hypothesis for the unexplained
drop is that the two rails interact: the previous extension needed external power
only, and this one also draws from the NAS.

**The NAS feed is load-bearing, not an accident.** The Onno 24-pin PSU adapter
appears to have no standby power on its USB port, so the backfeed from the NAS is
what keeps the M5Stack Atom Lite alive while the PSU is off. Cut it and the
controller dies whenever the tower is off, which leaves nothing able to turn the
tower on. Any change to this power path has to keep the controller powered in the
tower's off state.

This is recorded as an open hypothesis. It is not confirmed, and 2 h 40 m of idle
stability followed the one drop.

## Kernel counters

`/sys/block/<drive>/device/ioerr_cnt` uses hexadecimal text even though neighboring counters use decimal. Parse it as hexadecimal or the error count can appear unchanged.

## MakeMKV drive enumeration

MakeMKV pads its drive list to 16 positions. Unused positions can contain empty strings and `visible === 256`; they are not physical drives.

Some third-party drive firmware changes the reported model string. The firmware serial remains the identity and the registry keeps separate true and reported model fields.

## AccurateRip offsets

CD read offset is a measured property of one physical drive. Measure it with cyanrip and store `readOffsetSamples` on that drive's firmware-serial entry.

Do not copy an offset from a model lookup. A drive can report a different model after a firmware change. A missing offset is supported and runs cyanrip without the offset flag.
