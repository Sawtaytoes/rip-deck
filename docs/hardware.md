# Drive and tower hardware

## Stable identity

Do not treat `/dev/srN` as drive identity. Linux can assign different device numbers whenever the USB tower disconnects or re-enumerates.

Rip Deck uses the drive firmware serial as canonical identity. The USB port path is a fast runtime hint, and the bridge serial is only a tiebreaker. See the [drive identity decision](decisions/2026-08-30-drive-identity-uses-firmware-serial-and-repairs-runtime-hints.md).

## USB topology

A long active USB extension connected to a multi-port hub can appear in sysfs as a three-tier hub cascade. The layers can be internal hub chips, not several physical hubs.

Keep the active extension's auxiliary power connected. An undervolted repeater can disconnect the complete drive bank.

Bulk tray operations move one motor at a time. Simultaneous motor load on a shared powered hub has disconnected the complete bus during active rips.

## Kernel counters

`/sys/block/<drive>/device/ioerr_cnt` uses hexadecimal text even though neighboring counters use decimal. Parse it as hexadecimal or the error count can appear unchanged.

## MakeMKV drive enumeration

MakeMKV pads its drive list to 16 positions. Unused positions can contain empty strings and `visible === 256`; they are not physical drives.

Some third-party drive firmware changes the reported model string. The firmware serial remains the identity and the registry keeps separate true and reported model fields.

## AccurateRip offsets

CD read offset is a measured property of one physical drive. Measure it with cyanrip and store `readOffsetSamples` on that drive's firmware-serial entry.

Do not copy an offset from a model lookup. A drive can report a different model after a firmware change. A missing offset is supported and runs cyanrip without the offset flag.
